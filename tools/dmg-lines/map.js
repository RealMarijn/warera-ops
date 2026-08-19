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
  try { document.documentElement.dataset.wdlEngine = "0.20.0"; } catch (_) {}
  console.log("[WDL] map.js engine v0.20.0 (multi-window) loaded");

  const CHANNEL = "warera-dmg-lines";
  const NS = "http://www.w3.org/2000/svg";
  const RATE_WINDOW_MS = 60_000;   // sliding window for "damage/min"
  const MAX_LINES = 14;            // cap arcs to avoid clutter, per battle
  const ATT = "#ff5a5a", DEF = "#5aa9ff";
  const WS_URL = "wss://ws.warera.io/connection/websocket"; // WarEra's Centrifugo endpoint

  let map = null;
  let regionPos = {};   // regionId  -> [lng,lat]
  let regionMeta = {};  // regionId  -> { name }
  let countryPos = {};  // countryId -> [lng,lat] (homeland centroid, largest core-territory cluster only)
  let countryMeta = {}; // countryId -> { code, name }
  let countryRegionCount = {};   // countryId -> number of core regions (all of them, not just the main cluster)
  let countryRankByRegionCount = []; // countryIds sorted by countryRegionCount, descending
  let countryRankIndex = new Map();  // countryId -> its index in countryRankByRegionCount (0 = biggest)
  let ready = false;
  let enabled = true;

  // ---- core-country-colors map mode --------------------------------------
  // Colors every region by its ORIGINAL/core country (regions.initialCountryId)
  // instead of whoever currently controls it, reusing WarEra's own per-country
  // colors (read from the "innerCountries" source, which carries the exact
  // same fillColor values as the "countries" source that drives normal
  // current-ownership coloring — confirmed live, not guessed). See
  // ensureCoreColorLayer/applyColorMode below.
  const CORE_LAYER_ID = "wdl-core-region-fill";
  // Layers that show CURRENT ownership — hidden while core-colors mode is on,
  // restored to whatever visibility they actually had (not blindly "visible":
  // WarEra's own alliance-view toggle flips country-fill vs
  // country-fill-alliance, and stomping that on restore would fight the
  // game's own UI state). Includes WarEra's native flag/name labels
  // (country-label, country-alliance-label): those used to be DOM <Marker>
  // elements we could hide with a CSS selector, but WarEra switched them to
  // a MapLibre symbol layer (icon-image: "flag-"+countryCode) at some point
  // — confirmed live, zero .maplibregl-marker elements exist anymore — so
  // hiding them now has to go through setLayoutProperty like everything else
  // here, not CSS.
  const OWNERSHIP_LAYER_IDS = [
    "country-fill", "country-fill-alliance", "inner-country-fill",
    "country-label", "country-alliance-label",
  ];
  let coreColorsEnabled = false;
  let savedOwnershipVisibility = null;

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

  // `map` (found via findMap() above) is a react-map-gl wrapper, NOT a real
  // maplibre-gl Map — confirmed live: it forwards read methods (getSource,
  // project, getLayoutProperty, getLayer, ...) but has no addLayer/
  // setLayoutProperty/addSource of its own (constructor.name is plain
  // "Object", prototype is bare Object.prototype). It does expose .getMap(),
  // which returns the real underlying maplibre-gl Map with the full API —
  // used for anything beyond the wrapper's proven-safe read methods.
  const wdlMap = () => (map && typeof map.getMap === "function") ? map.getMap() : map;

  // ---- globe-mode occlusion (hide markers/lines on the far side) ----------
  // map.project() gives NO signal about occlusion on a globe — confirmed
  // live, a point's antipode projects to the exact same screen position as
  // the point facing the camera dead-on. There's also no public helper for
  // this (searched the real map's full prototype chain, found nothing
  // globe/occlusion-related). What DOES work, confirmed live: round-tripping
  // through unproject(project(point)) always resolves to whichever point is
  // actually VISIBLE at that pixel — you can't click through a globe to the
  // far side — so a big gap between the original point and the round-tripped
  // one means the original was occluded. Confirmed live: ~0deg diff for
  // visible points, jumping to 10+ degrees once a point crosses the true
  // horizon. That horizon is NOT a fixed 90deg-from-center angle (MapLibre's
  // globe camera sits at a finite, zoom-dependent distance, confirmed live
  // by the on-screen radius peaking before 90deg and shrinking again after),
  // which is exactly why this round-trip test is used instead of a fixed
  // angle check — it's correct at any zoom without needing that camera math.
  const OCCLUSION_THRESHOLD_DEG = 1;
  // Every position in this file (countryPos/regionPos/GeoJSON `position`) is
  // a plain [lng,lat] array, but map.unproject() returns a {lng,lat} object —
  // normalize both to the object shape before doing the angle math, or the
  // array side's .lat/.lng reads as undefined and the whole thing silently
  // computes NaN (which a ">" comparison always treats as false — no error,
  // just a check that quietly never fires).
  const toLngLat = (p) => Array.isArray(p) ? { lng: p[0], lat: p[1] } : p;
  const angularDiffDeg = (a, b) => {
    const A = toLngLat(a), B = toLngLat(b);
    const rad = Math.PI / 180;
    const s = Math.sin(A.lat * rad) * Math.sin(B.lat * rad) +
      Math.cos(A.lat * rad) * Math.cos(B.lat * rad) * Math.cos((A.lng - B.lng) * rad);
    return Math.acos(Math.max(-1, Math.min(1, s))) / rad;
  };
  const isGlobeMode = () => {
    try { return wdlMap().getProjection().type === "globe"; } catch (_) { return false; }
  };
  const isOccludedOnGlobe = (lngLat) => {
    if (!isGlobeMode()) return false; // flat map: nothing is ever "behind" it
    const real = wdlMap();
    try {
      const back = real.unproject(real.project(lngLat));
      return angularDiffDeg(lngLat, back) > OCCLUSION_THRESHOLD_DEG;
    } catch (_) {
      return false; // if the check itself fails, fail open rather than hide everything
    }
  };

  // Distance in degrees, antimeridian-aware (a naive |lngA-lngB| would treat
  // lng=179 and lng=-179 as ~358deg apart instead of the true ~2deg — would
  // wrongly split any country whose territory crosses the 180th meridian,
  // e.g. Russia or Fiji, into separate clusters at that seam).
  const CLUSTER_THRESHOLD_DEG = 20;
  const lngLatDist = (a, b) => {
    let dlng = a[0] - b[0];
    if (dlng > 180) dlng -= 360; else if (dlng < -180) dlng += 360;
    return Math.hypot(dlng, a[1] - b[1]);
  };

  // A plain average of a set of positions can land somewhere none of them
  // actually are — e.g. a concave or ring-shaped block averages to a point
  // in the middle that may belong to a different country entirely.
  // Snapping to the real position closest to that average guarantees the
  // marker sits on an actual region that's really part of this group.
  const nearestPosition = (positions, target) => {
    let best = positions[0], bestDist = Infinity;
    for (const p of positions) {
      const d = lngLatDist(p, target);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    return best;
  };

  // A country's territory can include far-flung outliers (e.g. France's South
  // American/overseas territories alongside mainland Europe) — a plain
  // average of every position pulls the centroid to nowhere sensible in
  // between (confirmed live: put France's flag over Libya). Union-find the
  // positions by proximity instead. Returns every cluster found,
  // sorted largest-first, as {pos:[lng,lat], count, positions}.
  const clusterAllBlocks = (positions) => {
    const n = positions.length;
    if (n === 0) return [];
    if (n === 1) return [{ pos: positions[0], count: 1, positions: [positions[0]] }];
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (lngLatDist(positions[i], positions[j]) < CLUSTER_THRESHOLD_DEG) {
          const ri = find(i), rj = find(j);
          if (ri !== rj) parent[ri] = rj;
        }
      }
    }
    const groups = new Map(); // root -> {x,y,n,positions}
    for (let i = 0; i < n; i++) {
      const r = find(i);
      const g = groups.get(r) || { x: 0, y: 0, n: 0, positions: [] };
      g.x += positions[i][0]; g.y += positions[i][1]; g.n++;
      g.positions.push(positions[i]);
      groups.set(r, g);
    }
    return Array.from(groups.values())
      .map((g) => ({ pos: [g.x / g.n, g.y / g.n], count: g.n, positions: g.positions }))
      .sort((a, b) => b.count - a.count);
  };

  // For a single position per entity (country core centroid) — just
  // the largest cluster, so a flag lands on the country's actual main
  // territory rather than a handful of far-flung outliers.
  const clusterCentroid = (positions) => {
    const blocks = clusterAllBlocks(positions);
    if (!blocks.length) return null;
    return nearestPosition(blocks[0].positions, blocks[0].pos);
  };

  // ---- build position/metadata lookups ----------------------------------
  const buildLookups = async () => {
    const src = map.getSource("regions");
    const fc = src && (src._options ? src._options.data : src._data);
    const feats = (fc && fc.features) || [];
    if (!feats.length) return false;

    regionPos = {};
    const positionsByCountry = {}; // initialCountryId -> [[lng,lat], ...]
    for (const f of feats) {
      const p = f.properties;
      if (!p || !p.position) continue;
      if (p.regionId) regionPos[p.regionId] = p.position;
      if (p.initialCountryId) {
        (positionsByCountry[p.initialCountryId] = positionsByCountry[p.initialCountryId] || []).push(p.position);
      }
    }
    countryPos = {};
    countryRegionCount = {};
    for (const cid in positionsByCountry) {
      const positions = positionsByCountry[cid];
      const centroid = clusterCentroid(positions);
      if (centroid) countryPos[cid] = centroid;
      countryRegionCount[cid] = positions.length; // "size" = ALL core regions, not just the main cluster
    }
    countryRankByRegionCount = Object.keys(countryRegionCount)
      .sort((a, b) => countryRegionCount[b] - countryRegionCount[a]);
    countryRankIndex = new Map(countryRankByRegionCount.map((cid, i) => [cid, i]));

    countryMeta = {};
    const list = await trpcNull("country.getAllCountries");
    const arr = Array.isArray(list) ? list : Object.values(list);
    for (const c of arr) if (c && c._id) countryMeta[c._id] = { code: c.code, name: c.name, scheme: c.scheme };

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

  // ---- core-country-colors map mode --------------------------------------
  // countryId -> fillColor, read straight from the "innerCountries" source so
  // we always match whatever palette WarEra is currently rendering with
  // (confirmed live: identical fillColor values to the "countries" source
  // that drives normal current-ownership coloring, just fewer/simpler
  // features) — no hand-maintained color list to go stale. Shared by the
  // fill layer (buildCoreColorExpression) and the flag labels (ensureCoreFlags,
  // which tints this same color for its per-country text accent).
  // scheme -> first fillColor seen for it, from countries that currently
  // hold territory (via "innerCountries", confirmed identical to "countries"'
  // own fillColor values, just fewer/simpler features). Used as a fallback
  // below for a country with zero current territory (no fillColor of its
  // own to read).
  let colorBySchemeCache = null;
  const buildColorByScheme = () => {
    if (colorBySchemeCache) return colorBySchemeCache;
    const src = wdlMap().getSource("innerCountries");
    const fc = src && (src._options ? src._options.data : src._data);
    const feats = (fc && fc.features) || [];
    const colorByCountry = new Map(); // dedupe: innerCountries has more features (202) than countries
    for (const f of feats) {
      const p = f.properties;
      if (p && p.countryId && p.fillColor) colorByCountry.set(p.countryId, p.fillColor);
    }
    const colorByScheme = new Map();
    for (const cid in countryMeta) {
      const scheme = countryMeta[cid].scheme;
      const color = colorByCountry.get(cid);
      if (scheme && color && !colorByScheme.has(scheme)) colorByScheme.set(scheme, color);
    }
    colorBySchemeCache = { colorByCountry, colorByScheme };
    return colorBySchemeCache;
  };

  // countryId -> fillColor for EVERY country (including zero-territory ones,
  // approximated via their scheme — see buildColorByScheme). Shared by the
  // core fill layer (buildCoreColorExpression) and the flag labels
  // (ensureCoreFlags, which tints this same color for its per-country text
  // accent).
  let coreColorByCountryCache = null;
  const buildCountryColorMap = () => {
    if (coreColorByCountryCache) return coreColorByCountryCache;
    const { colorByCountry, colorByScheme } = buildColorByScheme();
    const result = new Map(colorByCountry);
    // A country with ZERO current territory has no feature/color above at
    // all — approximate one from another country sharing the same scheme.
    // Not pixel-exact (confirmed live a scheme usually covers 2-3 distinct
    // shades, not one) but keeps the right hue family instead of black.
    for (const cid in countryMeta) {
      if (result.has(cid)) continue;
      const fallback = colorByScheme.get(countryMeta[cid].scheme);
      if (fallback) result.set(cid, fallback);
    }
    coreColorByCountryCache = result;
    return result;
  };

  const buildCoreColorExpression = () => {
    const expr = ["match", ["get", "initialCountryId"]];
    for (const [cid, color] of buildCountryColorMap()) expr.push(cid, color);
    expr.push("rgba(0,0,0,0)"); // fallback for a region whose initialCountryId isn't in the lookup
    return expr;
  };

  // Lightens a #rrggbb fill color into a bright per-country accent for label
  // text — approximates WarEra's own label color (confirmed live to be a
  // bright tint distinct from the dark region fill, e.g. rgb(148,220,186)
  // for a country whose fill is a dark teal) by mixing toward white. Not the
  // exact algorithm (no public source for it), just a visually-close stand-in.
  const tintColor = (hex, amount) => {
    const n = parseInt(hex.replace("#", ""), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const mix = (c) => Math.round(c * (1 - amount) + 255 * amount);
    return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
  };

  // Adds the (initially hidden) fill layer if it isn't already there, reusing
  // the existing "regions" source's real per-region polygons — no new
  // geometry to fetch or maintain. Inserted directly at country-fill's
  // position so it occupies the same slot in the paint order once shown.
  //
  // Deliberately checks *live* map state (real.getLayer(...)) rather than a
  // remembered "already built" flag — confirmed live that WarEra's own
  // react-map-gl app can silently wipe imperatively-added layers on a style
  // refresh, which a boolean flag would miss (the layer's gone, the flag
  // still says otherwise, and the next setLayoutProperty call throws
  // "non-existing layer"). Cheap to call repeatedly (see applyColorMode's
  // 1s self-heal), so re-checking live is the simple, robust choice here.
  const ensureCoreColorLayer = (real) => {
    if (real.getLayer(CORE_LAYER_ID)) return true;
    try {
      real.addLayer({
        id: CORE_LAYER_ID,
        type: "fill",
        source: "regions",
        paint: { "fill-color": buildCoreColorExpression() },
        layout: { visibility: "none" },
      }, real.getLayer("country-fill") ? "country-fill" : undefined);
      return true;
    } catch (err) {
      console.warn("[WDL] core-colors layer failed to build:", err);
      return false;
    }
  };

  // ---- core-colors flag markers ------------------------------------------
  // WarEra's own on-map country flags used to be real DOM elements (a
  // react-map-gl <Marker>) positioned at the country's CURRENT-territory
  // centroid — confirmed live at the time. WarEra has since moved them into
  // a MapLibre symbol layer instead (country-label / country-alliance-label,
  // icon-image "flag-"+countryCode — see OWNERSHIP_LAYER_IDS above, which is
  // what actually hides them now). Either way we can't reposition WarEra's
  // own flags, and a fully-occupied country doesn't get one at all, so we
  // still draw our own into the same SVG overlay the damage lines already
  // use, positioned at countryPos[cid] — the CORE-territory centroid
  // buildLookups() already computes from initialCountryId, unaffected by
  // conquest, and already covers every country including fully-occupied ones.
  const FLAG_URL = (code) => `https://media.warera.io/images/flags/${code}.svg?v=16`;
  let coreFlagsBuilt = false;

  // Flag size/ratio, border-radius, font, weight and stroke below are copied
  // from WarEra's own native marker (read live via getComputedStyle — see
  // BACKEND_API.md-style diagnostics used to derive this): flag 19x14.25px
  // (exactly 4:3), 2px corner radius, no shadow/filter on the flag itself;
  // label 12px/600 'Saira, system-ui, ...', 2px solid black stroke with
  // paint-order:stroke for legibility. Label COLOR isn't copied exactly — the
  // native one is a bright per-country accent that doesn't match any color
  // field we already fetch, so tintColor() approximates it from the same
  // fillColor the region fill itself uses, rather than chasing an extra
  // unconfirmed field for a purely cosmetic detail.
  const FLAG_FONT = "Saira, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', " +
    "Roboto, 'Helvetica Neue', Arial, sans-serif";

  const ensureCoreFlags = () => {
    if (coreFlagsBuilt || !gCoreFlags) return;
    const colorByCountry = buildCountryColorMap();
    for (const cid in countryPos) {
      const meta = countryMeta[cid];
      if (!meta || !meta.code) continue;
      const g = document.createElementNS(NS, "g");
      g.setAttribute("data-cid", cid);
      const img = document.createElementNS(NS, "image");
      img.setAttribute("href", FLAG_URL(meta.code));
      img.setAttribute("width", "19");
      img.setAttribute("height", "14.25");
      img.setAttribute("x", "-9.5");    // center on its projected point
      img.setAttribute("y", "-7.125");
      img.style.borderRadius = "2px";
      const label = document.createElementNS(NS, "text");
      label.textContent = meta.name || "";
      label.setAttribute("x", "0");
      label.setAttribute("y", "17"); // just below the flag
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("font-size", "12");
      label.setAttribute("font-family", FLAG_FONT);
      label.setAttribute("font-weight", "600");
      const fillColor = colorByCountry.get(cid);
      label.setAttribute("fill", fillColor ? tintColor(fillColor, 0.65) : "#fff");
      label.style.paintOrder = "stroke";
      label.style.stroke = "#000";
      label.style.strokeWidth = "2px";
      label.style.strokeLinejoin = "round";
      g.appendChild(img);
      g.appendChild(label);
      gCoreFlags.appendChild(g);
    }
    coreFlagsBuilt = true;
  };

  // Showing all ~180 countries' flags at once is unreadable once zoomed out
  // (WarEra's own map has the same problem and solves it the same way: hide
  // smaller countries first, more of them as you zoom out further). "Size"
  // is core region count, per the user's own description of the native
  // behavior. Linear ramp between ZOOM_FEWEST_FLAGS (only the biggest
  // MIN_FLAGS_SHOWN countries) and ZOOM_ALL_FLAGS (everyone shown) — approximate,
  // tuned by eye rather than reverse-engineered from WarEra's own thresholds.
  const ZOOM_FEWEST_FLAGS = 1;
  const ZOOM_ALL_FLAGS = 4.5;
  const MIN_FLAGS_SHOWN = 8;
  // Takes the rank array to use (core vs current-territory ranking — see
  // the two modes below), so both can share this same ramp logic.
  const visibleFlagCount = (rankArray) => {
    const total = rankArray.length;
    if (!total) return 0;
    const zoom = map.getZoom();
    if (zoom >= ZOOM_ALL_FLAGS) return total;
    if (zoom <= ZOOM_FEWEST_FLAGS) return Math.min(total, MIN_FLAGS_SHOWN);
    const frac = (zoom - ZOOM_FEWEST_FLAGS) / (ZOOM_ALL_FLAGS - ZOOM_FEWEST_FLAGS);
    return Math.round(MIN_FLAGS_SHOWN + frac * (total - MIN_FLAGS_SHOWN));
  };

  const repositionCoreFlags = () => {
    if (!gCoreFlags || gCoreFlags.style.display === "none") return;
    const visibleCount = visibleFlagCount(countryRankByRegionCount);
    for (const g of gCoreFlags.children) {
      const cid = g.getAttribute("data-cid");
      const pos = countryPos[cid];
      if (!pos) continue;
      const rank = countryRankIndex.get(cid);
      if (rank !== undefined && rank >= visibleCount) { g.style.display = "none"; continue; }
      if (isOccludedOnGlobe(pos)) { g.style.display = "none"; continue; }
      g.style.display = "";
      const p = map.project(pos);
      g.setAttribute("transform", `translate(${p.x},${p.y})`);
    }
  };

  // ---- shared dispatcher for core-country-colors -------------------------
  // Idempotent and self-healing — safe to call any time (setCoreColorsEnabled
  // may fire before start() has finished, and it's also called every second
  // from the draw loop below to recover if WarEra's app wipes our layer).
  const applyColorMode = () => {
    if (!map || !ready) return;
    const real = wdlMap();
    if (!real) return;

    if (coreColorsEnabled) {
      const built = ensureCoreColorLayer(real);
      if (!built) return; // leave ownership layers alone
      if (!savedOwnershipVisibility) {
        savedOwnershipVisibility = {};
        for (const id of OWNERSHIP_LAYER_IDS) {
          if (real.getLayer(id)) savedOwnershipVisibility[id] = real.getLayoutProperty(id, "visibility") || "visible";
        }
      }
      for (const id of OWNERSHIP_LAYER_IDS) {
        if (real.getLayer(id)) real.setLayoutProperty(id, "visibility", "none");
      }
      if (real.getLayer(CORE_LAYER_ID)) real.setLayoutProperty(CORE_LAYER_ID, "visibility", "visible");
      ensureCoreFlags();
      gCoreFlags.style.display = "";
      repositionCoreFlags();
    } else {
      if (real.getLayer(CORE_LAYER_ID)) real.setLayoutProperty(CORE_LAYER_ID, "visibility", "none");
      if (savedOwnershipVisibility) {
        for (const id of OWNERSHIP_LAYER_IDS) {
          if (real.getLayer(id)) real.setLayoutProperty(id, "visibility", savedOwnershipVisibility[id]);
        }
        savedOwnershipVisibility = null;
      }
      if (gCoreFlags) gCoreFlags.style.display = "none";
    }
  };

  const setCoreColorsEnabled = (on) => {
    coreColorsEnabled = !!on;
    applyColorMode();
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
  let svg, gAllArcs, gAllNodes, defsEl, gCoreFlags;
  const battleDraw = new Map(); // battleId -> { gArcs, gNodes, arcEls: Map<countryId,{...}> }

  // The game's battle icons (the "battle-pin"/"region-battle-dot" map layers) are drawn ON the
  // WebGL map canvas, so no z-index can place our SVG lines between the terrain and those pins —
  // the lines always ended up on top of the pins. Instead we cut soft holes out of the ribbons
  // wherever a battle pin sits (via an SVG mask), so the lines read as passing BEHIND the pins.
  let pinHoles = null;       // <g> of mask discs (one per visible battle pin)
  const pinCircles = [];     // pooled <circle> elements, reused across frames
  let pinCoords = [];        // [lng,lat] of every visible battle pin (refreshed on a throttle)
  let lastPinQuery = 0;
  const PIN_MASK_R = 17;     // radius (px) of the hole cut around each pin — tune to the icon size

  // ---- "by country" mode: pick a country, draw a line to every active battle it deals damage in.
  // Damage per battle comes from battleRanking.getRanking(type:"country", side:"merged"), which lists
  // EVERY contributing country (attacker, defender, allies, mercs) — so this catches a country's
  // damage even in battles it isn't a belligerent of. Two refresh tiers keep the cost sane:
  //   - fast (10s): re-poll only the battles where the country is attacker/defender (cheap, a few).
  //   - full (30s): re-poll ALL active battles to (re)discover merc/ally involvement (~1 call each).
  // The active-battle index (region + the two side countries per battle) is rebuilt less often still.
  const COUNTRY_COLOR = "#ffcc44";
  const COUNTRY_FAST_MS = 10000;
  const COUNTRY_FULL_MS = 30000;
  const COUNTRY_INDEX_MS = 90000;
  const RANK_CONCURRENCY = 6;    // cap simultaneous ranking fetches during a scan
  let gCountryArcs, gCountryNodes;
  const countryArcEls = new Map();      // battleId -> { path, grad, s0, s1 }
  let countryNode = null;               // { halo, core } origin marker at the selected country
  let countrySel = null;                // selected countryId, or null (mode off)
  const countryTargets = new Map();     // battleId -> { region, damage } (only where damage > 0)
  const PULSE_MS = 5000;                // how long a line pulses after its battle's damage changes
  const countryPrevDmg = new Map();     // battleId -> last-seen damage (to detect a change)
  const countryPulseUntil = new Map();  // battleId -> timestamp until which its line pulses
  const activeBattleIndex = new Map();  // battleId -> { region, att, def }
  let countryFastTimer = null, countryFullTimer = null, countryIndexTimer = null;

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
    // Soft-edged radial hole used by the pin mask (solid black core -> white/visible edge, so the
    // ribbon fades out around each battle pin instead of a hard circular cut).
    const rg = document.createElementNS(NS, "radialGradient");
    rg.id = "wdl-pinhole";
    const mk = (off, col) => { const s = document.createElementNS(NS, "stop"); s.setAttribute("offset", off); s.setAttribute("stop-color", col); return s; };
    rg.append(mk("0", "#000"), mk("0.6", "#000"), mk("1", "#fff"));
    defsEl.appendChild(rg);
    // The mask itself: a big white backdrop (everything visible) with black holes punched at pins.
    const pinMask = document.createElementNS(NS, "mask");
    pinMask.id = "wdl-pinmask";
    pinMask.setAttribute("maskUnits", "userSpaceOnUse");
    pinMask.setAttribute("maskContentUnits", "userSpaceOnUse");
    const bg = document.createElementNS(NS, "rect");
    bg.setAttribute("x", "-100000"); bg.setAttribute("y", "-100000");
    bg.setAttribute("width", "200000"); bg.setAttribute("height", "200000");
    bg.setAttribute("fill", "#fff");
    pinHoles = document.createElementNS(NS, "g");
    pinMask.append(bg, pinHoles);
    defsEl.appendChild(pinMask);
    // Gentle breathing glow on live origin markers (see .wdl-live-halo toggle in updateBattleDraw()).
    const st = document.createElementNS(NS, "style");
    st.textContent =
      "@keyframes wdl-pulse{0%,100%{opacity:.5}50%{opacity:1}}" +
      "#wdl-map-lines .wdl-live-halo{animation:wdl-pulse 1.6s ease-in-out infinite}" +
      "@keyframes wdl-cpulse{0%,100%{opacity:1}50%{opacity:.28}}" +
      "#wdl-map-lines .wdl-cpulse{animation:wdl-cpulse .8s ease-in-out infinite}";
    svg.appendChild(st);
    gAllArcs = document.createElementNS(NS, "g");
    gAllArcs.setAttribute("mask", "url(#wdl-pinmask)"); // ribbons pass behind the on-canvas battle pins
    svg.appendChild(gAllArcs);
    gCountryArcs = document.createElementNS(NS, "g"); // "by country" ribbons (own layer)
    gCountryArcs.setAttribute("mask", "url(#wdl-pinmask)"); // also pass behind the battle pins
    svg.appendChild(gCountryArcs);
    gAllNodes = document.createElementNS(NS, "g"); // origin markers, painted above ALL ribbons
    svg.appendChild(gAllNodes);
    gCountryNodes = document.createElementNS(NS, "g"); // "by country" origin marker, above its ribbons
    svg.appendChild(gCountryNodes);
    gCoreFlags = document.createElementNS(NS, "g"); // core-country-colors flag markers, above everything else
    gCoreFlags.style.display = "none";
    svg.appendChild(gCoreFlags);
    // Inject INTO the map container so the lines share the map's stacking context and fall behind
    // the app UI. Fall back to a fixed full-viewport overlay only if the container is unavailable.
    // z-index 10 (not this codebase's old go-to of "near-max-int") — WarEra's own floating chat
    // window sits at z-index 15 (per its bundled CSS), so this needs to stay under that or a
    // full-viewport fallback overlay would cover the chat, same reasoning as overlay.js's Z_BASE.
    const container = (map && typeof map.getContainer === "function" && map.getContainer()) || document.body;
    if (container === document.body) { svg.style.position = "fixed"; svg.style.zIndex = "10"; }
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

  // ---- globe-mode arcs: hug the sphere instead of cutting through it ------
  // ribbonPath() above draws a 2D bezier between the two PROJECTED screen
  // points — fine on a flat map, but on the globe two points on the visible
  // (near-camera) surface project to screen positions such that a straight-
  // ish 2D curve between them visually dips below the sphere's curvature,
  // reading as if the line goes "through" the globe instead of over its
  // surface (confirmed by the user, worse the further apart the two
  // countries are). Fix: sample points along the actual GREAT-CIRCLE path
  // on the sphere surface (via spherical interpolation in lng/lat, not
  // screen space) and project EACH sample individually — every point is
  // then genuinely on the sphere, so the resulting on-screen curve follows
  // its true visible silhouette.
  const GLOBE_ARC_SAMPLES = 20;
  const lngLatToVec3 = (lngLat) => {
    const { lng, lat } = toLngLat(lngLat);
    const lngR = lng * Math.PI / 180, latR = lat * Math.PI / 180;
    const cosLat = Math.cos(latR);
    return [cosLat * Math.cos(lngR), cosLat * Math.sin(lngR), Math.sin(latR)];
  };
  const vec3ToLngLat = ([x, y, z]) => [
    Math.atan2(y, x) * 180 / Math.PI,
    Math.asin(Math.max(-1, Math.min(1, z))) * 180 / Math.PI,
  ];
  // Spherical linear interpolation ("slerp") between two [lng,lat] points —
  // the great-circle equivalent of a straight-line lerp, needed because a
  // plain lng/lat lerp doesn't follow the sphere surface (it cuts corners
  // near the poles/antimeridian the same way a flat lerp would on a globe).
  const slerpLngLat = (A, B, t) => {
    const a = lngLatToVec3(A), b = lngLatToVec3(B);
    const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    const theta = Math.acos(dot);
    if (theta < 1e-6) return A; // coincident (or effectively so) — nothing to interpolate
    const sinTheta = Math.sin(theta);
    const wa = Math.sin((1 - t) * theta) / sinTheta, wb = Math.sin(t * theta) / sinTheta;
    return vec3ToLngLat([a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb]);
  };
  // Same tapered-ribbon shape as ribbonPath, but built from real projected
  // points along the great circle (A/B here are [lng,lat], not screen {x,y}).
  const ribbonPathGlobe = (A, B, wMax) => {
    const real = wdlMap();
    const pts = [];
    for (let i = 0; i <= GLOBE_ARC_SAMPLES; i++) {
      const t = i / GLOBE_ARC_SAMPLES;
      const p = real.project(slerpLngLat(A, B, t));
      pts.push({ x: p.x, y: p.y, t });
    }
    let left = "", right = "";
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i], prev = pts[i - 1] || cur, next = pts[i + 1] || cur;
      const tx = next.x - prev.x, ty = next.y - prev.y;
      const tl = Math.hypot(tx, ty) || 1;
      const ux = -ty / tl, uy = tx / tl;
      const w = (2.4 + Math.pow(cur.t, 1.4) * wMax) / 2;
      left += (i ? " L " : "M ") + (cur.x + ux * w) + " " + (cur.y + uy * w);
      right = " L " + (cur.x - ux * w) + " " + (cur.y - uy * w) + right;
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
    // Globe mode: the region itself may be on the far side right now. Battle
    // state (rates/totals) keeps updating either way — only the drawing is
    // affected — so this doesn't short-circuit like the !target case above,
    // it just feeds into `show` in draw() below.
    const targetOccluded = isOccludedOnGlobe(target);

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
      // On the globe, a 2D screen-space bezier between the two projected
      // points cuts across the visible disk instead of following the
      // sphere's curvature — sample the real great-circle path instead (see
      // ribbonPathGlobe). Flat/mercator mode keeps the existing 2D bezier,
      // which already looks right there and is cheaper to compute.
      e.path.setAttribute("d", isGlobeMode() ? ribbonPathGlobe(r.pos, target, wMax) : ribbonPath(cp, tp, wMax));
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

      // Globe mode: hide this one arc if ITS source is on the far side, even
      // while the target region (and other countries' arcs) stay visible.
      // Group-level hiding for a fully-occluded target happens in draw()
      // (via targetOccluded below) — element-level display:none here isn't
      // clobbered by that, since a hidden child stays hidden regardless of
      // its parent's own display value.
      const hideArc = targetOccluded || isOccludedOnGlobe(r.pos);
      e.path.style.display = hideArc ? "none" : "";
      e.halo.style.display = hideArc ? "none" : "";
      e.core.style.display = hideArc ? "none" : "";
    }
    // remove this battle's arcs no longer shown
    for (const [cid, e] of bd.arcEls) {
      if (!live.has(cid)) { e.path.remove(); e.grad.remove(); e.halo.remove(); e.core.remove(); bd.arcEls.delete(cid); }
    }

    return { active: true, header: b.header, totals, countries: shown, targetOccluded };
  };

  // Keep the pin-mask holes on top of the game's battle pins. The pins are static in geo space, so
  // we only re-query their positions on a throttle, but reproject them every frame (they move as the
  // map pans/zooms). If the "battle-pin" layer doesn't exist (older game build), the holes stay empty
  // and the mask is a no-op — ribbons render exactly as before.
  const updatePinMask = () => {
    if (!pinHoles) return;
    const real = wdlMap();
    if (!real || typeof real.project !== "function") return;
    const now = Date.now();
    if (now - lastPinQuery > 300) {
      lastPinQuery = now;
      try {
        const feats = real.queryRenderedFeatures({ layers: ["battle-pin"] });
        pinCoords = feats.map((f) => f && f.geometry && f.geometry.coordinates).filter(Boolean);
      } catch (_) { /* layer absent — leave pinCoords as-is / empty */ }
    }
    for (let i = 0; i < pinCoords.length; i++) {
      let c = pinCircles[i];
      if (!c) {
        c = document.createElementNS(NS, "circle");
        c.setAttribute("r", String(PIN_MASK_R));
        c.setAttribute("fill", "url(#wdl-pinhole)");
        pinHoles.appendChild(c);
        pinCircles[i] = c;
      }
      const p = real.project(pinCoords[i]);
      c.setAttribute("cx", p.x);
      c.setAttribute("cy", p.y);
      c.style.display = "";
    }
    for (let i = pinCoords.length; i < pinCircles.length; i++) pinCircles[i].style.display = "none";
  };

  // ---- "by country" mode ------------------------------------------------
  const mapLimit = async (arr, limit, fn) => {
    const out = [];
    let i = 0;
    const worker = async () => { while (i < arr.length) { const idx = i++; out[idx] = await fn(arr[idx]); } };
    await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, worker));
    return out;
  };

  const buildActiveBattleIndex = async () => {
    let grouped;
    try { grouped = await trpcRaw("battle.getGroupedActiveBattles", {}); } catch (_) { return; }
    const g = (grouped && grouped.json) || grouped || {};
    const ids = new Set();
    for (const k in g) if (Array.isArray(g[k])) for (const id of g[k]) if (typeof id === "string") ids.add(id);
    const list = [...ids].slice(0, 80); // cap the getById fan-out
    await mapLimit(list, RANK_CONCURRENCY, async (id) => {
      try {
        const d = await trpcRaw("battle.getById", { battleId: id });
        const region = d && d.defender && d.defender.region;
        if (region) activeBattleIndex.set(id, {
          region,
          att: d.attacker && d.attacker.country,
          def: d.defender && d.defender.country,
        });
      } catch (_) {}
    });
    for (const id of [...activeBattleIndex.keys()]) if (!ids.has(id)) activeBattleIndex.delete(id);
  };

  // The selected country's damage in one battle (merged ranking lists every country on both sides).
  const fetchCountryDamage = async (battleId, cid) => {
    try {
      const d = await trpcRaw("battleRanking.getRanking", { battleId, type: "country", dataType: "damage", side: "merged" });
      const items = (d && d.items) || [];
      const row = items.find((x) => x.country === cid);
      return row ? (row.value || 0) : 0;
    } catch (_) { return 0; }
  };

  const applyScan = (sel, results) => {
    if (sel !== countrySel) return; // selection changed mid-scan — drop stale results
    const now = Date.now();
    let pulsed = false;
    for (const { id, dmg } of results) {
      const idx = activeBattleIndex.get(id);
      if (dmg > 0 && idx) {
        const prev = countryPrevDmg.get(id);
        countryTargets.set(id, { region: idx.region, damage: dmg });
        // Pulse only on a real increase from a known previous value — not on first discovery
        // (that would flash every line at once and mean nothing).
        if (prev !== undefined && dmg > prev) { countryPulseUntil.set(id, now + PULSE_MS); pulsed = true; }
        countryPrevDmg.set(id, dmg);
      } else {
        countryTargets.delete(id);
        countryPrevDmg.delete(id);
        countryPulseUntil.delete(id);
      }
    }
    drawCountry();
    postCountrySummary();
    // The map may be idle (no render frames) — make sure the pulse class gets cleared after 5s.
    if (pulsed) setTimeout(() => { if (sel === countrySel) drawCountry(); }, PULSE_MS + 150);
  };

  const countryFullScan = async () => {
    const sel = countrySel;
    if (!sel) return;
    const ids = [...activeBattleIndex.keys()];
    const results = await mapLimit(ids, RANK_CONCURRENCY, async (id) => ({ id, dmg: await fetchCountryDamage(id, sel) }));
    applyScan(sel, results);
  };

  const countryFastScan = async () => {
    const sel = countrySel;
    if (!sel) return;
    const ids = [...activeBattleIndex.entries()].filter(([, idx]) => idx.att === sel || idx.def === sel).map(([id]) => id);
    const results = await mapLimit(ids, RANK_CONCURRENCY, async (id) => ({ id, dmg: await fetchCountryDamage(id, sel) }));
    applyScan(sel, results);
  };

  const stopCountryTimers = () => {
    for (const t of [countryFastTimer, countryFullTimer, countryIndexTimer]) if (t) clearInterval(t);
    countryFastTimer = countryFullTimer = countryIndexTimer = null;
  };
  const startCountryTimers = async () => {
    stopCountryTimers();
    await buildActiveBattleIndex();
    if (!countrySel) return; // deselected while the index built
    countryFullScan();
    countryFastTimer = setInterval(countryFastScan, COUNTRY_FAST_MS);
    countryFullTimer = setInterval(countryFullScan, COUNTRY_FULL_MS);
    countryIndexTimer = setInterval(async () => { await buildActiveBattleIndex(); }, COUNTRY_INDEX_MS);
  };

  const sendCountryList = () => {
    const countries = Object.keys(countryMeta)
      .filter((cid) => countryPos[cid]) // only ones we can anchor a line from
      .map((cid) => ({ cid, name: countryMeta[cid].name || "?", code: countryMeta[cid].code || "" }))
      .sort((a, b) => a.name.localeCompare(b.name));
    window.postMessage({ __wdl: CHANNEL, kind: "countryList", countries }, location.origin);
  };

  const postCountrySummary = () => {
    const targets = countrySel
      ? [...countryTargets.entries()]
          .map(([, t]) => ({ regionName: (regionMeta[t.region] && regionMeta[t.region].name) || null, damage: t.damage }))
          .sort((a, b) => b.damage - a.damage)
      : [];
    window.postMessage({
      __wdl: CHANNEL, kind: "countrySummary",
      countryId: countrySel,
      name: countrySel ? ((countryMeta[countrySel] && countryMeta[countrySel].name) || "?") : null,
      targets, total: targets.reduce((s, t) => s + t.damage, 0),
    }, location.origin);
  };

  const selectCountry = (cid) => {
    countrySel = cid || null;
    countryTargets.clear();
    countryPrevDmg.clear();
    countryPulseUntil.clear();
    drawCountry();
    postCountrySummary();
    if (countrySel) startCountryTimers();
    else stopCountryTimers();
  };

  const makeCountryArc = (battleId) => {
    const grad = document.createElementNS(NS, "linearGradient");
    grad.setAttribute("gradientUnits", "userSpaceOnUse");
    grad.id = "wdlcg-" + battleId;
    const s0 = document.createElementNS(NS, "stop"); s0.setAttribute("offset", "0");
    const s1 = document.createElementNS(NS, "stop"); s1.setAttribute("offset", "1");
    grad.append(s0, s1);
    defsEl.appendChild(grad);
    const path = document.createElementNS(NS, "path");
    path.setAttribute("fill", `url(#${grad.id})`);
    path.setAttribute("stroke", "none");
    gCountryArcs.appendChild(path);
    return { path, grad, s0, s1 };
  };

  const drawCountry = () => {
    if (!gCountryArcs) return;
    const origin = countrySel && countryPos[countrySel];
    if (!enabled || !origin) {
      gCountryArcs.style.display = "none";
      if (gCountryNodes) gCountryNodes.style.display = "none";
      return;
    }
    gCountryArcs.style.display = "";
    gCountryNodes.style.display = "";
    const op = map.project(origin);
    const originOcc = isOccludedOnGlobe(origin);
    const entries = [...countryTargets.entries()];
    const maxD = Math.max(1, ...entries.map(([, t]) => t.damage));
    const live = new Set();
    for (const [battleId, t] of entries) {
      const rp = regionPos[t.region];
      if (!rp) continue;
      live.add(battleId);
      let e = countryArcEls.get(battleId);
      if (!e) { e = makeCountryArc(battleId); countryArcEls.set(battleId, e); }
      const tp = map.project(rp);
      const wMax = 4 + (t.damage / maxD) * 30;
      e.path.setAttribute("d", isGlobeMode() ? ribbonPathGlobe(origin, rp, wMax) : ribbonPath(op, tp, wMax));
      e.grad.setAttribute("x1", op.x); e.grad.setAttribute("y1", op.y);
      e.grad.setAttribute("x2", tp.x); e.grad.setAttribute("y2", tp.y);
      e.s0.setAttribute("stop-color", COUNTRY_COLOR); e.s0.setAttribute("stop-opacity", "0.30");
      e.s1.setAttribute("stop-color", COUNTRY_COLOR); e.s1.setAttribute("stop-opacity", "0.95");
      e.path.style.display = (originOcc || isOccludedOnGlobe(rp)) ? "none" : "";
      e.path.classList.toggle("wdl-cpulse", (countryPulseUntil.get(battleId) || 0) > Date.now());
    }
    for (const [battleId, e] of countryArcEls) {
      if (!live.has(battleId)) { e.path.remove(); e.grad.remove(); countryArcEls.delete(battleId); }
    }
    // origin node at the selected country
    if (!countryNode) {
      const halo = document.createElementNS(NS, "circle"); halo.setAttribute("stroke", "none");
      halo.setAttribute("fill", COUNTRY_COLOR); halo.setAttribute("fill-opacity", "0.22");
      const core = document.createElementNS(NS, "circle"); core.setAttribute("stroke", "#fff");
      core.setAttribute("stroke-width", "1.25"); core.setAttribute("fill", COUNTRY_COLOR);
      gCountryNodes.append(halo, core);
      countryNode = { halo, core };
    }
    const showNode = !originOcc;
    for (const c of [countryNode.halo, countryNode.core]) c.style.display = showNode ? "" : "none";
    countryNode.core.setAttribute("cx", op.x); countryNode.core.setAttribute("cy", op.y); countryNode.core.setAttribute("r", "6");
    countryNode.halo.setAttribute("cx", op.x); countryNode.halo.setAttribute("cy", op.y); countryNode.halo.setAttribute("r", "15");
  };

  const draw = (doPost) => {
    if (!ready || !svg) return;
    updatePinMask();
    drawCountry();
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
        const show = enabled && snap.active && battleId === activeBattleId && !snap.targetOccluded;
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
    const order = ["favorites", "yourCountry", "orders", "enemy", "withBounty", "allies", "other", "tournament"];
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
    else if (d.kind === "config") {
      enabled = d.enabled !== false;
      if (!enabled) stopCountryTimers(); else if (countrySel) startCountryTimers();
      draw(true);
    }
    else if (d.kind === "registerPanel") registerPanel(d.panelId);
    else if (d.kind === "unregisterPanel") unregisterPanel(d.panelId);
    else if (d.kind === "selectBattle") selectBattle(d.panelId, d.battleId || null);
    else if (d.kind === "setActivePanel") setActivePanel(d.panelId);
    else if (d.kind === "requestBattleList") buildBattleList();
    else if (d.kind === "requestCountryList") sendCountryList();
    else if (d.kind === "selectCountry") selectCountry(d.countryId || null);
    else if (d.kind === "coreColors") setCoreColorsEnabled(d.enabled);
  });

  const start = async () => {
    ensureSvg();
    try { ready = await buildLookups(); } catch (_) { ready = false; }
    if (!ready) { setTimeout(start, 1500); return; }
    map.on("render", () => { draw(false); repositionCoreFlags(); });   // reproject only
    setInterval(() => {
      draw(true);           // refresh rates + push summaries
      if (coreColorsEnabled) applyColorMode(); // self-heal if WarEra's app wiped our layer
    }, 1000);
    draw(true);
    applyColorMode(); // picks up a toggle message that may have arrived before we were ready
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
