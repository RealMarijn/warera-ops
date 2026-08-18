// WarEra Ops — Strategic Resources map overlay (MAIN world engine + renderer).
//
// Draws a coloured badge on every region that holds a strategic resource, ON TOP of the game's
// normal country-coloured map — borders and ownership stay fully intact. This is the opposite of
// the game's built-in SR view, which recolours regions and hides who owns what.
//
// Same overlay technique as tools/dmg-lines: an SVG injected INTO the MapLibre container (so it
// sits above the map but below the app UI), reprojected on every map render. Data comes from
// region.getRegionsObject (each region carries a `strategicResource` + `position` [lng,lat]).
//
// Config in (from the ISOLATED overlay sr-overlay.js, via postMessage):
//   { kind:"config", enabled, types }   enabled = whole feature; types = per-resource filter
//   { kind:"requestCounts" }            ask for per-type counts (to build the legend)
// Data out:
//   { kind:"counts", counts }           how many regions hold each resource
(() => {
  "use strict";
  if (window.top !== window) return;
  try { document.documentElement.dataset.wsrEngine = "0.1.0"; } catch (_) {}
  console.log("[WSR] sr-map.js engine v0.1.0 loaded");

  const CHANNEL = "warera-sr-map";
  const NS = "http://www.w3.org/2000/svg";
  // Resource -> badge colour, text colour, short glyph. Kept in sync with sr-overlay.js.
  const RES = {
    coal:       { color: "#4b5563", fg: "#ffffff", glyph: "coal.png" },
    gold:       { color: "#f2c14e", fg: "#1a1400", glyph: "gold.png" },
    uranium:    { color: "#7ee787", fg: "#08240f", glyph: "uranium.png" },
    diamonds:   { color: "#7fd7ff", fg: "#062230", glyph: "diamond.png" },
    lithium:    { color: "#c792ff", fg: "#1c0630", glyph: "lithium.png" },
    rareEarths: { color: "#ff9f6b", fg: "#301300", glyph: "rareEarths.png" },
  };

  let map = null;
  let ready = false;
  let enabled = false;         // whole feature; driven by the popup/overlay toggle
  let types = null;            // { coal:true, ... } per-type filter; null = all on
  let regions = [];            // [{ id, pos:[lng,lat], sr }]
  let lastCounts = {};
  // Base URL for the badge images (e.g. moz-extension://<uuid>/assets/images/).
  // This MAIN-world engine has no access to chrome.runtime.getURL, so the ISOLATED
  // overlay (sr-overlay.js) resolves it and sends it in its "config" message.
  let imgBase = null;

  // ---- tRPC (page context, auth cookies) --------------------------------
  const trpcGet = async (proc, input) => {
    const url = "https://api2.warera.io/trpc/" + proc +
      "?batch=1&input=" + encodeURIComponent(JSON.stringify({ 0: input }));
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) throw new Error(proc + " " + r.status);
    const j = await r.json();
    const d = j[0].result.data;
    return d.json || d;
  };

  // ---- find MapLibre map via React fiber (same detection as dmg-lines) --
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
  const IMG_SIZE = 26;                              // badge width/height in px
  const XLINK = "http://www.w3.org/1999/xlink";
  const setHref = (img, url) => {
    img.setAttribute("href", url);
    img.setAttributeNS(XLINK, "xlink:href", url);   // fallback for older SVG renderers
  };
  let svg, gBadges;
  const badges = new Map(); // regionId -> { g, img, region }

  const mapContainer = () => {
    try { if (map && typeof map.getContainer === "function") { const c = map.getContainer(); if (c) return c; } } catch (_) {}
    const cv = document.querySelector("canvas.maplibregl-canvas");
    return (cv && cv.closest(".maplibregl-map")) || document.body;
  };

  const ensureSvg = () => {
    if (svg) return;
    svg = document.createElementNS(NS, "svg");
    svg.id = "wsr-map-badges";
    const container = mapContainer();
    const inMap = container !== document.body;
    Object.assign(svg.style, {
      position: inMap ? "absolute" : "fixed", inset: "0",
      width: "100%", height: "100%", pointerEvents: "none", zIndex: "1",
    });
    if (!inMap) svg.style.zIndex = "9997";
    gBadges = document.createElementNS(NS, "g");
    svg.appendChild(gBadges);
    container.appendChild(svg);
  };

  // Each badge is an SVG <image> centred on its region, wrapped in a <g> we can
  // translate on every map render. The <image> href is only set once we know the
  // extension's asset base URL (imgBase), which arrives from the ISOLATED overlay.
  const makeBadge = (region) => {
    const meta = RES[region.sr];
    if (!meta) return null;
    const g = document.createElementNS(NS, "g");
    const img = document.createElementNS(NS, "image");
    img.setAttribute("width", IMG_SIZE);
    img.setAttribute("height", IMG_SIZE);
    img.setAttribute("x", -IMG_SIZE / 2);            // centre on the region point
    img.setAttribute("y", -IMG_SIZE / 2);
    img.setAttribute("preserveAspectRatio", "xMidYMid meet");
    img.style.filter = "drop-shadow(0 1px 2px rgba(0,0,0,.6))"; // legibility over the map
    if (imgBase) setHref(img, imgBase + meta.glyph);
    g.appendChild(img);
    return { g, img };
  };

  const buildBadges = () => {
    for (const region of regions) {
      const b = makeBadge(region);
      if (!b) continue;
      b.g.style.display = "none";
      gBadges.appendChild(b.g);
      badges.set(region.id, { g: b.g, img: b.img, region });
    }
  };

  // (Re)point every badge's <image> at the resolved asset base URL. Called when
  // imgBase first arrives, which may be before or after buildBadges() has run.
  const applyImgBase = () => {
    if (!imgBase) return;
    for (const { img, region } of badges.values()) {
      const meta = RES[region.sr];
      if (meta) setHref(img, imgBase + meta.glyph);
    }
  };

  const isTypeOn = (sr) => !types || types[sr] !== false;

  const draw = () => {
    if (!ready || !svg) return;
    if (!enabled) { svg.style.display = "none"; return; }
    svg.style.display = "";
    let cw = window.innerWidth, ch = window.innerHeight;
    try { const cv = map.getCanvas(); if (cv) { cw = cv.clientWidth || cw; ch = cv.clientHeight || ch; } } catch (_) {}
    const M = 24; // cull margin
    for (const { g, region } of badges.values()) {
      if (!isTypeOn(region.sr)) { g.style.display = "none"; continue; }
      const p = map.project(region.pos);
      if (p.x < -M || p.y < -M || p.x > cw + M || p.y > ch + M) { g.style.display = "none"; continue; }
      g.setAttribute("transform", `translate(${p.x} ${p.y})`);
      g.style.display = "";
    }
  };

  // ---- load + wiring ----------------------------------------------------
  const loadRegions = async () => {
    const obj = await trpcGet("region.getRegionsObject", {});
    regions = [];
    const counts = {};
    for (const id in obj) {
      const rg = obj[id];
      if (rg && rg.strategicResource && Array.isArray(rg.position) && RES[rg.strategicResource]) {
        regions.push({ id, pos: rg.position, sr: rg.strategicResource });
        counts[rg.strategicResource] = (counts[rg.strategicResource] || 0) + 1;
      }
    }
    lastCounts = counts;
    window.postMessage({ __wsr: CHANNEL, kind: "counts", counts }, location.origin);
  };

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.__wsr !== CHANNEL) return;
    if (d.kind === "config") {
      enabled = !!d.enabled;
      types = d.types || null;
      if (d.imgBase && d.imgBase !== imgBase) { imgBase = d.imgBase; applyImgBase(); }
      draw();
    } else if (d.kind === "requestCounts") {
      window.postMessage({ __wsr: CHANNEL, kind: "counts", counts: lastCounts }, location.origin);
    }
  });

  const start = async () => {
    ensureSvg();
    try {
      await loadRegions();
    } catch (err) {
      console.warn("[WSR] region load failed, retrying", err);
      setTimeout(start, 3000);
      return;
    }
    buildBadges();
    ready = true;
    map.on("render", draw); // reproject badges as the map pans/zooms
    draw();
  };

  const waitForMap = () => {
    map = findMap();
    if (map) start();
    else setTimeout(waitForMap, 500);
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", waitForMap);
  else waitForMap();
})();
