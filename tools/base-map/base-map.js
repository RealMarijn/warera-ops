// WarEra Ops — Military bases / bunkers map overlay (MAIN world engine + renderer).
//
// Badges every region that has an ACTIVE or soon-to-be-active ("pending") military base and/or
// bunker, ON TOP of the game's normal map — the game itself has no such at-a-glance view. Data
// comes from our whitelist-gated backend (see docs/using-the-backend.md), which the ISOLATED
// overlay (base-overlay.js) polls every 2 min and forwards here; this engine owns the map geometry
// (region positions + names, from region.getRegionsObject) and does the join + drawing + the
// "something new lit up" diff that drives the notification toasts.
//
// Same overlay technique as tools/sr-map: an SVG injected INTO the MapLibre container, reprojected
// on every map render. This engine has no chrome.runtime access (MAIN world), so ALL backend data
// arrives via postMessage from the ISOLATED overlay.
//
// Messages (discriminator __wbm: "warera-base-map"):
//   in  { kind:"config", enabled:{bases,bunkers} }   which layers to draw (already AND-ed with login)
//   in  { kind:"data",   bases?, bunkers? }           status maps { regionId: {s,l,t?} }; layer omitted = unchanged
//   out { kind:"notify", items:[{layer,regionId,name,status,t,level}] }  newly active/pending regions
(() => {
  "use strict";
  if (window.top !== window) return;
  try { document.documentElement.dataset.wbmEngine = "0.1.0"; } catch (_) {}
  console.log("[WBM] base-map.js engine v0.1.0 loaded");

  const CHANNEL = "warera-base-map";
  const NS = "http://www.w3.org/2000/svg";
  const LAYERS = ["bases", "bunkers"];
  // Per-layer badge colour + label + a small horizontal offset so a region that has BOTH a base and
  // a bunker shows two side-by-side badges instead of one on top of the other.
  const LAYER = {
    bases:   { color: "#f59e0b", label: "Military base", dx: -10 },
    bunkers: { color: "#38bdf8", label: "Bunker",        dx: 10 },
  };
  const RELEVANT = new Set(["a", "p"]); // active / pending — what we draw and notify on

  let map = null;
  let started = false;
  let ready = false;
  const enabled = { bases: false, bunkers: false };
  const data = { bases: null, bunkers: null };            // { regionId: {s,l,t?} }
  const prev = { bases: null, bunkers: null };            // Set<regionId> of last-seen relevant regions
  let regions = {};                                       // regionId -> { pos:[lng,lat], name }
  let wantSample = false;                                 // overlay asked for a real region (test toast link)

  // ---- tRPC (page context, auth cookies) — region geometry only ---------
  const trpcGet = async (proc, input) => {
    const url = "https://api2.warera.io/trpc/" + proc +
      "?batch=1&input=" + encodeURIComponent(JSON.stringify({ 0: input }));
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) throw new Error(proc + " " + r.status);
    const j = await r.json();
    const d = j[0].result.data;
    return d.json || d;
  };

  // ---- find MapLibre map via React fiber (same detection as sr-map) -----
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
    let root = container[fk]; while (root.return) root = root.return;
    const stack = [root]; let guard = 0;
    while (stack.length && guard++ < 60000) {
      const n = stack.pop(); if (!n) continue;
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

  // ---- SVG overlay inside the map container -----------------------------
  let svg, gBadges;
  const badges = new Map(); // "layer:regionId" -> { g, circle, ring, title, d }

  const mapContainer = () => {
    try { if (map && typeof map.getContainer === "function") { const c = map.getContainer(); if (c) return c; } } catch (_) {}
    const cv = document.querySelector("canvas.maplibregl-canvas");
    return (cv && cv.closest(".maplibregl-map")) || document.body;
  };

  const ensureSvg = () => {
    if (svg) return;
    svg = document.createElementNS(NS, "svg");
    svg.id = "wbm-map-badges";
    const container = mapContainer();
    const inMap = container !== document.body;
    Object.assign(svg.style, {
      position: inMap ? "absolute" : "fixed", inset: "0",
      width: "100%", height: "100%", pointerEvents: "none", zIndex: "1",
    });
    if (!inMap) svg.style.zIndex = "9997";
    const style = document.createElementNS(NS, "style");
    style.textContent = `
      #wbm-map-badges .wbm-ring { opacity: 0; }
      #wbm-map-badges .wbm-pending .wbm-ring {
        animation: wbmPulse 1.6s ease-in-out infinite; transform-box: fill-box; transform-origin: center;
      }
      /* The badge itself gently "breathes" while pending, so it stands out from active ones. */
      #wbm-map-badges .wbm-pending .wbm-core {
        animation: wbmBreathe 1.6s ease-in-out infinite; transform-box: fill-box; transform-origin: center;
      }
      @keyframes wbmPulse {
        0%, 100% { transform: scale(1); opacity: .85; }
        50%      { transform: scale(1.9); opacity: 0; }
      }
      @keyframes wbmBreathe {
        0%, 100% { transform: scale(1); }
        50%      { transform: scale(1.16); }
      }`;
    gBadges = document.createElementNS(NS, "g");
    svg.append(style, gBadges);
    container.appendChild(svg);
  };

  // Simple white glyphs so a base and a bunker read differently at a glance.
  const starPoints = (outer, inner, spikes = 5) => {
    let pts = [], rot = -Math.PI / 2, step = Math.PI / spikes;
    for (let i = 0; i < spikes; i++) {
      pts.push([Math.cos(rot) * outer, Math.sin(rot) * outer]); rot += step;
      pts.push([Math.cos(rot) * inner, Math.sin(rot) * inner]); rot += step;
    }
    return pts.map((p) => p.map((n) => n.toFixed(2)).join(",")).join(" ");
  };

  const makeGlyph = (layer) => {
    if (layer === "bases") {
      const poly = document.createElementNS(NS, "polygon"); // star = base
      poly.setAttribute("points", starPoints(5.4, 2.3));
      poly.setAttribute("fill", "#fff");
      return poly;
    }
    const path = document.createElementNS(NS, "path");      // dome = bunker
    path.setAttribute("d", "M -5 3.5 L -5 0 A 5 5 0 0 1 5 0 L 5 3.5 Z");
    path.setAttribute("fill", "#fff");
    return path;
  };

  const makeBadge = (layer) => {
    const meta = LAYER[layer];
    const g = document.createElementNS(NS, "g");
    const ring = document.createElementNS(NS, "circle");
    ring.setAttribute("class", "wbm-ring");
    ring.setAttribute("r", "9");
    ring.setAttribute("fill", "none");
    ring.setAttribute("stroke", meta.color);
    ring.setAttribute("stroke-width", "2.5");
    const circle = document.createElementNS(NS, "circle");
    circle.setAttribute("class", "wbm-core");
    circle.setAttribute("r", "9");
    circle.setAttribute("fill", meta.color);
    circle.setAttribute("stroke", "#fff");
    circle.setAttribute("stroke-width", "1.5");
    circle.style.filter = "drop-shadow(0 1px 2px rgba(0,0,0,.55))";
    const glyph = makeGlyph(layer);
    // Small level bubble at the top-right corner (the backend's `l`).
    const lvlBg = document.createElementNS(NS, "circle");
    lvlBg.setAttribute("cx", "8"); lvlBg.setAttribute("cy", "-8"); lvlBg.setAttribute("r", "6");
    lvlBg.setAttribute("fill", "#0b0d12");
    lvlBg.setAttribute("stroke", "#fff");
    lvlBg.setAttribute("stroke-width", "1");
    const lvlText = document.createElementNS(NS, "text");
    lvlText.setAttribute("x", "8"); lvlText.setAttribute("y", "-8");
    lvlText.setAttribute("text-anchor", "middle");
    lvlText.setAttribute("dominant-baseline", "central");
    lvlText.setAttribute("font-family", "Saira, system-ui, sans-serif");
    lvlText.setAttribute("font-size", "8");
    lvlText.setAttribute("font-weight", "700");
    lvlText.setAttribute("fill", "#fff");
    // Live countdown label below the badge (pending only). A dark halo via
    // paint-order keeps it legible over any map colour.
    const cd = document.createElementNS(NS, "text");
    cd.setAttribute("x", "0"); cd.setAttribute("y", "20");
    cd.setAttribute("text-anchor", "middle");
    cd.setAttribute("dominant-baseline", "middle");
    cd.setAttribute("font-family", "Saira, system-ui, sans-serif");
    cd.setAttribute("font-size", "9");
    cd.setAttribute("font-weight", "700");
    cd.setAttribute("fill", "#fff");
    cd.setAttribute("stroke", "rgba(0,0,0,.85)");
    cd.setAttribute("stroke-width", "2.6");
    cd.setAttribute("paint-order", "stroke");
    cd.style.display = "none";
    const title = document.createElementNS(NS, "title");
    g.append(ring, circle, glyph, lvlBg, lvlText, cd, title);
    return { g, circle, ring, lvlBg, lvlText, cd, title };
  };

  // Compact, ticking countdown: "3h 12m" / "12m 04s" / "45s" / "now".
  const fmtCountdown = (t) => {
    const ms = new Date(t).getTime() - Date.now();
    if (isNaN(ms)) return "";
    if (ms <= 0) return "now";
    const sec = Math.floor(ms / 1000);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return h + "h " + m + "m";
    if (m > 0) return m + "m " + String(s).padStart(2, "0") + "s";
    return s + "s";
  };

  const updateBadge = (b, d) => {
    const meta = LAYER[d.layer];
    const pending = d.status === "p";
    // Pending reads differently at a glance: pulsing ring, translucent fill and a
    // dashed outline; active is a solid filled circle.
    b.g.setAttribute("class", pending ? "wbm-pending" : "");
    b.circle.setAttribute("fill-opacity", pending ? "0.55" : "1");
    b.circle.setAttribute("stroke-dasharray", pending ? "3 2" : "");
    const when = pending ? "activating" + (d.t ? " in " + fmtCountdown(d.t) : "") : "active";
    b.title.textContent = `${meta.label} — ${when} · lvl ${d.level ?? "?"}`;
    const hasLvl = d.level != null;
    b.lvlText.textContent = hasLvl ? String(d.level) : "";
    b.lvlBg.style.display = hasLvl ? "" : "none";
    b.lvlText.style.display = hasLvl ? "" : "none";
    // Countdown label (pending + known activation time only).
    if (pending && d.t) { b.cd.style.display = ""; b.cd.textContent = fmtCountdown(d.t); }
    else { b.cd.style.display = "none"; b.cd.textContent = ""; }
  };

  // Re-tick the countdown labels once a second (cheap: a handful of pending badges).
  const updateCountdowns = () => {
    for (const b of badges.values()) {
      const d = b.d;
      if (d && d.status === "p" && d.t && b.g.style.display !== "none") b.cd.textContent = fmtCountdown(d.t);
    }
  };

  // ---- reconcile drawn badges against the current enabled+data set ------
  const reconcile = () => {
    if (!ready || !gBadges) return;
    const desired = new Map(); // key -> d
    for (const layer of LAYERS) {
      if (!enabled[layer] || !data[layer]) continue;
      const statuses = data[layer];
      for (const id in statuses) {
        const st = statuses[id];
        if (!st || !RELEVANT.has(st.s)) continue;
        const geo = regions[id];
        if (!geo || !Array.isArray(geo.pos)) continue; // no position → can't place it
        desired.set(layer + ":" + id, {
          layer, regionId: id, status: st.s, t: st.t, level: st.l, pos: geo.pos, name: geo.name || id,
        });
      }
    }
    for (const [key, b] of badges) {
      if (!desired.has(key)) { b.g.remove(); badges.delete(key); }
    }
    for (const [key, d] of desired) {
      let b = badges.get(key);
      if (!b) { b = makeBadge(d.layer); badges.set(key, b); gBadges.appendChild(b.g); }
      b.d = d;
      updateBadge(b, d);
    }
    draw();
  };

  const draw = () => {
    if (!ready || !svg) return;
    const anyOn = enabled.bases || enabled.bunkers;
    if (!anyOn) { svg.style.display = "none"; return; }
    svg.style.display = "";
    let cw = window.innerWidth, ch = window.innerHeight;
    try { const cv = map.getCanvas(); if (cv) { cw = cv.clientWidth || cw; ch = cv.clientHeight || ch; } } catch (_) {}
    const M = 24; // cull margin
    for (const b of badges.values()) {
      const d = b.d; if (!d) continue;
      const p = map.project(d.pos);
      if (p.x < -M || p.y < -M || p.x > cw + M || p.y > ch + M) { b.g.style.display = "none"; continue; }
      b.g.setAttribute("transform", `translate(${p.x + LAYER[d.layer].dx} ${p.y})`);
      b.g.style.display = "";
    }
  };

  // ---- "something new lit up" diff (drives the toasts) ------------------
  const diffNotify = (layer) => {
    const statuses = data[layer];
    const cur = new Set();
    if (statuses) for (const id in statuses) { const st = statuses[id]; if (st && RELEVANT.has(st.s)) cur.add(id); }
    const before = prev[layer];
    prev[layer] = cur;
    if (!before) return []; // first snapshot after enabling → baseline, don't notify
    const items = [];
    for (const id of cur) {
      if (before.has(id)) continue;
      const geo = regions[id]; const st = statuses[id];
      items.push({ layer, regionId: id, name: (geo && geo.name) || id, status: st.s, t: st.t, level: st.l });
    }
    return items;
  };

  const post = (msg) => window.postMessage(Object.assign({ __wbm: CHANNEL }, msg), location.origin);

  // Hand the overlay one real region so its example/test toast can link somewhere
  // real. Prefer a region that actually holds a base/bunker right now; else any named one.
  const sendSample = () => {
    let pick = null;
    for (const layer of LAYERS) {
      const statuses = data[layer];
      if (!statuses) continue;
      for (const id in statuses) {
        const st = statuses[id];
        if (st && RELEVANT.has(st.s) && regions[id] && regions[id].name) { pick = id; break; }
      }
      if (pick) break;
    }
    if (!pick) for (const id in regions) { if (regions[id] && regions[id].name) { pick = id; break; } }
    if (pick) post({ kind: "sample", region: { id: pick, name: regions[pick].name } });
  };

  // ---- message handling -------------------------------------------------
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.__wbm !== CHANNEL) return;

    if (d.kind === "config") {
      const en = d.enabled || {};
      for (const layer of LAYERS) {
        const next = !!en[layer];
        if (next && !enabled[layer]) prev[layer] = null; // re-baseline when a layer is switched on
        if (!next) prev[layer] = null;                   // forget history while off
        enabled[layer] = next;
      }
      if ((enabled.bases || enabled.bunkers) && !started) startEngine();
      reconcile();
    } else if (d.kind === "data") {
      let notify = [];
      for (const layer of LAYERS) {
        if (!(layer in d)) continue;          // layer omitted → unchanged
        data[layer] = d[layer] || null;
        if (enabled[layer] && ready) notify = notify.concat(diffNotify(layer));
      }
      reconcile();
      if (notify.length) post({ kind: "notify", items: notify });
    } else if (d.kind === "requestSample") {
      wantSample = true;
      if (ready) sendSample();
    }
  });

  // ---- startup ----------------------------------------------------------
  const loadRegions = async () => {
    const obj = await trpcGet("region.getRegionsObject", {});
    const next = {};
    for (const id in obj) {
      const rg = obj[id];
      if (rg && Array.isArray(rg.position)) next[id] = { pos: rg.position, name: rg.name || null };
    }
    regions = next;
  };

  const start = async () => {
    ensureSvg();
    try {
      await loadRegions();
    } catch (err) {
      console.warn("[WBM] region load failed, retrying", err);
      setTimeout(start, 3000);
      return;
    }
    ready = true;
    map.on("render", draw); // reproject as the map pans/zooms
    setInterval(updateCountdowns, 1000); // live-tick pending countdown labels
    // Draw whatever data already arrived. We deliberately DON'T seed the notify
    // baseline here: prev[layer] stays null, so the first poll that lands after
    // we're ready is treated as the baseline (silent) rather than toasting the
    // entire current state on load.
    reconcile();
    if (wantSample) sendSample();
  };

  const startEngine = () => {
    if (started) return;
    started = true;
    const waitForMap = () => {
      map = findMap();
      if (map) start();
      else setTimeout(waitForMap, 500);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", waitForMap);
    else waitForMap();
  };
})();
