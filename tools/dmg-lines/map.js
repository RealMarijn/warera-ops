// WarEra Damage lines — MAIN-world engine + map renderer.
//
// Model: any number of overlay panels can each independently pick a battle to
// watch (a "panel" is one LIVE Damage tracker window — see overlay.js, which
// can spawn several). For EVERY distinct battle currently watched by at least
// one panel, this engine keeps a live Centrifugo subscription and continuously
// recomputes that battle's map arcs every tick — even while that battle isn't
// the "active" one — so that switching which panel is active only needs to
// swap SVG visibility, never wait on data. Only the currently active panel's
// battle is actually drawn on the map (showing every watched battle's lines
// at once would be unreadable); "active" = whichever panel the user last
// clicked, tracked via `activePanelId`.
//
// Runs in the MAIN world because it needs (a) the page's MapLibre Map instance,
// (b) same-origin tRPC calls with the game's auth cookies, and (c) to open its OWN
// Centrifugo WebSocket (so it can subscribe to battles the user picked in the
// overlay, even without those battle pages open). Data in:
//   hook.js  -> {kind:"lasthit", battleId, side, user, damages}   (game tap, per hit)
//   overlay  -> {kind:"config", enabled}
//   overlay  -> {kind:"registerPanel", panelId}      (a new tracker window was created)
//   overlay  -> {kind:"unregisterPanel", panelId}     (a tracker window was closed)
//   overlay  -> {kind:"selectBattle", panelId, battleId}  (pick/clear a battle for one panel)
//   overlay  -> {kind:"setActivePanel", panelId}      (which panel's lines to draw)
//   overlay  -> {kind:"requestBattleList"}            (populate the picker)
// Data out:
//   -> {kind:"summary", panelId, ..., header}   per-panel per-country totals
//   -> {kind:"battleList", battles}             active battles for the picker
//
// Pipeline: lasthit -> resolve user's country (cached) -> aggregate per country ->
// project country + region centroid -> draw/update arcs, per watched battle. The
// game tap (hook.js, fired by opening a battle page) is received but ignored on
// purpose — nothing is drawn until a battle is picked in some panel's picker.
(() => {
  "use strict";
  if (window.top !== window) return;
  try { document.documentElement.dataset.wdlEngine = "0.9.3"; } catch (_) {}
  console.log("[WDL] map.js engine v0.9.3 (multi-window) loaded");

  const CHANNEL = "warera-dmg-lines";
  const NS = "http://www.w3.org/2000/svg";
  const RATE_WINDOW_MS = 60_000;   // sliding window for "damage/min"
  const MAX_LINES = 14;            // cap arcs to avoid clutter, per battle
  const ATT = "#ff5a5a", DEF = "#5aa9ff";
  const WS_URL = "wss://ws.warera.io/connection/websocket"; // WarEra's Centrifugo endpoint

  let map = null;
  let regionPos = {};   // regionId  -> [lng,lat]
  let regionMeta = {};  // regionId  -> { name }
  let countryPos = {};  // countryId -> [lng,lat] (homeland centroid)
  let countryMeta = {}; // countryId -> { code, name }
  let ready = false;
  let enabled = true;

  // battleId -> { region, meta, header, countries: Map<countryId,{side,total,events:[{t,dmg}]}> }
  const battles = new Map();

  // panelId -> battleId|null. Every open overlay window (panel) independently picks a battle;
  // several panels may watch the same battle. Populated by registerPanel/selectBattle.
  const panelBattle = new Map();
  // Which panel's battle is currently drawn on the map. Whichever window the user clicked last.
  let activePanelId = null;

  const userCountry = new Map();     // userId -> countryId | null (null = resolving)
  const pendingByUser = new Map();   // userId -> [{battleId, side, dmg, t}]

  // ---- tRPC helpers (page context, auth cookies) ------------------------
  const trpcRaw = async (proc, input) => {
    const url = "https://api2.warera.io/trpc/" + proc +
      "?batch=1&input=" + encodeURIComponent(JSON.stringify({ 0: input }));
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) throw new Error(proc + " " + r.status);
    const j = await r.json();
    return j[0].result.data;
  };
  const trpcNull = async (proc) => {
    const input = { json: null, meta: { values: ["undefined"] } };
    const url = "https://api2.warera.io/trpc/" + proc +
      "?batch=1&input=" + encodeURIComponent(JSON.stringify({ 0: input }));
    const r = await fetch(url, { credentials: "include" });
    const j = await r.json();
    const d = j[0].result.data;
    return d.json || d;
  };
  // POST variant for tRPC mutations (the centrifugo.* token endpoints are mutations, so a GET
  // returns 405). Same non-superjson input shape as trpcRaw.
  const trpcMutate = async (proc, input) => {
    const r = await fetch("https://api2.warera.io/trpc/" + proc + "?batch=1", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ 0: input }),
    });
    if (!r.ok) throw new Error(proc + " " + r.status);
    const j = await r.json();
    return j[0].result.data;
  };

  // ---- find MapLibre Map via React fiber --------------------------------
  const isMap = (o) => {
    try {
      return o && typeof o.project === "function" && typeof o.getZoom === "function" &&
             typeof o.getCanvas === "function" && typeof o.getSource === "function";
    } catch (_) { return false; }
  };
  const findMap = () => {
    const cv = document.querySelector("canvas.maplibregl-canvas");
    const container = cv && cv.closest(".maplibregl-map");
    if (!container) return null;
    const fk = Object.keys(container).find((k) => k.startsWith("__reactFiber"));
    if (!fk) return null;
    let root = container[fk];
    while (root.return) root = root.return;
    const stack = [root];
    let guard = 0;
    while (stack.length && guard++ < 60000) {
      const n = stack.pop();
      if (!n) continue;
      let h = n.memoizedState, c = 0;
      while (h && typeof h === "object" && c < 60) {
        const m = h.memoizedState;
        if (m && isMap(m.current)) return m.current;
        if (isMap(m)) return m;
        h = h.next; c++;
      }
      if (n.child) stack.push(n.child);
      if (n.sibling) stack.push(n.sibling);
    }
    return null;
  };

  // ---- build position/metadata lookups ----------------------------------
  const buildLookups = async () => {
    const src = map.getSource("regions");
    const fc = src && (src._options ? src._options.data : src._data);
    const feats = (fc && fc.features) || [];
    if (!feats.length) return false;

    regionPos = {};
    const agg = {}; // initialCountryId -> {x,y,n}
    for (const f of feats) {
      const p = f.properties;
      if (!p || !p.position) continue;
      if (p.regionId) regionPos[p.regionId] = p.position;
      const cid = p.initialCountryId;
      if (!cid) continue;
      const a = (agg[cid] = agg[cid] || { x: 0, y: 0, n: 0 });
      a.x += p.position[0]; a.y += p.position[1]; a.n++;
    }
    countryPos = {};
    for (const cid in agg) countryPos[cid] = [agg[cid].x / agg[cid].n, agg[cid].y / agg[cid].n];

    countryMeta = {};
    const list = await trpcNull("country.getAllCountries");
    const arr = Array.isArray(list) ? list : Object.values(list);
    for (const c of arr) if (c && c._id) countryMeta[c._id] = { code: c.code, name: c.name };

    // Region names (for the overlay's battle header) — keyed regionId -> { name }.
    // Best-effort: a failure here just leaves headers without a region name.
    try {
      const regions = await trpcRaw("region.getRegionsObject", {});
      const robj = (regions && regions.json) || regions || {};
      regionMeta = {};
      for (const id in robj) if (robj[id] && robj[id].name) regionMeta[id] = { name: robj[id].name };
    } catch (_) { /* keep whatever we had */ }
    return true;
  };

  // ---- battle metadata (region + sides) ---------------------------------
  const countryLabel = (cid) => {
    const m = countryMeta[cid];
    return { name: (m && m.name) || "?", code: (m && m.code) || "" };
  };

  const ensureBattle = (battleId) => {
    let b = battles.get(battleId);
    if (!b) {
      b = { region: null, meta: false, header: null, countries: new Map() };
      battles.set(battleId, b);
    }
    if (!b.meta) {
      b.meta = true; // guard against duplicate fetches
      trpcRaw("battle.getById", { battleId })
        .then((d) => {
          b.region = d && d.defender && d.defender.region;
          // Header shown in the overlay: contested region + attacker vs defender country.
          b.header = {
            regionName: (b.region && regionMeta[b.region] && regionMeta[b.region].name) || null,
            attacker: countryLabel(d && d.attacker && d.attacker.country),
            defender: countryLabel(d && d.defender && d.defender.country),
          };
        })
        .catch(() => { b.meta = false; });
    }
    return b;
  };

  // ---- damage attribution ------------------------------------------------
  const addDamage = (battleId, countryId, side, dmg, t) => {
    const b = ensureBattle(battleId);
    let c = b.countries.get(countryId);
    if (!c) { c = { side, total: 0, events: [] }; b.countries.set(countryId, c); }
    c.total += dmg;
    c.events.push({ t, dmg });
  };

  const resolveUser = (userId) => {
    userCountry.set(userId, null); // mark resolving
    trpcRaw("user.getUserLite", { userId })
      .then((d) => {
        const cid = d && d.country;
        userCountry.set(userId, cid || undefined);
        const queued = pendingByUser.get(userId) || [];
        pendingByUser.delete(userId);
        if (cid) for (const q of queued) addDamage(q.battleId, cid, q.side, q.dmg, q.t);
      })
      .catch(() => { userCountry.delete(userId); pendingByUser.delete(userId); });
  };

  // Distinct battle ids at least one panel currently has selected.
  const watchedBattleIds = () => {
    const s = new Set();
    for (const battleId of panelBattle.values()) if (battleId) s.add(battleId);
    return s;
  };

  const onLastHit = (m, source) => {
    if (!m.user) return;
    // Manual-only: lines track ONLY battles picked in some panel's picker, fed by our own
    // Centrifugo subscription ("self"). Opening a battle page (the game tap) is ignored on purpose.
    if (source !== "self" || !watchedBattleIds().has(m.battleId)) return;

    ensureBattle(m.battleId);
    const t = Date.now();
    const cid = userCountry.get(m.user);
    if (cid) {
      addDamage(m.battleId, cid, m.side, m.damages, t);
    } else if (cid === null) {
      // resolving: queue
      const q = pendingByUser.get(m.user) || [];
      q.push({ battleId: m.battleId, side: m.side, dmg: m.damages, t });
      pendingByUser.set(m.user, q);
    } else if (cid === undefined && !userCountry.has(m.user)) {
      pendingByUser.set(m.user, [{ battleId: m.battleId, side: m.side, dmg: m.damages, t }]);
      resolveUser(m.user);
    }
  };

  // ---- rendering ----------------------------------------------------------
  // Each line is a tapered "ribbon" (a filled polygon that follows a quadratic
  // curve) rather than a plain stroke — a stroke can't vary its width. It has a
  // visible width at the SOURCE country and widens toward the region, filled with
  // a linear gradient that stays clearly visible at the source and brightens toward
  // the region, so the flow reads as "into" the contested region. A glowing origin
  // node (halo + core, sized by damage rate) marks exactly where each line starts.
  //
  // One sub-<g> pair (arcs + nodes) per WATCHED battle, so every watched battle's
  // arcs stay continuously up to date (position, rate) even while hidden — making
  // the switch to a newly-active panel instant (just a display:none/'' toggle,
  // never a recompute-from-scratch). All battles' node groups paint above ALL
  // battles' arc groups (two top-level containers), same layering as before.
  let svg, gAllArcs, gAllNodes, defsEl;
  const battleDraw = new Map(); // battleId -> { gArcs, gNodes, arcEls: Map<countryId,{...}> }

  const ensureSvg = () => {
    if (svg) return;
    svg = document.createElementNS(NS, "svg");
    svg.id = "wdl-map-lines";
    // Positioned to fill the MapLibre container (see append below): absolute + inset 0 overlays
    // the canvas exactly, and a low z-index keeps the lines just above the map but below the app's
    // UI (cards, menus) which live outside the map at higher z-indexes.
    Object.assign(svg.style, {
      position: "absolute", inset: "0", width: "100%", height: "100%",
      pointerEvents: "none", zIndex: "1",
    });
    defsEl = document.createElementNS(NS, "defs");
    svg.appendChild(defsEl);
    // Gentle breathing glow on live origin markers (see .wdl-live-halo toggle in updateBattleDraw()).
    const st = document.createElementNS(NS, "style");
    st.textContent =
      "@keyframes wdl-pulse{0%,100%{opacity:.5}50%{opacity:1}}" +
      "#wdl-map-lines .wdl-live-halo{animation:wdl-pulse 1.6s ease-in-out infinite}";
    svg.appendChild(st);
    gAllArcs = document.createElementNS(NS, "g");
    svg.appendChild(gAllArcs);
    gAllNodes = document.createElementNS(NS, "g"); // origin markers, painted above ALL ribbons
    svg.appendChild(gAllNodes);
    // Inject INTO the map container so the lines share the map's stacking context and fall behind
    // the app UI. Fall back to a fixed full-viewport overlay only if the container is unavailable.
    const container = (map && typeof map.getContainer === "function" && map.getContainer()) || document.body;
    if (container === document.body) { svg.style.position = "fixed"; svg.style.zIndex = "9998"; }
    container.appendChild(svg);
  };

  const ensureBattleDraw = (battleId) => {
    let bd = battleDraw.get(battleId);
    if (!bd) {
      const gArcs = document.createElementNS(NS, "g");
      gArcs.setAttribute("data-battle", battleId);
      gAllArcs.appendChild(gArcs);
      const gNodes = document.createElementNS(NS, "g");
      gNodes.setAttribute("data-battle", battleId);
      gAllNodes.appendChild(gNodes);
      bd = { gArcs, gNodes, arcEls: new Map() };
      battleDraw.set(battleId, bd);
    }
    return bd;
  };

  const teardownBattleDraw = (battleId) => {
    const bd = battleDraw.get(battleId);
    if (!bd) return;
    bd.gArcs.remove();
    bd.gNodes.remove();
    battleDraw.delete(battleId);
  };

  const rateOf = (events, now) => {
    let sum = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (now - events[i].t > RATE_WINDOW_MS) break;
      sum += events[i].dmg;
    }
    return sum; // window is 60s => already per-minute
  };

  // Build a tapered ribbon polygon following the quadratic A -> C -> B.
  // width(t): ~0 at the source (t=0), `wMax` at the region (t=1).
  const SAMPLES = 26;
  const ribbonPath = (A, B, wMax) => {
    const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
    const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len, off = Math.min(len * 0.18, 90);
    const Cx = mx + nx * off, Cy = my + ny * off; // control point
    let left = "", right = "";
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES, u = 1 - t;
      // point on the curve
      const px = u * u * A.x + 2 * u * t * Cx + t * t * B.x;
      const py = u * u * A.y + 2 * u * t * Cy + t * t * B.y;
      // tangent -> unit normal
      const tx = 2 * u * (Cx - A.x) + 2 * t * (B.x - Cx);
      const ty = 2 * u * (Cy - A.y) + 2 * t * (B.y - Cy);
      const tl = Math.hypot(tx, ty) || 1;
      const ux = -ty / tl, uy = tx / tl;
      const w = (2.4 + Math.pow(t, 1.4) * wMax) / 2; // half-width: visible at source, tapered wider toward region
      left += (i ? " L " : "M ") + (px + ux * w) + " " + (py + uy * w);
      right = " L " + (px - ux * w) + " " + (py - uy * w) + right;
    }
    return left + right + " Z";
  };

  // Recompute one battle's arcs/nodes for the current frame. Runs for EVERY watched battle every
  // tick, active or not — that's what makes switching the active panel instant (see file header).
  // Returns a snapshot used both to decide what's drawn and to build panel summaries.
  const updateBattleDraw = (battleId, now) => {
    const b = battles.get(battleId);
    const bd = ensureBattleDraw(battleId);
    const target = b && b.region && regionPos[b.region];
    if (!b || !target) {
      bd.gArcs.style.display = "none";
      bd.gNodes.style.display = "none";
      return { active: false, header: b ? b.header : null };
    }
    const tp = map.project(target);

    // rank contributing countries by current rate; also sum rates per side across
    // ALL contributing countries (not just the ones with a resolved map position)
    // so the attacker/defender totals aren't capped by MAX_LINES or missing positions.
    const rows = [];
    const totals = { attackerRate: 0, defenderRate: 0, attackerTotal: 0, defenderTotal: 0 };
    for (const [cid, c] of b.countries) {
      const rate = rateOf(c.events, now);
      if (c.side === "attacker") { totals.attackerRate += rate; totals.attackerTotal += c.total; }
      else { totals.defenderRate += rate; totals.defenderTotal += c.total; }
      const pos = countryPos[cid];
      if (!pos) continue;
      rows.push({ cid, side: c.side, total: c.total, rate, pos });
    }
    rows.sort((a, b2) => b2.rate - a.rate || b2.total - a.total);
    const shown = rows.slice(0, MAX_LINES);
    const maxRate = Math.max(1, ...shown.map((r) => r.rate));

    const live = new Set();
    for (const r of shown) {
      live.add(r.cid);
      let e = bd.arcEls.get(r.cid);
      if (!e) {
        const grad = document.createElementNS(NS, "linearGradient");
        grad.setAttribute("gradientUnits", "userSpaceOnUse");
        // Scoped by battleId too — the same country can appear in two different watched
        // battles at once, and gradient ids must be unique across the whole document.
        const gradId = "wdlg-" + battleId + "-" + r.cid;
        grad.id = gradId;
        const s0 = document.createElementNS(NS, "stop"); s0.setAttribute("offset", "0");
        const s1 = document.createElementNS(NS, "stop"); s1.setAttribute("offset", "1");
        grad.append(s0, s1);
        defsEl.appendChild(grad);
        const path = document.createElementNS(NS, "path");
        path.setAttribute("fill", `url(#${gradId})`);
        path.setAttribute("stroke", "none");
        bd.gArcs.appendChild(path);
        // Origin marker: a soft halo behind a solid, white-rimmed core dot.
        const halo = document.createElementNS(NS, "circle");
        halo.setAttribute("stroke", "none");
        const core = document.createElementNS(NS, "circle");
        core.setAttribute("stroke", "#fff");
        core.setAttribute("stroke-width", "1.25");
        bd.gNodes.append(halo, core);
        e = { path, grad, s0, s1, halo, core };
        bd.arcEls.set(r.cid, e);
      }
      const cp = map.project(r.pos);
      const color = r.side === "attacker" ? ATT : DEF;
      const wMax = 2 + (r.rate / maxRate) * 9;
      const live_ = r.rate > 0;
      e.path.setAttribute("d", ribbonPath(cp, tp, wMax));
      // gradient runs from source (clearly visible) to region (brightest), following the line
      e.grad.setAttribute("x1", cp.x); e.grad.setAttribute("y1", cp.y);
      e.grad.setAttribute("x2", tp.x); e.grad.setAttribute("y2", tp.y);
      e.s0.setAttribute("stop-color", color); e.s0.setAttribute("stop-opacity", live_ ? "0.38" : "0.14");
      e.s1.setAttribute("stop-color", color); e.s1.setAttribute("stop-opacity", live_ ? "0.98" : "0.28");

      // Origin node — clearly marks where this country's damage flows FROM. Sized by rate.
      const rCore = 3 + (r.rate / maxRate) * 4;
      e.core.setAttribute("cx", cp.x); e.core.setAttribute("cy", cp.y); e.core.setAttribute("r", rCore);
      e.core.setAttribute("fill", color); e.core.setAttribute("fill-opacity", live_ ? "1" : "0.5");
      e.core.setAttribute("stroke-opacity", live_ ? "0.9" : "0.4");
      e.halo.setAttribute("cx", cp.x); e.halo.setAttribute("cy", cp.y); e.halo.setAttribute("r", rCore * 2.5);
      e.halo.setAttribute("fill", color); e.halo.setAttribute("fill-opacity", live_ ? "0.22" : "0.08");
      e.halo.classList.toggle("wdl-live-halo", live_); // pulse only while actively dealing damage
    }
    // remove this battle's arcs no longer shown
    for (const [cid, e] of bd.arcEls) {
      if (!live.has(cid)) { e.path.remove(); e.grad.remove(); e.halo.remove(); e.core.remove(); bd.arcEls.delete(cid); }
    }

    return { active: true, header: b.header, totals, countries: shown };
  };

  const draw = (doPost) => {
    if (!ready || !svg) return;
    const watched = watchedBattleIds();

    // Drop draw state for battles no longer watched by any panel.
    for (const battleId of battleDraw.keys()) {
      if (!watched.has(battleId)) teardownBattleDraw(battleId);
    }

    const activeBattleId = activePanelId ? (panelBattle.get(activePanelId) || null) : null;
    const now = Date.now();
    const snapshots = new Map(); // battleId -> snapshot, reused for panel summaries below

    for (const battleId of watched) {
      const snap = enabled ? updateBattleDraw(battleId, now) : { active: false, header: (battles.get(battleId) || {}).header || null };
      snapshots.set(battleId, snap);
      const bd = battleDraw.get(battleId);
      if (bd) {
        const show = enabled && snap.active && battleId === activeBattleId;
        bd.gArcs.style.display = show ? "" : "none";
        bd.gNodes.style.display = show ? "" : "none";
      }
    }

    if (doPost) {
      for (const [panelId, battleId] of panelBattle) {
        if (!battleId) { postPanelSummary(panelId, { active: false, header: null }); continue; }
        postPanelSummary(panelId, snapshots.get(battleId) || { active: false, header: null });
      }
    }
  };

  const postPanelSummary = (panelId, snap) => {
    window.postMessage({
      __wdl: CHANNEL, kind: "summary", panelId,
      active: !!snap.active,
      header: snap.header || null,
      totals: snap.totals || null,
      countries: (snap.countries || []).map((r) => ({
        code: (countryMeta[r.cid] || {}).code || "",
        name: (countryMeta[r.cid] || {}).name || "?",
        side: r.side, total: r.total, rate: r.rate,
      })),
    }, location.origin);
  };

  // ---- our own Centrifugo connection (subscribe to any battle) ----------
  // Lets panels pick a battle to watch WITHOUT opening the battle page. We open a second,
  // independent Centrifugo socket (never touching the game's own client) and subscribe to
  // `battleLastHits:<id>` for every currently-watched battle; frames feed the same onLastHit
  // pipeline, tagged "self". Protocol is Centrifugo v2 JSON: connect{token} -> subscribe{channel,
  // token,flag} -> publications arrive as push.pub.data; empty-object `{}` frames are pings both
  // ways. Channels are private, so each subscribe needs a per-channel JWT from centrifugo.* endpoints.
  const wsc = {
    sock: null,
    connected: false,
    cmdId: 1,
    connecting: false,
    subs: new Set(),        // channels we intend to stay subscribed to
    tokenCache: new Map(),  // channel -> subscription JWT (server TTL ~1h)
    retry: 0,
  };

  const wsSend = (obj) => {
    try { if (wsc.sock && wsc.sock.readyState === 1) wsc.sock.send(JSON.stringify(obj)); }
    catch (_) { /* ignore */ }
  };

  const scheduleReconnect = () => {
    const delay = Math.min(15000, 1000 * Math.pow(2, wsc.retry++));
    setTimeout(() => { if (wsc.subs.size) wsConnect(); }, delay);
  };

  const wsConnect = async () => {
    if (wsc.connecting || (wsc.sock && wsc.sock.readyState <= 1)) return;
    wsc.connecting = true;
    let token = null;
    try {
      const jwt = await trpcMutate("centrifugo.getJWT", {});
      token = (jwt && (jwt.token || (jwt.json && jwt.json.token))) || null;
    } catch (_) { /* fall through */ }
    if (!token) { wsc.connecting = false; scheduleReconnect(); return; }

    const s = new WebSocket(WS_URL);
    wsc.sock = s;
    s.onopen = () => { wsc.cmdId = 1; wsSend({ connect: { token, name: "js" }, id: wsc.cmdId++ }); };
    s.onmessage = (ev) => wsOnMessage(ev.data);
    s.onclose = () => { wsc.connected = false; wsc.connecting = false; if (wsc.subs.size) scheduleReconnect(); };
    s.onerror = () => { try { s.close(); } catch (_) {} };
  };

  const wsOnMessage = (raw) => {
    if (typeof raw !== "string") return;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      if (line === "{}") { wsSend({}); continue; } // server ping -> pong
      let f; try { f = JSON.parse(line); } catch (_) { continue; }
      // connect reply (id 1): connection is up -> (re)subscribe every intended channel.
      if (f.id === 1 && f.connect) {
        wsc.connected = true; wsc.retry = 0; wsc.connecting = false;
        for (const ch of wsc.subs) sendSubscribe(ch);
        continue;
      }
      const push = f.push;
      const channel = push && push.channel;
      const data = push && push.pub && push.pub.data;
      if (channel && data && data.type === "new_hit" && channel.startsWith("battleLastHits:")) {
        const lh = data.lastHit || {};
        onLastHit({
          battleId: channel.slice("battleLastHits:".length),
          side: data.side,
          user: lh.user,
          damages: Number(lh.damages) || 0,
        }, "self");
      }
    }
  };

  const sendSubscribe = async (channel) => {
    let token = wsc.tokenCache.get(channel);
    if (!token) {
      try {
        const t = await trpcMutate("centrifugo.getSubscriptionToken", { channel });
        token = typeof t === "string" ? t : (t && t.json) || null;
      } catch (_) { token = null; }
      if (token) wsc.tokenCache.set(channel, token);
    }
    if (!token || !wsc.connected || !wsc.subs.has(channel)) return;
    wsSend({ subscribe: { channel, token, flag: 1 }, id: wsc.cmdId++ });
  };

  const selfSubscribe = (battleId) => {
    const channel = "battleLastHits:" + battleId;
    if (wsc.subs.has(channel)) return;
    wsc.subs.add(channel);
    if (wsc.connected) sendSubscribe(channel);
    else wsConnect();
  };

  const selfUnsubscribe = (battleId) => {
    const channel = "battleLastHits:" + battleId;
    if (!wsc.subs.delete(channel)) return;
    wsSend({ unsubscribe: { channel }, id: wsc.cmdId++ });
  };

  // Subscribe to every battle at least one panel watches; unsubscribe from any battle no panel
  // watches anymore. Cheap to call after any panel's selection changes.
  const reconcileSubscriptions = () => {
    const watched = watchedBattleIds();
    for (const battleId of watched) selfSubscribe(battleId);
    for (const channel of [...wsc.subs]) {
      const battleId = channel.slice("battleLastHits:".length);
      if (!watched.has(battleId)) selfUnsubscribe(battleId);
    }
  };

  // ---- overlay-driven panel registry + battle selection ------------------
  const registerPanel = (panelId) => {
    if (!panelBattle.has(panelId)) panelBattle.set(panelId, null);
  };

  // A tracker window was closed — stop tracking its battle selection. Overlay always reassigns
  // activePanelId to a surviving panel (in a separate setActivePanel message) before/after this
  // when the closed one was active, so activePanelId is never left dangling here.
  const unregisterPanel = (panelId) => {
    panelBattle.delete(panelId);
    reconcileSubscriptions(); // that battle may now have zero watchers
    draw(true);
  };

  const selectBattle = (panelId, battleId) => {
    registerPanel(panelId);
    panelBattle.set(panelId, battleId || null);
    if (battleId) ensureBattle(battleId);
    reconcileSubscriptions();
    draw(true);
  };

  const setActivePanel = (panelId) => {
    registerPanel(panelId);
    activePanelId = panelId;
    draw(true); // swap SVG visibility immediately — no waiting on the next tick
  };

  const buildBattleList = async () => {
    let grouped;
    try { grouped = await trpcRaw("battle.getGroupedActiveBattles", {}); }
    catch (_) { return; }
    const g = (grouped && grouped.json) || grouped || {};
    // De-dupe ids across groups, remembering the first (most relevant) group each appeared in.
    const order = ["favorites", "yourCountry", "allies", "enemy", "withBounty", "orders", "other", "tournament"];
    const seen = new Map(); // battleId -> group
    for (const grp of order) {
      const ids = Array.isArray(g[grp]) ? g[grp] : [];
      for (const id of ids) if (typeof id === "string" && !seen.has(id)) seen.set(id, grp);
    }
    const ids = [...seen.keys()].slice(0, 60); // cap the on-demand getById fan-out
    const items = await Promise.all(ids.map(async (id) => {
      try {
        const d = await trpcRaw("battle.getById", { battleId: id });
        const region = d && d.defender && d.defender.region;
        return {
          battleId: id,
          group: seen.get(id),
          regionName: (region && regionMeta[region] && regionMeta[region].name) || null,
          attacker: countryLabel(d && d.attacker && d.attacker.country),
          defender: countryLabel(d && d.defender && d.defender.country),
        };
      } catch (_) { return null; }
    }));
    window.postMessage(
      { __wdl: CHANNEL, kind: "battleList", battles: items.filter(Boolean) },
      location.origin
    );
  };

  // ---- wiring -----------------------------------------------------------
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.__wdl !== CHANNEL) return;
    if (d.kind === "lasthit") onLastHit(d, "tap");
    else if (d.kind === "config") { enabled = d.enabled !== false; draw(true); }
    else if (d.kind === "registerPanel") registerPanel(d.panelId);
    else if (d.kind === "unregisterPanel") unregisterPanel(d.panelId);
    else if (d.kind === "selectBattle") selectBattle(d.panelId, d.battleId || null);
    else if (d.kind === "setActivePanel") setActivePanel(d.panelId);
    else if (d.kind === "requestBattleList") buildBattleList();
  });

  const start = async () => {
    ensureSvg();
    try { ready = await buildLookups(); } catch (_) { ready = false; }
    if (!ready) { setTimeout(start, 1500); return; }
    map.on("render", () => draw(false));   // reproject only
    setInterval(() => draw(true), 1000);   // refresh rates + push summaries
    draw(true);
  };

  const waitForMap = () => {
    map = findMap();
    if (map) start();
    else setTimeout(waitForMap, 500);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", waitForMap);
  } else {
    waitForMap();
  }
})();
