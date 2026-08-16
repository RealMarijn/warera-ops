// WarEra Damage lines — MAIN-world engine + map renderer.
//
// Model (per user request): for the battle being spectated, draw one line from
// EACH contributing player-country to the contested region, thickness ∝ that
// country's live damage rate, coloured by side (attacker = red, defender = blue).
//
// Runs in the MAIN world because it needs (a) the page's MapLibre Map instance
// and (b) same-origin tRPC calls with the game's auth cookies. Data in:
//   hook.js -> {kind:"lasthit", battleId, side, user, damages}   (per hit)
//   overlay.js -> {kind:"config", enabled}
// Data out:
//   -> {kind:"summary", ...}   for the overlay panel
//
// Pipeline: lasthit -> resolve user's country (cached) -> aggregate per country
// -> project country centroid + region centroid -> draw/update arcs.
(() => {
  "use strict";
  if (window.top !== window) return;
  try { document.documentElement.dataset.wdlEngine = "0.4.0"; } catch (_) {}
  console.log("[WDL] map.js engine v0.4.0 (tapered lines) loaded");

  const CHANNEL = "warera-dmg-lines";
  const NS = "http://www.w3.org/2000/svg";
  const RATE_WINDOW_MS = 60_000;   // sliding window for "damage/min"
  const MAX_LINES = 14;            // cap arcs to avoid clutter
  const ATT = "#ff5a5a", DEF = "#5aa9ff";

  let map = null;
  let regionPos = {};   // regionId  -> [lng,lat]
  let countryPos = {};  // countryId -> [lng,lat] (homeland centroid)
  let countryMeta = {}; // countryId -> { code, name }
  let ready = false;
  let enabled = true;

  // battleId -> { region, meta, countries: Map<countryId,{side,total,events:[{t,dmg}]}> }
  const battles = new Map();
  let activeBattleId = null;

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
    return true;
  };

  // ---- battle metadata (region + sides) ---------------------------------
  const ensureBattle = (battleId) => {
    let b = battles.get(battleId);
    if (!b) {
      b = { region: null, meta: false, countries: new Map() };
      battles.set(battleId, b);
    }
    if (!b.meta) {
      b.meta = true; // guard against duplicate fetches
      trpcRaw("battle.getById", { battleId })
        .then((d) => { b.region = d && d.defender && d.defender.region; })
        .catch(() => { b.meta = false; });
    }
    return b;
  };

  // ---- damage attribution ----------------------------------------------
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

  const onLastHit = (m) => {
    if (!m.user) return;
    activeBattleId = m.battleId;
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

  // ---- rendering --------------------------------------------------------
  // Each line is a tapered "ribbon" (a filled polygon that follows a quadratic
  // curve) rather than a plain stroke — a stroke can't vary its width. It starts
  // near-zero width at the source country and widens toward the region, filled
  // with a linear gradient that fades from near-transparent (source) to bright
  // (region), so the flow reads as "into" the contested region.
  let svg, gArcs, defsEl;
  const arcEls = new Map(); // countryId -> { path, grad, s0, s1 }

  const ensureSvg = () => {
    if (svg) return;
    svg = document.createElementNS(NS, "svg");
    svg.id = "wdl-map-lines";
    Object.assign(svg.style, {
      position: "fixed", inset: "0", width: "100vw", height: "100vh",
      pointerEvents: "none", zIndex: "9998",
    });
    defsEl = document.createElementNS(NS, "defs");
    svg.appendChild(defsEl);
    gArcs = document.createElementNS(NS, "g");
    svg.appendChild(gArcs);
    document.body.appendChild(svg);
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
      const w = (0.4 + Math.pow(t, 1.4) * wMax) / 2; // half-width, tapered
      left += (i ? " L " : "M ") + (px + ux * w) + " " + (py + uy * w);
      right = " L " + (px - ux * w) + " " + (py - uy * w) + right;
    }
    return left + right + " Z";
  };

  const draw = (doPost) => {
    if (!ready || !svg) return;
    const b = activeBattleId && battles.get(activeBattleId);
    const target = b && b.region && regionPos[b.region];
    if (!enabled || !b || !target) {
      gArcs.style.display = "none";
      if (doPost) window.postMessage({ __wdl: CHANNEL, kind: "summary", active: false }, location.origin);
      return;
    }
    gArcs.style.display = "";
    const now = Date.now();
    const tp = map.project(target);

    // rank contributing countries by current rate
    const rows = [];
    for (const [cid, c] of b.countries) {
      const pos = countryPos[cid];
      if (!pos) continue;
      rows.push({ cid, side: c.side, total: c.total, rate: rateOf(c.events, now), pos });
    }
    rows.sort((a, b2) => b2.rate - a.rate || b2.total - a.total);
    const shown = rows.slice(0, MAX_LINES);
    const maxRate = Math.max(1, ...shown.map((r) => r.rate));

    const live = new Set();
    for (const r of shown) {
      live.add(r.cid);
      let e = arcEls.get(r.cid);
      if (!e) {
        const grad = document.createElementNS(NS, "linearGradient");
        grad.setAttribute("gradientUnits", "userSpaceOnUse");
        grad.id = "wdlg-" + r.cid;
        const s0 = document.createElementNS(NS, "stop"); s0.setAttribute("offset", "0");
        const s1 = document.createElementNS(NS, "stop"); s1.setAttribute("offset", "1");
        grad.append(s0, s1);
        defsEl.appendChild(grad);
        const path = document.createElementNS(NS, "path");
        path.setAttribute("fill", `url(#wdlg-${r.cid})`);
        path.setAttribute("stroke", "none");
        gArcs.appendChild(path);
        e = { path, grad, s0, s1 };
        arcEls.set(r.cid, e);
      }
      const cp = map.project(r.pos);
      const color = r.side === "attacker" ? ATT : DEF;
      const wMax = 2 + (r.rate / maxRate) * 9;
      const live_ = r.rate > 0;
      e.path.setAttribute("d", ribbonPath(cp, tp, wMax));
      // gradient runs from source (faint) to region (bright), following the line
      e.grad.setAttribute("x1", cp.x); e.grad.setAttribute("y1", cp.y);
      e.grad.setAttribute("x2", tp.x); e.grad.setAttribute("y2", tp.y);
      e.s0.setAttribute("stop-color", color); e.s0.setAttribute("stop-opacity", live_ ? "0.04" : "0.02");
      e.s1.setAttribute("stop-color", color); e.s1.setAttribute("stop-opacity", live_ ? "0.95" : "0.25");
    }
    // remove arcs no longer shown
    for (const [cid, e] of arcEls) {
      if (!live.has(cid)) { e.path.remove(); e.grad.remove(); arcEls.delete(cid); }
    }

    if (doPost) postSummary(shown, now);
  };

  const postSummary = (rows, now) => {
    window.postMessage({
      __wdl: CHANNEL, kind: "summary", active: true,
      countries: rows.map((r) => ({
        code: (countryMeta[r.cid] || {}).code || "",
        name: (countryMeta[r.cid] || {}).name || "?",
        side: r.side, total: r.total, rate: r.rate,
      })),
    }, location.origin);
  };

  // ---- wiring -----------------------------------------------------------
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.__wdl !== CHANNEL) return;
    if (d.kind === "lasthit") onLastHit(d);
    else if (d.kind === "config") { enabled = d.enabled !== false; draw(true); }
  });

  const start = async () => {
    ensureSvg();
    try { ready = await buildLookups(); } catch (_) { ready = false; }
    if (!ready) { setTimeout(start, 1500); return; }
    map.on("render", () => draw(false));   // reproject only
    setInterval(() => draw(true), 1000);   // refresh rates + push summary
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
