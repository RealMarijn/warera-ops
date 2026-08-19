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
  try { document.documentElement.dataset.wsrEngine = "0.2.0"; } catch (_) {}
  console.log("[WSR] sr-map.js engine v0.2.0 loaded");

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

  // ---- globe-mode occlusion (hide badges on the far side) ---------------
  // Same technique as tools/dmg-lines/map.js: map.project() gives no signal
  // about occlusion on a globe (a point's antipode projects to the same
  // screen position as the facing point), so round-tripping through
  // unproject(project(point)) is used instead — a big gap between the
  // original point and the round-tripped one means it was occluded. Both
  // project/unproject/getProjection are forwarded by the react-map-gl
  // wrapper `map` already holds (confirmed in the dmg-lines engine), so no
  // .getMap() unwrap is needed here.
  const OCCLUSION_THRESHOLD_DEG = 1;
  const toLngLat = (p) => Array.isArray(p) ? { lng: p[0], lat: p[1] } : p;
  const angularDiffDeg = (a, b) => {
    const A = toLngLat(a), B = toLngLat(b);
    const rad = Math.PI / 180;
    const s = Math.sin(A.lat * rad) * Math.sin(B.lat * rad) +
      Math.cos(A.lat * rad) * Math.cos(B.lat * rad) * Math.cos((A.lng - B.lng) * rad);
    return Math.acos(Math.max(-1, Math.min(1, s))) / rad;
  };
  const isGlobeMode = () => {
    try { return map.getProjection().type === "globe"; } catch (_) { return false; }
  };
  const isOccludedOnGlobe = (lngLat) => {
    if (!isGlobeMode()) return false;
    try {
      const back = map.unproject(map.project(lngLat));
      return angularDiffDeg(lngLat, back) > OCCLUSION_THRESHOLD_DEG;
    } catch (_) {
      return false;
    }
  };

  // ---- cross-engine badge layout (shared with tools/base-map/base-map.js) -
  // Bases, bunkers and strategic resources are drawn by two INDEPENDENT
  // MAIN-world engines (this file, and base-map.js) that otherwise know
  // nothing about each other — but they run in the same page realm, so a
  // plain window global is the simplest way for them to agree on how many
  // badge "slots" a given region needs and which slot is this engine's,
  // without either one owning the other's data. See base-map.js's copy of
  // this same block for the full reasoning.
  const BADGE_TYPES = ["bases", "bunkers", "sr"];
  const badgeRegistry = (window.__wdlBadgeRegistry = window.__wdlBadgeRegistry || {
    bases: new Set(), bunkers: new Set(), sr: new Set(),
  });
  const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  const publishBadgeRegions = (updates) => {
    let changed = false;
    for (const key in updates) {
      if (!sameSet(badgeRegistry[key] || new Set(), updates[key])) changed = true;
    }
    Object.assign(badgeRegistry, updates);
    if (changed) window.dispatchEvent(new CustomEvent("wdl-badge-registry-changed"));
  };
  const BADGE_OFFSET_PAIR = [[-10, 0], [10, 0]];
  const BADGE_OFFSET_TRIANGLE = [[0, -11], [-9.5, 6], [9.5, 6]];
  const badgeOffset = (myKey, regionId) => {
    const present = BADGE_TYPES.filter((k) => badgeRegistry[k] && badgeRegistry[k].has(regionId));
    const idx = present.indexOf(myKey);
    if (idx === -1 || present.length <= 1) return [0, 0];
    if (present.length === 2) return BADGE_OFFSET_PAIR[idx];
    return BADGE_OFFSET_TRIANGLE[idx];
  };
  window.addEventListener("wdl-badge-registry-changed", () => draw());

  // Recomputes which regions currently show an SR badge (enabled + type-on)
  // and publishes that set — NOT called from draw() itself (which runs on
  // every map render) to avoid a publish/redraw loop with base-map.js; only
  // when enabled/types/regions actually change.
  const publishSrRegistry = () => {
    const active = new Set();
    if (enabled) for (const region of regions) if (isTypeOn(region.sr)) active.add(region.id);
    publishBadgeRegions({ sr: active });
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
      if (isOccludedOnGlobe(region.pos)) { g.style.display = "none"; continue; }
      const p = map.project(region.pos);
      if (p.x < -M || p.y < -M || p.x > cw + M || p.y > ch + M) { g.style.display = "none"; continue; }
      const [ox, oy] = badgeOffset("sr", region.id);
      g.setAttribute("transform", `translate(${p.x + ox} ${p.y + oy})`);
      g.style.display = "";
    }
  };

  // ---- load + wiring ----------------------------------------------------
  // region.getRegionsObject's `position` field is NOT reliably the visual
  // center of the region's shape (confirmed live via base-map.js's bunker/
  // base badges landing off to one side) — the real "regions" map source has
  // the actual polygon geometry already loaded client-side (the game fetches
  // it to draw the map itself), so compute a proper area-weighted centroid
  // from that instead and use it in place of the position field wherever
  // available.
  //
  // Shoelace-formula centroid of a single ring (array of [lng,lat] pairs).
  const ringCentroid = (ring) => {
    let area = 0, cx = 0, cy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
      const cross = x0 * y1 - x1 * y0;
      area += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
    area /= 2;
    if (Math.abs(area) < 1e-12) {
      let sx = 0, sy = 0;
      for (const [x, y] of ring) { sx += x; sy += y; }
      return { pos: [sx / ring.length, sy / ring.length], area: 0 };
    }
    return { pos: [cx / (6 * area), cy / (6 * area)], area: Math.abs(area) };
  };
  // A region's geometry can be a MultiPolygon with several disconnected parts
  // — use the centroid of the LARGEST part by area, not an average across
  // all of them, so a small offshore sliver doesn't drag the badge away from
  // the main landmass.
  const regionCentroidFromGeometry = (geometry) => {
    if (!geometry) return null;
    const polygons = geometry.type === "MultiPolygon" ? geometry.coordinates
      : geometry.type === "Polygon" ? [geometry.coordinates] : null;
    if (!polygons) return null;
    let best = null;
    for (const poly of polygons) {
      const outer = poly[0];
      if (!outer || outer.length < 4) continue;
      const c = ringCentroid(outer);
      if (!best || c.area > best.area) best = c;
    }
    return best ? best.pos : null;
  };
  const applyGeometryCentroids = () => {
    try {
      const src = map.getSource("regions");
      const fc = src && (src._options ? src._options.data : src._data);
      const feats = (fc && fc.features) || [];
      const byId = new Map();
      for (const f of feats) {
        const rid = f.properties && f.properties.regionId;
        if (rid) byId.set(rid, f.geometry);
      }
      for (const region of regions) {
        const geometry = byId.get(region.id);
        const centroid = geometry && regionCentroidFromGeometry(geometry);
        if (centroid) region.pos = centroid;
      }
    } catch (err) {
      console.warn("[WSR] geometry centroid computation failed, using region.getRegionsObject position instead", err);
    }
  };

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
      publishSrRegistry();
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
    applyGeometryCentroids();
    buildBadges();
    ready = true;
    publishSrRegistry();
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
