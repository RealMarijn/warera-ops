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
//   -> {kind:"summary", panelId, ..., header, history}   per-panel per-country totals + timeline
//   -> {kind:"battleList", battles}             active battles for the picker
//   -> {kind:"battlePageOpened", battleId}      current /battle/<id>, or null off a battle page
// Proxy-country overlay (whitelisted, see overlay.js's backend polling):
//   overlay  -> {kind:"proxyConfig", enabled}         user toggle, gates the layer below
//   overlay  -> {kind:"proxyData", data}               { [countryId]: {o, r} }, proxies only — see BACKEND_API.md
//
// Pipeline: lasthit -> resolve user's country (cached) -> aggregate per country ->
// project country + region centroid -> draw/update arcs, per watched battle. The
// game tap (hook.js, fired by opening a battle page) is received but ignored on
// purpose — nothing is drawn until a battle is picked in some panel's picker.
(() => {
  "use strict";
  if (window.top !== window) return;
  try { document.documentElement.dataset.wdlEngine = "0.43.2"; } catch (_) {}
  console.log("[WDL] map.js engine v0.43.2 (multi-window) loaded");

  const CHANNEL = "warera-dmg-lines";
  const NS = "http://www.w3.org/2000/svg";
  const RATE_WINDOW_MS = 60_000;   // sliding window for "damage/min"
  const MAX_LINES = 14;            // cap arcs to avoid clutter, per battle
  const HISTORY_BUCKET_MS = 30_000; // bucket size for the panels' damage-over-time timeline chart
  const ATT = "#ff5a5a", DEF = "#5aa9ff";
  const WS_URL = "wss://ws.warera.io/connection/websocket"; // WarEra's Centrifugo endpoint

  let map = null;
  let regionPos = {};   // regionId  -> [lng,lat]
  let regionMeta = {};  // regionId  -> { name }
  let countryPos = {};  // countryId -> [lng,lat] (homeland centroid, largest core-territory cluster only)
  let countryMeta = {}; // countryId -> { code, name }
  // countryId (CURRENT owner, region.countryId — not initialCountryId) -> [[lng,lat], ...] of every
  // region it currently holds. Used by the war-priority overlay to anchor an arrow at whichever of a
  // country's OWN regions is actually closest to the other side, instead of the country's overall
  // centroid — a country spanning a big area would otherwise draw a needlessly long/misleading line.
  let currentRegionsByCountry = {};
  let countryRegionCount = {};   // countryId -> number of core regions (all of them, not just the main cluster)
  let countryRankByRegionCount = []; // countryIds sorted by countryRegionCount, descending
  let countryRankIndex = new Map();  // countryId -> its index in countryRankByRegionCount (0 = biggest)
  // MU metadata for the "Country damage" window's MU mode (see fetchAllMus below) — muId -> { name, countryId }.
  // Unlike countryMeta this is fetched lazily (only once a window actually switches to "mu" mode), since
  // it takes ~14 paginated requests for ~1300 MUs vs. country.getAllCountries' single cheap call.
  let muMeta = {};
  let muListState = "idle"; // "idle" | "loading" | "ready"
  let ready = false;
  let enabled = true;
  // Last-seen URL path, used to detect navigating to a battle page (clicking a battle pin on the
  // map navigates the SPA there without a full reload — see the pathname watcher in start() below).
  // Initialized at content-script injection time (not inside start()), so loading directly on a
  // battle page doesn't itself look like "just navigated there".
  let lastNavPath = location.pathname;

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

  // ---- capitals & unlinked regions overlay ---------------------------------
  // isCapital/isLinkedToCapital come straight off the same region.getRegionsObject fetch
  // buildLookups() already does for region names — see there — so this costs nothing extra over
  // the network. Not whitelist-gated: plain WarEra data, same trust level as core colors below.
  // Mutually exclusive with core-country-colors (see setRegionStatusEnabled/setCoreColorsEnabled),
  // enforced both at the popup UI level (menu.js) and re-checked here — this used to also matter
  // because both features recolored the "regions" source, but this one dropped its fill tint (read
  // as confusing) and is icon-only now; kept mutually exclusive anyway rather than re-litigating it.
  // Abstract shapes instead of emoji — a star silhouette (WarEra's own capital-icon path, confirmed
  // live on a region page) and, for "unlinked", two open rings with a gap between them rather than
  // a literal chain-link/broken-heart emoji.
  const CAPITAL_ICON_PATH = "M12,17.27L18.18,21L16.54,13.97L22,9.24L14.81,8.62L12,2L9.19,8.62L2,9.24L7.45,13.97L5.82,21L12,17.27Z";
  const CAPITAL_ICON_FILL = "#ffd23f";
  const CAPITAL_ICON_STROKE = "#5a3d00";
  const UNLINKED_ICON_STROKE = "#ffffff"; // bright, so it still reads against the darker fill above
  let regionStatusEnabled = false;
  let gRegionStatusIcons = null;

  // ---- proxy-country overlay ----------------------------------------------
  // Whitelisted feature: a country whose current citizenry is dominated by
  // immigrants from another ("origin") country is effectively that origin's
  // puppet. When enabled, a small marker is added beside a proxy country's
  // own (native) flag showing its origin's flag — using the same per-country
  // flag machinery as core-country-colors above (FLAG_URL). An earlier
  // version also recolored the proxy's regions to the origin's color, but
  // that fill layer painted over region borders and WarEra's own flag icons
  // (it sits above everything in the layer stack — see the flags this
  // replaces) — dropped for now, flags-only.
  // proxyData/enabled are pushed from overlay.js, which owns the whitelist
  // check and backend polling (this MAIN-world script has no chrome.* access).
  let proxyEnabled = false;
  let proxyData = {}; // countryId -> { o: originCountryId, r: rate }, PROXY countries only (BACKEND_API.md's short field names, straight from the wire)

  // ---- war-priority overlay -----------------------------------------------
  // Winning a battle in a war grants that country 24h "priority" over the other side (only the
  // priority holder can start the next battle in that war). Not whitelisted/backend-involved at
  // all — war.getPaginatedWars is a plain WarEra API call, same trust level as battle.getById.
  // No global "all wars" endpoint exists though: it's scoped to one countryId per call, so this
  // scans every country's own war list (like buildActiveBattleIndex does for battles) — see
  // scanAllWarPriorities. Client-side only, driven entirely by warPriorityEnabled below (relayed
  // from overlay.js's popup toggle, same "config" message pattern as coreColorsEnabled).
  const WAR_PRIORITY_COLOR = "#c25f35"; // WarEra's own accent for a priority-holder's flag ring (confirmed live)
  const WAR_PRIORITY_POLL_MS = 10 * 60 * 1000; // matches base/bunker/proxy cadence — a ~200-country fan-out isn't cheap
  const WAR_CONCURRENCY = 8;
  let warPriorityEnabled = false;
  let warPriorityTimer = null;
  let warPriorityScanInFlight = false;
  // warId -> { priorityCid, otherCid, priorityEndAt (ms) } — only entries with a currently
  // unexpired priorityEndAt are kept (see fetchCountryWarPriorities); a war whose priority has
  // lapsed since the last scan is filtered again at draw time too (see drawWarPriority).
  const activeWarPriorities = new Map();

  // battleId -> { region, meta, header, countries: Map<countryId,{side,total,events:[{t,dmg}]}> }
  const battles = new Map();

  // panelId -> battleId|null. Every open overlay window (panel) independently picks a battle;
  // several panels may watch the same battle. Populated by registerPanel/selectBattle.
  const panelBattle = new Map();
  // Which panel's battle is currently drawn on the map. Whichever window the user clicked last.
  let activePanelId = null;
  // Mutually exclusive with activePanelId's tracker-battle lines: the panelId of whichever "Country
  // damage" window was last clicked (or null), in which case IT is what draws lines on the map (see
  // drawCountry()) instead of any tracker panel. See the countryPanels declaration further down for
  // per-window "by country" state.
  let activeCountryPanelId = null;
  // wdlCountryEnabled — independent of `enabled` (wdlEnabled, the tracker windows' own toggle): the
  // "Country damage" feature must keep working (windows visible, lines drawable, polling running)
  // regardless of whether any tracker window is open/enabled, and vice versa. Set via the
  // "countryConfig" message, separate from "config" (which only ever touches `enabled`).
  let countryEnabled = true;

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

  // ---- WarEra's own native flag positions + label style --------------------
  // Ground truth, not a computed approximation: WarEra's native country flags
  // (the "country-label" symbol layer) are Point features on their OWN
  // dedicated source, "countryLabels" — confirmed live via
  // queryRenderedFeatures. Earlier attempts approximated this from
  // region/country polygon geometry (a centroid), which never actually
  // matched — the real points are seemingly derived from WarEra's own
  // internal placement logic (tile-grid-shaped coordinates, not organic
  // geometry), not reproducible from geometry at all. Reading them straight
  // from this source sidesteps that entirely, and also directly explains
  // "some countries get several flags" (confirmed by the user): a country
  // with territory in multiple places simply has multiple Point features
  // here, one per flag WarEra draws — returned as-is, one entry per flag,
  // for the proxy marker to anchor under each.
  // Each feature's properties also carry that SAME per-country label styling
  // WarEra paints its own name text with — textColor/strokeColor (confirmed
  // live, identical across every one of a country's multiple flag entries,
  // it's a per-country style not a per-position one) — grabbed here from
  // the first matching feature so the "proxy of ..." caption below can match
  // it exactly instead of approximating a color from the fill palette.
  // textSize and textLines (from countryName's own embedded "\n" — WarEra
  // hard-wraps long names into the string itself rather than relying on
  // layout-time wrapping, confirmed live e.g. "Central\nAfrica") are grabbed
  // the same way, so the marker below can clear the native text block by
  // exactly as much as IT actually needs, not a flat guess covering the
  // worst case for every country regardless of its own name length.
  const nativeFlagInfo = (cid) => {
    const real = wdlMap();
    const src = real && real.getSource("countryLabels");
    const fc = src && (src._options ? src._options.data : src._data);
    const feats = (fc && fc.features) || [];
    const positions = [];
    let textColor = null, strokeColor = null, textSize = null, textLines = null;
    for (const f of feats) {
      const p = f.properties;
      if (!p || p.countryId !== cid) continue;
      if (f.geometry && f.geometry.type === "Point" && Array.isArray(f.geometry.coordinates)) {
        positions.push(f.geometry.coordinates);
      }
      if (textColor === null && p.textColor) textColor = p.textColor;
      if (strokeColor === null && p.strokeColor) strokeColor = p.strokeColor;
      if (textSize === null && p.textSize) textSize = p.textSize;
      if (textLines === null && typeof p.countryName === "string") {
        textLines = (p.countryName.match(/\n/g) || []).length + 1;
      }
    }
    return { positions, textColor, strokeColor, textSize, textLines };
  };

  // ---- build position/metadata lookups ----------------------------------
  const buildLookups = async () => {
    const src = map.getSource("regions");
    const fc = src && (src._options ? src._options.data : src._data);
    const feats = (fc && fc.features) || [];
    if (!feats.length) return false;

    regionPos = {};
    const positionsByCountry = {}; // initialCountryId -> [[lng,lat], ...]
    currentRegionsByCountry = {};  // countryId (CURRENT owner) -> [[lng,lat], ...] — see war-priority overlay
    for (const f of feats) {
      const p = f.properties;
      if (!p || !p.position) continue;
      if (p.regionId) regionPos[p.regionId] = p.position;
      if (p.initialCountryId) {
        (positionsByCountry[p.initialCountryId] = positionsByCountry[p.initialCountryId] || []).push(p.position);
      }
      if (p.countryId) {
        (currentRegionsByCountry[p.countryId] = currentRegionsByCountry[p.countryId] || []).push(p.position);
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

    // Region names (for the overlay's battle header) plus isCapital/isLinkedToCapital (for the
    // capitals & unlinked regions map overlay, see rebuildRegionStatusIcons below) — all three come
    // from this same bulk object (confirmed live), so no extra per-region region.getById fan-out
    // is needed for either feature. Best-effort: a failure here just leaves both without data.
    try {
      const regions = await trpcRaw("region.getRegionsObject", {});
      const robj = (regions && regions.json) || regions || {};
      regionMeta = {};
      for (const id in robj) {
        const r = robj[id];
        if (!r || !r.name) continue;
        regionMeta[id] = { name: r.name, isCapital: !!r.isCapital, isLinkedToCapital: r.isLinkedToCapital !== false };
      }
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

  // ---- proxy-country flag markers -----------------------------------------
  // A single line — "proxy of [origin]" then a SMALL origin flag right after
  // it — placed in clear space BELOW a proxy country's own NATIVE flag
  // (WarEra's own country-label symbol layer, untouched — see
  // OWNERSHIP_LAYER_IDS), not overlapping it at all. Earlier attempts tried
  // sitting right on top of the native flag (same point, bigger, translucent
  // or cut-out) but that never read well against text that varies in size
  // and line count per country — sitting clearly below it sidesteps that
  // entirely, at the cost of not being literally "layered" on the native icon.
  // The clearance below the anchor is computed PER COUNTRY (see nativeFlagInfo's textSize/
  // textLines), not a flat guess: confirmed live from the country-label layer's style spec,
  // text-anchor is "top" with a [0,0] offset, so the text block starts exactly at the anchor and
  // grows down at textSize * text-line-height (0.8) per line — the icon itself never factors in,
  // it sits entirely ABOVE the anchor (icon-anchor "bottom"). A flat gap sized for the worst case
  // (2 lines, largest textSize) left a big, obviously-too-far gap under every single-line name.
  // Anchored via nativeFlagInfo(cid) — WarEra's own real flag coordinates
  // (see that function's comment) — NOT countryPos[cid] (a computed
  // core-territory centroid that never actually matched, see git history)
  // and not a geometry-derived guess either: those both landed the marker
  // over unrelated regions instead of under the real flag. A country whose
  // current territory is split into several disconnected pieces gets a
  // native flag for EACH piece (confirmed by the user, and directly visible
  // in nativeFlagInfo's source data) — so this places one marker per piece
  // too, not just at one.
  // Rebuilt on every data refresh (proxy list changes rarely) — no zoom-based
  // decluttering of its OWN beyond piggybacking the native flag's (see
  // repositionProxyFlags): proxy countries are a handful at most (unlike all
  // ~180 countries for the core-colors flags), no separate clutter to solve.
  const NATIVE_TEXT_LINE_HEIGHT = 0.8; // confirmed live: country-label's own text-line-height
  // Covers two things, not just a small margin: (1) genuine safety padding below the native
  // text's last line (halo width, descenders), and (2) our OWN text element's y is its BASELINE
  // (SVG's default), not its top — unlike the native label's y (text-anchor "top"), so without
  // this our own glyphs start rendering well above the y coordinate itself, overlapping upward
  // into the native text regardless of how accurately `clearance` alone was computed.
  const NATIVE_TEXT_PAD = 12;
  const DEFAULT_TEXT_SIZE = 14; // fallback if a country's own textSize wasn't found for some reason
  const PROXY_LABEL_GAP = 4;
  // Small — sits inline next to the caption text, not meant to stand on its own the way the
  // earlier bigger attempts were.
  const PROXY_FLAG_W = 16, PROXY_FLAG_H = 12;
  const PROXY_FLAG_RX = 2; // corner radius — keep roughly in sync with the clipPath in ensureSvg

  const rebuildProxyFlags = () => {
    if (!gProxyFlags) return;
    gProxyFlags.innerHTML = "";
    for (const cid in proxyData) {
      const origin = countryMeta[proxyData[cid].o];
      if (!origin || !origin.code) continue;
      const info = nativeFlagInfo(cid);
      // NO fallback to countryPos here (deliberately — see git history for the earlier version
      // that had one): a very small country never gets its own native flag rendered at all
      // (confirmed by the user — there's simply no room for WarEra to place one), so it has zero
      // entries in countryLabels. Falling back to an approximate core-centroid position for THAT
      // case drew our marker floating disconnected over some unrelated country, since there's no
      // real flag for it to sit under in the first place. No native flag anywhere -> no marker.
      const anchors = info.positions;
      // Match WarEra's own per-country label styling exactly (see nativeFlagInfo) rather than
      // approximating a color from the fill palette — same font for every country (FLAG_FONT,
      // already the established approximation elsewhere in this file), but the color/stroke are
      // genuinely per-country data, straight from the same source WarEra itself reads.
      const nameColor = info.textColor || "#fff";
      const nameStroke = info.strokeColor || "#000";
      const clearance = (info.textLines || 1) * (info.textSize || DEFAULT_TEXT_SIZE)
        * NATIVE_TEXT_LINE_HEIGHT + NATIVE_TEXT_PAD;

      for (const pos of anchors) {
        const g = document.createElementNS(NS, "g");
        g.setAttribute("data-cid", cid);
        // Cached here rather than re-deriving in repositionProxyFlags (called on every map
        // "render" tick during pan/zoom) — nativeFlagInfo scans every countryLabels feature, too
        // costly to redo that often, and re-deriving could also drift from what was actually just
        // built.
        g.setAttribute("data-lng", String(pos[0]));
        g.setAttribute("data-lat", String(pos[1]));

        const labelY = clearance;
        const label = document.createElementNS(NS, "text");
        label.textContent = `proxy of ${origin.name || ""}`;
        label.setAttribute("x", "0");
        label.setAttribute("y", String(labelY));
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("font-size", "11");
        label.setAttribute("font-family", FLAG_FONT);
        label.setAttribute("font-weight", "600");
        label.setAttribute("fill", nameColor);
        label.style.paintOrder = "stroke";
        label.style.stroke = nameStroke;
        label.style.strokeWidth = "2px";
        label.style.strokeLinejoin = "round";
        g.appendChild(label);
        // Needs to be attached to measure the label's real rendered width (font metrics aren't
        // known up front) before the flag can be placed right after it, with no overlap/gap guessing.
        gProxyFlags.appendChild(g);
        let labelRight = 40; // fallback, only hit if getBBox is unavailable (e.g. still display:none)
        try {
          const bb = label.getBBox();
          if (bb && bb.width) labelRight = bb.x + bb.width;
        } catch (_) { /* keep fallback */ }

        const flagLeft = labelRight + PROXY_LABEL_GAP;
        const flagTop = labelY - 4 - PROXY_FLAG_H / 2; // ~vertically centered on the text
        const img = document.createElementNS(NS, "image");
        img.setAttribute("href", FLAG_URL(origin.code));
        img.setAttribute("width", String(PROXY_FLAG_W));
        img.setAttribute("height", String(PROXY_FLAG_H));
        img.setAttribute("x", String(flagLeft));
        img.setAttribute("y", String(flagTop));
        img.setAttribute("clip-path", "url(#wdl-proxy-flag-clip)"); // border-radius doesn't clip <image> content
        g.appendChild(img);

        // Border drawn as its own rect (not the image's CSS border, which SVG doesn't apply to
        // rendered <image> content) — same geometry as the clip so its rounded corners line up.
        const border = document.createElementNS(NS, "rect");
        border.setAttribute("x", String(flagLeft));
        border.setAttribute("y", String(flagTop));
        border.setAttribute("width", String(PROXY_FLAG_W));
        border.setAttribute("height", String(PROXY_FLAG_H));
        border.setAttribute("rx", String(PROXY_FLAG_RX));
        border.setAttribute("fill", "none");
        border.setAttribute("stroke", "#000");
        border.setAttribute("stroke-width", "1");
        g.appendChild(border);
      }
    }
  };

  // The native country-label layer's own minzoom/maxzoom (confirmed live from its style spec:
  // minzoom 2, maxzoom 4 — MapLibre treats maxzoom as exclusive, so visible for 2 <= zoom < 4).
  // A hard cutoff, not an approximation like the rank ramp below — outside this range the native
  // flag is DEFINITELY gone, so ours must vanish too rather than floating there unlabeled.
  const NATIVE_LABEL_MINZOOM = 2, NATIVE_LABEL_MAXZOOM = 4;

  const repositionProxyFlags = () => {
    if (!gProxyFlags || gProxyFlags.style.display === "none") return;
    const zoom = map.getZoom();
    if (zoom < NATIVE_LABEL_MINZOOM || zoom >= NATIVE_LABEL_MAXZOOM) {
      for (const g of gProxyFlags.children) g.style.display = "none";
      return;
    }
    // Within that range, approximate WarEra's own collision-based decluttering (smaller countries'
    // labels get dropped first as more of them compete for space on screen) with the same rank/ramp
    // the core-colors flags already use (see repositionCoreFlags) — not exact (that's a live
    // collision computation, not a fixed ranking), but the same approximation already accepted
    // there.
    const visibleCount = visibleFlagCount(countryRankByRegionCount);
    for (const g of gProxyFlags.children) {
      const rank = countryRankIndex.get(g.getAttribute("data-cid"));
      if (rank !== undefined && rank >= visibleCount) { g.style.display = "none"; continue; }
      const lng = parseFloat(g.getAttribute("data-lng"));
      const lat = parseFloat(g.getAttribute("data-lat"));
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) { g.style.display = "none"; continue; }
      const pos = [lng, lat];
      if (isOccludedOnGlobe(pos)) { g.style.display = "none"; continue; }
      g.style.display = "";
      const p = map.project(pos);
      g.setAttribute("transform", `translate(${p.x},${p.y})`);
    }
  };

  // ---- shared dispatcher for proxy-country overlay -------------------------
  // Flags-only now (see the block comment above) — no MapLibre layer to
  // build/self-heal, just our own SVG markers, so this is much lighter than
  // applyColorMode: show/rebuild/reposition, or hide.
  const applyProxyMode = () => {
    if (!map || !ready || !gProxyFlags) return;
    if (proxyEnabled) {
      gProxyFlags.style.display = "";
      rebuildProxyFlags();
      repositionProxyFlags();
    } else {
      gProxyFlags.style.display = "none";
    }
  };

  const setProxyEnabled = (on) => {
    proxyEnabled = !!on;
    applyProxyMode();
  };
  const setProxyData = (data) => {
    proxyData = data || {};
    if (proxyEnabled) applyProxyMode();
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
    // Mutually exclusive with the region-status overlay — see its declaration comment above.
    if (coreColorsEnabled && regionStatusEnabled) { regionStatusEnabled = false; applyRegionStatusMode(); }
    applyColorMode();
  };

  // ---- capitals & unlinked regions overlay -------------------------------
  // Just a small star/broken-link glyph per matching region — an earlier version also tinted the
  // region's fill, but that read as confusing alongside the normal ownership colors and was dropped.
  const rebuildRegionStatusIcons = () => {
    if (!gRegionStatusIcons) return;
    gRegionStatusIcons.innerHTML = "";
    for (const id in regionMeta) {
      const m = regionMeta[id];
      const pos = regionPos[id];
      if (!pos) continue;
      const kind = m.isCapital ? "capital" : (m.isLinkedToCapital === false ? "unlinked" : null);
      if (!kind) continue;
      const g = document.createElementNS(NS, "g");
      g.setAttribute("data-lng", String(pos[0]));
      g.setAttribute("data-lat", String(pos[1]));
      if (kind === "capital") {
        const path = document.createElementNS(NS, "path");
        path.setAttribute("d", CAPITAL_ICON_PATH);
        // The path's own coordinates are WarEra's 24x24 icon viewBox — scale down to a small map
        // marker and re-center it on the group's own (0,0) origin.
        path.setAttribute("transform", "translate(-9,-9) scale(0.75)");
        path.setAttribute("fill", CAPITAL_ICON_FILL);
        path.setAttribute("stroke", CAPITAL_ICON_STROKE);
        path.setAttribute("stroke-width", "1");
        g.appendChild(path);
      } else {
        // Two open rings with a gap between them — an abstract "broken link" instead of a literal
        // chain/heart emoji.
        for (const cx of [-4, 4]) {
          const c = document.createElementNS(NS, "circle");
          c.setAttribute("cx", String(cx)); c.setAttribute("cy", "0"); c.setAttribute("r", "3.2");
          c.setAttribute("fill", "none");
          c.setAttribute("stroke", UNLINKED_ICON_STROKE);
          c.setAttribute("stroke-width", "2");
          g.appendChild(c);
        }
      }
      gRegionStatusIcons.appendChild(g);
    }
  };

  const repositionRegionStatusIcons = () => {
    if (!gRegionStatusIcons || gRegionStatusIcons.style.display === "none") return;
    for (const el of gRegionStatusIcons.children) {
      const lng = parseFloat(el.getAttribute("data-lng")), lat = parseFloat(el.getAttribute("data-lat"));
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) { el.style.display = "none"; continue; }
      const pos = [lng, lat];
      if (isOccludedOnGlobe(pos)) { el.style.display = "none"; continue; }
      el.style.display = "";
      const p = map.project(pos);
      el.setAttribute("transform", `translate(${p.x},${p.y})`);
    }
  };

  // Idempotent and self-healing, same reasoning as applyColorMode above.
  const applyRegionStatusMode = () => {
    if (!map || !ready) return;
    if (regionStatusEnabled) {
      if (gRegionStatusIcons) {
        gRegionStatusIcons.style.display = "";
        rebuildRegionStatusIcons();
        repositionRegionStatusIcons();
      }
    } else if (gRegionStatusIcons) {
      gRegionStatusIcons.style.display = "none";
    }
  };

  const setRegionStatusEnabled = (on) => {
    regionStatusEnabled = !!on;
    // Mutually exclusive with core colors — see the overlay's declaration comment above.
    if (regionStatusEnabled && coreColorsEnabled) { coreColorsEnabled = false; applyColorMode(); }
    applyRegionStatusMode();
  };

  // ---- battle metadata (region + sides) ---------------------------------
  const countryLabel = (cid) => {
    const m = countryMeta[cid];
    return { name: (m && m.name) || "?", code: (m && m.code) || "" };
  };

  const ensureBattle = (battleId) => {
    let b = battles.get(battleId);
    if (!b) {
      // history: [{t, att, def}] cumulative attacker/defender totals at each HISTORY_BUCKET_MS
      // bucket boundary, maintained incrementally in addDamage (not recomputed from raw events on
      // every render tick — see there) — starts from nothing, since we only see hits from the
      // moment a battle is FIRST picked in some panel (i.e. "since we chose to track it").
      // startedAt is that same moment — kept even while history is still empty, so the timeline
      // chart can show a flat "0 so far" line immediately instead of waiting for real hits.
      b = { region: null, meta: false, header: null, countries: new Map(), history: [], historyTotals: { att: 0, def: 0 }, startedAt: Date.now() };
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

    // Timeline chart data: an O(1) update per hit instead of rebuilding a bucketed history from
    // every country's full events[] on every render tick, which would get steadily more expensive
    // as a long-running battle accumulates more hits.
    if (side === "attacker") b.historyTotals.att += dmg; else b.historyTotals.def += dmg;
    const bucketT = Math.floor(t / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;
    const lastBucket = b.history[b.history.length - 1];
    if (lastBucket && lastBucket.t === bucketT) {
      lastBucket.att = b.historyTotals.att;
      lastBucket.def = b.historyTotals.def;
    } else {
      b.history.push({ t: bucketT, att: b.historyTotals.att, def: b.historyTotals.def });
    }
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
  let svg, gAllArcs, gAllNodes, defsEl, gCoreFlags, gProxyFlags, gWarPriority, warArrowMarker;
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
  // The active-battle index (region + the two side countries per battle) is SHARED across every open
  // "Country damage" window (one 90s timer, not one per window) since it's not country-specific —
  // it's just "what battles currently exist". Everything else (selection, poll results, the
  // Total/Now display preference) is tracked PER WINDOW in `countryPanels`, so several windows can
  // watch different countries at once; only whichever one is "active" (activeCountryPanelId, see
  // above) actually draws lines on the map — same mutual exclusivity as the tracker panels.
  const COUNTRY_COLOR = "#ffcc44";
  const COUNTRY_FAST_MS = 10000;
  const COUNTRY_FULL_MS = 30000;
  const COUNTRY_INDEX_MS = 90000;
  const RANK_CONCURRENCY = 6;    // cap simultaneous ranking fetches during a scan
  let gCountryArcs, gCountryNodes;
  const countryArcEls = new Map();      // battleId -> { path, grad, s0, s1 } — pooled, reused for
                                         // whichever window is currently active (drawCountry() below
                                         // rebuilds this from that window's own targets every call)
  let countryNode = null;               // { halo, core } origin marker at the active window's country
  const PULSE_MS = 5000;                // how long a line pulses after its battle's damage changes
  const activeBattleIndex = new Map();  // battleId -> { region, att, def } — SHARED, see above
  let countryIndexTimer = null;

  // panelId -> per-window "by country" state. battleRanking.getRanking only ever returns a battle's
  // CUMULATIVE damage total (all-time, no time-range param exists on this endpoint) — "total" shows
  // that raw total as-is; "now" is built client-side by remembering each battle's raw total at the
  // moment "Now" was (re)clicked and subtracting it from the current raw total — a manual, exact
  // zero-point rather than a rolling clock window (a "last hour"/"last minute" rolling window was
  // tried and dropped: with only a 10-30s poll cadence it reads as inaccurate/laggy right after
  // switching to it, since there's no way to backfill damage that happened before we started polling).
  const countryPanels = new Map();
  // Each entry: {
  //   sel: countryId|null,
  //   window: "total"|"now",
  //   nowBaseline: Map<battleId,rawDmg>|null,
  //   nowSplitBaseline: Map<battleId,{att,def}>|null,  // attacker/defender split at "now"'s click
  //   targets: Map<battleId,{region,damage,ratio}>,    // WINDOWED — damage>0 entries only; ratio is
  //                                                     // the attacker-side fraction (0..1) of that
  //                                                     // entry's windowed damage, for red/blue coloring
  //   prevDmg: Map<battleId,rawDmg>,            // RAW total — pulse-detection source + "now" baseline
  //   prevSplit: Map<battleId,{att,def}>,       // RAW attacker/defender split, latest known per battle
  //   pulseUntil: Map<battleId,ts>,
  //   nextFullAt: number,     // next full-scan (all active battles) — drives the countdown when
  //                           // the country has no battle of its own currently active (see below)
  //   nextFastAt: number,     // next fast-scan (this country's own attacker/defender battles) —
  //                           // drives the countdown instead, whenever hasFastBattles() is true,
  //                           // since that's the refresh that actually matters for this country
  //   fastTimer, fullTimer,
  //   history: [{t, total}],   // RAW cumulative total (summed across every current target battle)
  //                            // at each scan, for the timeline chart — always "since this country
  //                            // was selected", independent of the Total/Now display window above
  //   startedAt: number|null,  // when the current selection started; null while nothing's selected
  //   entityType: "country"|"mu",  // what `sel` refers to — see selectCountry
  // }
  const ensureCountryPanel = (panelId) => {
    let p = countryPanels.get(panelId);
    if (!p) {
      p = {
        sel: null, entityType: "country", window: "total", nowBaseline: null, nowSplitBaseline: null,
        nowBaselinePending: false, // see applyCountryScan — true right after a re-selection made while in "now" mode
        targets: new Map(), prevDmg: new Map(), prevSplit: new Map(), pulseUntil: new Map(),
        nextFullAt: 0, nextFastAt: 0, fastTimer: null, fullTimer: null, history: [], startedAt: null,
      };
      countryPanels.set(panelId, p);
    }
    return p;
  };

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
    // Rounded-corner clip for the proxy overlay's origin-flag image (see rebuildProxyFlags).
    // objectBoundingBox units (a 0..1 box, not pixels) so this one static def works for every
    // marker regardless of its actual position — border-radius doesn't clip an SVG <image>'s
    // content in any browser, a clipPath is the only thing that actually does. rx/ry chosen to
    // land on a few px of actual corner radius at PROXY_FLAG_W/H's size below (rx is a fraction
    // of width, ry a fraction of height per the objectBoundingBox spec) — keep those two roughly
    // in sync with PROXY_FLAG_W/H if that size ever changes.
    const proxyClip = document.createElementNS(NS, "clipPath");
    proxyClip.id = "wdl-proxy-flag-clip";
    proxyClip.setAttribute("clipPathUnits", "objectBoundingBox");
    const proxyClipRect = document.createElementNS(NS, "rect");
    proxyClipRect.setAttribute("x", "0"); proxyClipRect.setAttribute("y", "0");
    proxyClipRect.setAttribute("width", "1"); proxyClipRect.setAttribute("height", "1");
    proxyClipRect.setAttribute("rx", "0.125"); proxyClipRect.setAttribute("ry", "0.167");
    proxyClip.appendChild(proxyClipRect);
    defsEl.appendChild(proxyClip);
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
    gProxyFlags = document.createElementNS(NS, "g"); // proxy-country flag markers, above everything else
    gProxyFlags.style.display = "none";
    svg.appendChild(gProxyFlags);
    // Arrowhead for the war-priority overlay's arrows (see drawWarPriority) — a single shared
    // marker def (every arrow's on screen at the same zoom, so one shared size is fine), oriented
    // per-path automatically via orient="auto-start-reverse". markerUnits="userSpaceOnUse" (not the
    // default "strokeWidth") deliberately decouples the arrowhead's size from the line's — the line
    // got thicker at one point but the arrowhead was asked to stay the smaller size it already had,
    // so markerWidth/markerHeight are set directly in screen px each frame (see WAR_ARROW_HEAD_PX)
    // instead of scaling automatically off the path's stroke-width.
    warArrowMarker = document.createElementNS(NS, "marker");
    warArrowMarker.id = "wdl-war-arrowhead";
    warArrowMarker.setAttribute("viewBox", "0 0 10 10");
    warArrowMarker.setAttribute("refX", "8"); warArrowMarker.setAttribute("refY", "5");
    warArrowMarker.setAttribute("markerUnits", "userSpaceOnUse");
    warArrowMarker.setAttribute("orient", "auto-start-reverse");
    const warArrowPath = document.createElementNS(NS, "path");
    warArrowPath.setAttribute("d", "M 0 0 L 10 5 L 0 10 Z");
    warArrowPath.setAttribute("fill", WAR_PRIORITY_COLOR);
    warArrowMarker.appendChild(warArrowPath);
    defsEl.appendChild(warArrowMarker);
    gWarPriority = document.createElementNS(NS, "g"); // war-priority arrows, above everything else
    gWarPriority.style.display = "none";
    svg.appendChild(gWarPriority);
    gRegionStatusIcons = document.createElementNS(NS, "g"); // capital/unlinked glyphs, above everything else
    gRegionStatusIcons.style.display = "none";
    svg.appendChild(gRegionStatusIcons);
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

    return { active: true, header: b.header, totals, countries: shown, targetOccluded, history: b.history, startedAt: b.startedAt };
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

  // A window's country/MU damage in one battle (merged ranking lists every entity on both sides —
  // cheap discovery pass, used first to decide whether this battle is worth showing at all).
  // `entityType` is "country" or "mu" — battleRanking.getRanking's `type` param and each item's own
  // id field both follow it directly (an item is `{country, value}` or `{mu, value}`, see
  // BACKEND_API.md's battles/{battleId}/bonus doc for the same country-side shape server-side).
  const fetchEntityDamage = async (battleId, entityType, id) => {
    try {
      const d = await trpcRaw("battleRanking.getRanking", { battleId, type: entityType, dataType: "damage", side: "merged" });
      const items = (d && d.items) || [];
      const row = items.find((x) => x[entityType] === id);
      return row ? (row.value || 0) : 0;
    } catch (_) { return 0; }
  };

  // The attacker/defender split of a country/MU's damage in one battle — only fetched for battles
  // that already came back with nonzero merged damage (see scanEntityDamage below), so this
  // doesn't double the request volume of the ~80-battle discovery pass, only the much smaller set
  // of battles actually worth drawing. Used to color that battle's line/bar red-vs-blue instead of
  // the flat yellow the merged total alone can't distinguish.
  const fetchEntitySideSplit = async (battleId, entityType, id) => {
    try {
      const [attD, defD] = await Promise.all([
        trpcRaw("battleRanking.getRanking", { battleId, type: entityType, dataType: "damage", side: "attacker" }),
        trpcRaw("battleRanking.getRanking", { battleId, type: entityType, dataType: "damage", side: "defender" }),
      ]);
      const attRow = ((attD && attD.items) || []).find((x) => x[entityType] === id);
      const defRow = ((defD && defD.items) || []).find((x) => x[entityType] === id);
      return { att: attRow ? (attRow.value || 0) : 0, def: defRow ? (defRow.value || 0) : 0 };
    } catch (_) { return { att: 0, def: 0 }; }
  };

  // Two-stage scan shared by the fast/full tiers: cheap merged-damage discovery across `ids`, then
  // the (attacker/defender) split fetched only for whichever came back nonzero.
  const scanEntityDamage = async (ids, entityType, sel) => {
    const raw = await mapLimit(ids, RANK_CONCURRENCY, async (id) => ({ id, dmg: await fetchEntityDamage(id, entityType, sel) }));
    const hitIds = raw.filter((r) => r.dmg > 0).map((r) => r.id);
    const splits = await mapLimit(hitIds, RANK_CONCURRENCY, async (id) => ({ id, split: await fetchEntitySideSplit(id, entityType, sel) }));
    const splitById = new Map(splits.map((s) => [s.id, s.split]));
    return raw.map((r) => {
      const s = splitById.get(r.id) || { att: 0, def: 0 };
      return { id: r.id, dmg: r.dmg, att: s.att, def: s.def };
    });
  };

  // Turns a battle's RAW (all-time cumulative) damage into whatever that window's currently
  // selected display window wants to show: the raw total as-is, or (in "now" mode) the raw total
  // minus whatever it was at the moment "Now" was last clicked (see p.nowBaseline).
  const windowedDamage = (p, battleId, rawDmg) => {
    if (p.window !== "now") return rawDmg;
    const base = p.nowBaseline ? (p.nowBaseline.get(battleId) || 0) : 0;
    return Math.max(0, rawDmg - base);
  };

  // Same idea as windowedDamage but for the attacker/defender split, so "now" mode's color ratio
  // reflects only damage dealt since the click too, not the battle's all-time split.
  const windowedSplit = (p, battleId, rawSplit) => {
    if (p.window !== "now") return rawSplit;
    const base = p.nowSplitBaseline ? p.nowSplitBaseline.get(battleId) : null;
    return {
      att: Math.max(0, rawSplit.att - (base ? base.att : 0)),
      def: Math.max(0, rawSplit.def - (base ? base.def : 0)),
    };
  };

  // Attacker-side fraction (0..1) of a split — what the red/blue line & bar coloring is based on.
  // Defaults to an even 0.5 split when there's nothing to go on (shouldn't normally happen for a
  // battle with damage>0, but guards against a split fetch that failed/came back empty).
  const ratioOf = (split) => {
    const sum = split.att + split.def;
    return sum > 0 ? split.att / sum : 0.5;
  };

  // Rebuilds a window's targets from its last known RAW per-battle totals (p.prevDmg/p.prevSplit)
  // under its current display window — used to give instant feedback when the user switches
  // Total/Now, without waiting for the next scan.
  const recomputeCountryPanelTargets = (p) => {
    for (const [id, rawDmg] of p.prevDmg) {
      const idx = activeBattleIndex.get(id);
      if (!idx) { p.targets.delete(id); continue; }
      const shown = windowedDamage(p, id, rawDmg);
      if (shown > 0) {
        const split = windowedSplit(p, id, p.prevSplit.get(id) || { att: 0, def: 0 });
        p.targets.set(id, { region: idx.region, damage: shown, ratio: ratioOf(split) });
      } else {
        p.targets.delete(id);
      }
    }
  };

  const applyCountryScan = (panelId, sel, results) => {
    const p = countryPanels.get(panelId);
    if (!p || p.sel !== sel) return; // window closed, or its selection changed mid-scan
    // A fresh selection made while already in "now" mode (picking a different country/MU, or
    // switching entityType back to one with a remembered pick) has no prevDmg yet to baseline
    // against — selectCountry marks nowBaselinePending instead of capturing one immediately, so
    // THIS first scan's raw totals become the zero-point, same as if "Now" had just been clicked
    // at this exact moment. Without this, windowedDamage would show the full raw cumulative total
    // (base=0) for a scan cycle instead of "damage since selecting this".
    if (p.window === "now" && p.nowBaselinePending) {
      p.nowBaseline = new Map(results.map((r) => [r.id, r.dmg]));
      p.nowSplitBaseline = new Map(results.map((r) => [r.id, { att: r.att, def: r.def }]));
      p.nowBaselinePending = false;
    }
    const now = Date.now();
    let pulsed = false;
    for (const { id, dmg, att, def } of results) {
      const idx = activeBattleIndex.get(id);
      if (dmg > 0 && idx) {
        const prev = p.prevDmg.get(id);
        p.prevSplit.set(id, { att, def });
        const shown = windowedDamage(p, id, dmg);
        if (shown > 0) {
          const split = windowedSplit(p, id, { att, def });
          p.targets.set(id, { region: idx.region, damage: shown, ratio: ratioOf(split) });
        } else {
          p.targets.delete(id);
        }
        // Pulse only on a real RAW increase from a known previous value (a genuine new hit) — not
        // on first discovery, and not tied to the displayed window ("now" can otherwise look like
        // it's not pulsing right after a reset, since the RAW total is what actually changed).
        if (prev !== undefined && dmg > prev) { p.pulseUntil.set(id, now + PULSE_MS); pulsed = true; }
        p.prevDmg.set(id, dmg);
      } else {
        p.targets.delete(id);
        p.prevDmg.delete(id);
        p.prevSplit.delete(id);
        p.pulseUntil.delete(id);
      }
    }

    // Timeline chart data: the country's RAW total across every currently known target battle,
    // bucketed the same way as the tracker panels' per-battle history — one point per scan is
    // plenty of resolution given scans only happen every 10-30s anyway.
    let totalRaw = 0;
    for (const v of p.prevDmg.values()) totalRaw += v;
    const bucketT = Math.floor(now / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;
    const lastBucket = p.history[p.history.length - 1];
    if (lastBucket && lastBucket.t === bucketT) lastBucket.total = totalRaw;
    else p.history.push({ t: bucketT, total: totalRaw });

    if (panelId === activeCountryPanelId) drawCountry();
    postCountrySummary(panelId);
    // The map may be idle (no render frames) — make sure the pulse class gets cleared after 5s.
    if (pulsed) setTimeout(() => { if (panelId === activeCountryPanelId && countryPanels.get(panelId) === p) drawCountry(); }, PULSE_MS + 150);
  };

  const countryFullScan = async (panelId) => {
    const p = countryPanels.get(panelId);
    if (!p || !p.sel) return;
    const sel = p.sel;
    const ids = [...activeBattleIndex.keys()];
    const results = await scanEntityDamage(ids, p.entityType, sel);
    applyCountryScan(panelId, sel, results);
  };

  // Battles where `sel` is a declared attacker/defender country — the "fast" tier only ever needs
  // to re-check these (its whole point is being cheap: usually just a handful of ids, not all ~80).
  // Also used to decide which refresh timer the countdown UI should reflect — see postCountrySummary.
  // activeBattleIndex only records each battle's two COUNTRY sides, not any MU orders on it, so
  // there's no cheap way to know a MU's own battles without scanning all of them — MU mode always
  // relies on the full-scan tier alone (see countryFastScan's no-op below for entityType "mu").
  const fastBattleIds = (sel, entityType) => {
    if (entityType === "mu") return [];
    return [...activeBattleIndex.entries()].filter(([, idx]) => idx.att === sel || idx.def === sel).map(([id]) => id);
  };

  const countryFastScan = async (panelId) => {
    const p = countryPanels.get(panelId);
    if (!p || !p.sel) return;
    const sel = p.sel;
    const ids = fastBattleIds(sel, p.entityType);
    if (!ids.length) return; // MU mode (or a country with no battle of its own) — nothing extra to do here
    const results = await scanEntityDamage(ids, p.entityType, sel);
    applyCountryScan(panelId, sel, results);
  };

  const stopCountryTimers = (panelId) => {
    const p = countryPanels.get(panelId);
    if (!p) return;
    if (p.fastTimer) clearInterval(p.fastTimer);
    if (p.fullTimer) clearInterval(p.fullTimer);
    p.fastTimer = p.fullTimer = null;
  };

  // The shared active-battle index only needs to run while at least one window has a country
  // selected — started/stopped as windows gain/lose a selection, not tied to any one of them.
  const anyCountrySelected = () => { for (const p of countryPanels.values()) if (p.sel) return true; return false; };
  const ensureCountryIndexTimer = () => {
    if (countryIndexTimer) return;
    countryIndexTimer = setInterval(buildActiveBattleIndex, COUNTRY_INDEX_MS);
  };
  const stopCountryIndexTimerIfIdle = () => {
    if (anyCountrySelected()) return;
    if (countryIndexTimer) { clearInterval(countryIndexTimer); countryIndexTimer = null; }
  };

  const startCountryTimers = async (panelId) => {
    stopCountryTimers(panelId);
    ensureCountryIndexTimer();
    // Only force a fresh build if we've never had one — otherwise trust the shared 90s timer to
    // stay reasonably current (avoids re-doing an ~80-battle fan-out every time another window
    // picks a country while one is already being watched).
    if (!activeBattleIndex.size) await buildActiveBattleIndex();
    const p = countryPanels.get(panelId);
    if (!p || !p.sel) return; // window closed or deselected while the index built
    p.nextFullAt = Date.now() + COUNTRY_FULL_MS;
    p.nextFastAt = Date.now() + COUNTRY_FAST_MS;
    countryFullScan(panelId);
    p.fastTimer = setInterval(() => {
      p.nextFastAt = Date.now() + COUNTRY_FAST_MS;
      countryFastScan(panelId);
    }, COUNTRY_FAST_MS);
    p.fullTimer = setInterval(() => {
      p.nextFullAt = Date.now() + COUNTRY_FULL_MS;
      countryFullScan(panelId);
    }, COUNTRY_FULL_MS);
  };

  const sendCountryList = () => {
    const countries = Object.keys(countryMeta)
      .filter((cid) => countryPos[cid]) // only ones we can anchor a line from
      .map((cid) => ({ cid, name: countryMeta[cid].name || "?", code: countryMeta[cid].code || "" }))
      .sort((a, b) => a.name.localeCompare(b.name));
    window.postMessage({ __wdl: CHANNEL, kind: "countryList", countries }, location.origin);
  };

  // A MU has no map position of its own — its "by country" origin is its HOME country's position
  // (countryPos[muMeta[muId].countryId]), same dot marker drawCountry already draws, just anchored
  // differently. A MU with no resolvable home country can't be anchored, so it's left out here the
  // same way sendCountryList excludes countries with no countryPos.
  const sendMuList = () => {
    const mus = Object.keys(muMeta)
      .filter((mid) => countryPos[muMeta[mid].countryId])
      .map((mid) => ({ mid, name: muMeta[mid].name || "?", countryId: muMeta[mid].countryId }))
      .sort((a, b) => a.name.localeCompare(b.name));
    window.postMessage({ __wdl: CHANNEL, kind: "muList", mus, loading: muListState === "loading" }, location.origin);
  };

  // Paginates mu.getManyPaginated (the same proc full_fetcher.py uses server-side to build its own
  // known_mus registry) to get every MU's name + home country directly from WarEra, with no backend
  // of ours involved — mirrors country.getAllCountries' role for countries. ~14 requests for the
  // ~1300 MUs that currently exist; only ever run once (idempotent — see ensureMuList).
  const fetchAllMus = async () => {
    muListState = "loading";
    let cursor = null;
    try {
      do {
        const params = { limit: 100 };
        if (cursor) params.cursor = cursor;
        const raw = await trpcRaw("mu.getManyPaginated", params);
        // Confirmed live: NOT superjson-wrapped — result.data has items/nextCursor directly. The
        // `.json` fallback stays anyway since other procs elsewhere in this file (e.g.
        // battle.getGroupedActiveBattles) do need it and aren't all consistent with each other.
        const d = (raw && raw.json) || raw || {};
        const items = d.items || (Array.isArray(d) ? d : []);
        for (const item of items) {
          if (!item) continue;
          const mid = item._id || item.id;
          if (!mid) continue;
          // Confirmed live: `country` is a plain country-id STRING here, not an embedded object
          // (unlike battle.getById's attacker/defender.country, which also happens to be a plain
          // string, so this is at least consistent with that one).
          const rawCountry = item.country || item.nation;
          const countryId = typeof rawCountry === "string" ? rawCountry
            : (rawCountry && (rawCountry._id || rawCountry.id)) || item.countryId || item.country_id || null;
          muMeta[mid] = { name: item.name || item.title || "?", countryId };
        }
        cursor = d.nextCursor || d.cursor || null;
      } while (cursor);
      muListState = "ready";
    } catch (err) {
      console.warn("[WDL] fetchAllMus failed:", err);
      muListState = "ready"; // serve whatever partial list we got rather than retrying forever
    }
    sendMuList(); // update every window whose combo is open, even if it wasn't the one that asked
  };

  let muListPromise = null;
  const ensureMuList = () => {
    if (muListState === "ready") { sendMuList(); return; }
    sendMuList(); // "loading" placeholder immediately, so the combo shows something right away
    if (!muListPromise) muListPromise = fetchAllMus();
  };

  const postCountrySummary = (panelId) => {
    const p = countryPanels.get(panelId);
    const sel = p ? p.sel : null;
    const entityType = p ? p.entityType : "country";
    const targets = sel
      ? [...p.targets.entries()]
          .map(([, t]) => ({ regionName: (regionMeta[t.region] && regionMeta[t.region].name) || null, damage: t.damage, ratio: t.ratio }))
          .sort((a, b) => b.damage - a.damage)
      : [];
    window.postMessage({
      __wdl: CHANNEL, kind: "countrySummary", panelId,
      countryId: sel, entityType,
      name: sel ? ((entityType === "mu" ? muMeta[sel] : countryMeta[sel]) || {}).name || "?" : null,
      targets, total: targets.reduce((s, t) => s + t.damage, 0),
      // The full-scan timer (30s) is what discovers NEW merc/ally involvement, but if this country
      // already has a battle of its own active, the fast timer (10s) is what's actually refreshing
      // its numbers — show whichever one is the truthful "next update", not always the slower one.
      // Always the full-scan cadence in MU mode — see fastBattleIds.
      nextUpdateAt: sel ? (fastBattleIds(sel, entityType).length ? Math.min(p.nextFullAt, p.nextFastAt) : p.nextFullAt) : 0,
      history: sel ? p.history : [],
      startedAt: sel ? p.startedAt : null,
    }, location.origin);
  };

  // win: "total" | "now". "now" (re)captures a fresh zero-point every time it's selected —
  // including re-clicking it while already on "now" — from the RAW totals that window currently
  // knows about, so it always means "damage dealt since I last clicked this button".
  const selectCountryWindow = (panelId, win) => {
    if (win !== "total" && win !== "now") return;
    const p = countryPanels.get(panelId);
    if (!p) return;
    p.window = win;
    if (win === "now") {
      p.nowBaseline = new Map(p.prevDmg);
      p.nowSplitBaseline = new Map(p.prevSplit);
      p.nowBaselinePending = false; // baseline just captured directly — no need for the scan-time fallback
    }
    recomputeCountryPanelTargets(p);
    if (panelId === activeCountryPanelId) drawCountry();
    postCountrySummary(panelId);
  };

  const selectCountry = (panelId, cid, entityType) => {
    const p = ensureCountryPanel(panelId);
    p.sel = cid || null;
    if (entityType === "country" || entityType === "mu") p.entityType = entityType;
    p.targets.clear();
    p.prevDmg.clear();
    p.prevSplit.clear();
    p.pulseUntil.clear();
    p.nowBaseline = null;
    p.nowSplitBaseline = null;
    // If "now" is already the active window, this new selection has no prevDmg yet to baseline
    // against right now — defer it to the first scan result instead of leaving it at "no baseline"
    // (which windowedDamage would otherwise read as "show the full raw total"). See applyCountryScan.
    p.nowBaselinePending = p.window === "now" && !!p.sel;
    p.nextFullAt = 0;
    p.nextFastAt = 0;
    p.history = [];
    p.startedAt = p.sel ? Date.now() : null;
    // Deliberately NOT resetting p.window — switching countries in the same window keeps whatever
    // time-window view was selected, same as any other display preference.
    if (panelId === activeCountryPanelId) drawCountry();
    postCountrySummary(panelId);
    if (p.sel) startCountryTimers(panelId);
    else { stopCountryTimers(panelId); stopCountryIndexTimerIfIdle(); }
  };

  // A "Country damage" window was closed — stop tracking it entirely (unlike selectCountry(id,
  // null), which just clears the selection but keeps the window's own preferences around).
  const unregisterCountryPanel = (panelId) => {
    stopCountryTimers(panelId);
    countryPanels.delete(panelId);
    stopCountryIndexTimerIfIdle();
    // Overlay always reassigns activeCountryPanelId (to a survivor or a tracker panel) before/after
    // this when the closed one was active, so this is just a defensive fallback against dangling.
    if (activeCountryPanelId === panelId) activeCountryPanelId = null;
    draw(true);
  };

  // Shortest-line anchor points for a priority arrow: the priority holder's OWN region closest to
  // the other country, paired with the other country's OWN region closest back — not either
  // country's overall centroid, which could be far from the actual front line for a large/spread-out
  // country. Falls back to countryPos (core centroid) for a side with zero current regions (fully
  // occupied — rare, but not impossible). O(regionsA * regionsB) brute-force nearest pair; cheap
  // enough since this only runs once per scan (10 min), not per draw frame — see fetchCountryWarPriorities.
  const nearestRegionPair = (cidA, cidB) => {
    const regionsA = currentRegionsByCountry[cidA];
    const regionsB = currentRegionsByCountry[cidB];
    const posA = (regionsA && regionsA.length) ? regionsA : (countryPos[cidA] ? [countryPos[cidA]] : []);
    const posB = (regionsB && regionsB.length) ? regionsB : (countryPos[cidB] ? [countryPos[cidB]] : []);
    if (!posA.length || !posB.length) return null;
    let best = null, bestDist = Infinity;
    for (const a of posA) {
      for (const b of posB) {
        const dist = lngLatDist(a, b);
        if (dist < bestDist) { bestDist = dist; best = [a, b]; }
      }
    }
    return best; // [posA, posB]
  };

  // One country's war list — war.getPaginatedWars is scoped to a countryId, sorted newest-updated
  // first (confirmed live), so a currently-live priority (which requires a very recent battle) is
  // always near the top; a single page comfortably covers it without needing real pagination.
  // `isActive` alone isn't a reliable filter (long-dead wars from months ago still come back
  // isActive:true) — priorityEndAt actually being in the future is what "currently has priority"
  // means.
  const fetchCountryWarPriorities = async (cid) => {
    try {
      const d = await trpcMutate("war.getPaginatedWars", { countryId: cid, limit: 20, direction: "forward" });
      const items = (d && d.items) || [];
      const now = Date.now();
      const out = [];
      for (const w of items) {
        if (!w || !w.isActive || !w.priority || !w.priorityEndAt) continue;
        const endAt = Date.parse(w.priorityEndAt);
        if (!Number.isFinite(endAt) || endAt <= now) continue;
        const attCid = w.attacker && w.attacker.country;
        const defCid = w.defender && w.defender.country;
        const otherCid = w.priority === attCid ? defCid : attCid;
        if (!otherCid) continue;
        const pair = nearestRegionPair(w.priority, otherCid);
        if (!pair) continue; // neither side resolvable to any position at all — nothing to anchor on
        // The other side holding zero CURRENT regions (fully conquered — possibly by a third party
        // entirely, not this war) means their half of `pair` is really just their core/historical
        // centroid, not anywhere they actually still are — an arrow pointing there would land on
        // wherever their last-held region happened to be, reading as if the front line were still
        // there. Flagged here so drawWarPriority can show a plain "PRIO" label instead of a
        // (misleading) arrow, anchored at the priority holder's own real position.
        const otherRegions = currentRegionsByCountry[otherCid];
        const otherHasNoRegions = !otherRegions || !otherRegions.length;
        out.push({
          warId: w._id, priorityCid: w.priority, otherCid, priorityEndAt: endAt,
          originPos: pair[0], targetPos: pair[1], otherHasNoRegions,
        });
      }
      return out;
    } catch (_) { return []; }
  };

  // Every currently-active-priority war shows up in BOTH sides' country war lists (attacker's and
  // defender's), so this fans out across ALL countries and dedupes by warId — same "loop everyone,
  // merge by id" shape as buildActiveBattleIndex, just for wars instead of battles.
  const scanAllWarPriorities = async () => {
    if (warPriorityScanInFlight) return;
    warPriorityScanInFlight = true;
    try {
      const cids = Object.keys(countryMeta);
      const results = await mapLimit(cids, WAR_CONCURRENCY, fetchCountryWarPriorities);
      const merged = new Map();
      for (const list of results) for (const w of list) merged.set(w.warId, w);
      activeWarPriorities.clear();
      for (const [id, w] of merged) activeWarPriorities.set(id, w);
    } finally {
      warPriorityScanInFlight = false;
    }
    drawWarPriority();
  };

  // Guarded on `ready` (buildLookups() having actually finished, so countryMeta is populated) — a
  // "warPriorityConfig" message can arrive (from overlay.js's boot-time storage read) before that,
  // since content scripts don't queue postMessage against each other's readiness. Without this
  // guard, a too-early call would scan zero countries, find nothing, and then start()'s later
  // applyWarPriorityMode() call would no-op against ensureWarPriorityTimer's "already have a timer"
  // check — leaving the feature silently empty until the user manually re-toggles it.
  const ensureWarPriorityTimer = () => {
    if (warPriorityTimer || !ready) return;
    scanAllWarPriorities();
    warPriorityTimer = setInterval(scanAllWarPriorities, WAR_PRIORITY_POLL_MS);
  };
  const stopWarPriorityTimer = () => {
    if (warPriorityTimer) { clearInterval(warPriorityTimer); warPriorityTimer = null; }
  };

  const fmtCountdown = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    if (h > 0) return `${h}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
    const m = Math.floor(s / 60);
    return `${m}m${String(s % 60).padStart(2, "0")}s`;
  };

  // A region's position (used as both endpoints above) is also where WarEra draws its own
  // resource/battle icons and its name label — starting/ending the arrow exactly there covers them
  // up. Trims `pts` (screen-space {x,y}, 2+ points — a straight flat-mode line or a globe-mode
  // sampled arc) inward by a given pixel distance from each end, walking along the polyline's
  // actual arc length so it works the same for either shape. If the line's too short to trim both
  // ends without crossing, it's left alone rather than collapsing to a point or reversing direction.
  // The margin itself is computed per-frame in drawWarPriority (see WAR_ARROW_MARGIN_PX below) since
  // it needs to scale with the map's current zoom, not be a flat constant. Dampened (0.5x rate, i.e.
  // a full doubling takes +2 zoom levels, not +1) and clamped to a narrower range than a straight
  // 2^zoom curve would give — an undamped curve looked fine near the reference zoom but read as too
  // thin/small at the lowest zoom and too thick/large at the highest, since the two are many zoom
  // levels apart on this map.
  const WAR_ARROW_ZOOM_DAMPING = 0.5;
  const WAR_ARROW_MARGIN_PX = 32;      // margin at WAR_ARROW_MARGIN_REF_ZOOM
  const WAR_ARROW_MARGIN_REF_ZOOM = 4; // matches NATIVE_LABEL_MAXZOOM — where this value was tuned
  const WAR_ARROW_MARGIN_MIN_PX = 8;   // floor for very zoomed-out views — still separates line from icon
  const WAR_ARROW_MARGIN_MAX_PX = 40;  // ceiling for very zoomed-in views — no need to trim more than this
  // Same zoom scaling as the margin above, applied to the line's stroke-width.
  const WAR_ARROW_STROKE_PX = 3;       // stroke width at WAR_ARROW_MARGIN_REF_ZOOM
  const WAR_ARROW_STROKE_MIN_PX = 2;
  const WAR_ARROW_STROKE_MAX_PX = 4.5;
  // Arrowhead size — deliberately its OWN scale, not tied to the (now thicker) line stroke-width
  // above, since it's meant to stay the same smaller size it already had. Values reproduce what a
  // markerUnits="strokeWidth" marker with markerWidth=7 rendered at the line's PREVIOUS thickness
  // (base 2px, 1.25-3px range) — see ensureSvg's wdl-war-arrowhead for why it's userSpaceOnUse now.
  const WAR_ARROW_HEAD_PX = 14;
  const WAR_ARROW_HEAD_MIN_PX = 9;
  const WAR_ARROW_HEAD_MAX_PX = 21;
  // A short arrow (bordering regions) combined with a large zoomed-in margin can ask to trim away
  // more than the line's whole length. The margin and the line's on-screen length both scale with
  // zoom at close to the same rate, so as they cross that point during a continuous zoom gesture,
  // a hard "does it fit?" branch here would make the rendered line visibly SNAP between its full
  // untrimmed length and a barely-trimmed sliver right at the crossover — that was the "resets a
  // couple times" popping. Capping each side's margin to a FRACTION of the total length instead
  // makes the trim shrink smoothly as the line gets relatively shorter, with no branch to cross.
  const WAR_ARROW_MAX_TRIM_FRACTION = 0.35; // per side — leaves at least 30% of the line visible
  const trimPolylineEnds = (pts, startPx, endPx) => {
    if (pts.length < 2) return pts;
    const segLens = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      segLens.push(len);
      total += len;
    }
    const maxEachSide = total * WAR_ARROW_MAX_TRIM_FRACTION;
    const startTrim = Math.min(startPx, maxEachSide);
    const endTrim = Math.min(endPx, maxEachSide);
    const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const pointAtDistance = (dist) => {
      let acc = 0;
      for (let i = 0; i < segLens.length; i++) {
        if (acc + segLens[i] >= dist) {
          return { segIdx: i, point: lerp(pts[i], pts[i + 1], segLens[i] > 0 ? (dist - acc) / segLens[i] : 0) };
        }
        acc += segLens[i];
      }
      return { segIdx: segLens.length - 1, point: pts[pts.length - 1] };
    };
    const start = pointAtDistance(startTrim);
    const end = pointAtDistance(total - endTrim);
    const out = [start.point];
    for (let i = start.segIdx + 1; i <= end.segIdx; i++) out.push(pts[i]);
    out.push(end.point);
    return out;
  };

  // A globe-mode arc already curves for long distances (it follows the sphere's great circle,
  // which visibly bows for a far-apart pair of regions) but reads as a dead-straight line for a
  // short one — same as every flat-mode line, always straight regardless of distance. Adds a
  // consistent perpendicular bulge on top of either case (screen space, after projection) so every
  // arrow gets a slight bend, not just the long globe-mode ones. `pts` may be as few as the 2 raw
  // endpoints (flat mode) — those get evenly resampled first since a 2-point line has no
  // intermediate point to actually bend.
  const WAR_ARROW_SAMPLES = 16;
  const WAR_ARROW_BEND_FRACTION = 0.08; // perpendicular bulge, as a fraction of the straight-line distance
  const WAR_ARROW_BEND_MAX_PX = 28;     // cap so a very long arrow doesn't bow out absurdly far
  const bendPolyline = (pts) => {
    if (pts.length < 2) return pts;
    let base = pts;
    if (base.length === 2) {
      const [A, B] = base;
      base = [];
      for (let i = 0; i <= WAR_ARROW_SAMPLES; i++) {
        const t = i / WAR_ARROW_SAMPLES;
        base.push({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t });
      }
    }
    const A = base[0], B = base[base.length - 1];
    const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len; // perpendicular unit vector — consistent bend side
    const bend = Math.min(len * WAR_ARROW_BEND_FRACTION, WAR_ARROW_BEND_MAX_PX);
    const n = base.length - 1;
    return base.map((p, i) => {
      const off = bend * Math.sin((i / n) * Math.PI); // 0 at both ends, peak at the middle
      return { x: p.x + nx * off, y: p.y + ny * off };
    });
  };

  // warId -> { g, path, halo, core, label } — pooled per active-priority war, same reuse pattern
  // as countryArcEls (rebuilt from activeWarPriorities every call, elements only added/removed as
  // wars gain/lose an active priority).
  const warPriorityEls = new Map();
  const drawWarPriority = () => {
    if (!gWarPriority) return;
    if (!warPriorityEnabled) { gWarPriority.style.display = "none"; return; }
    gWarPriority.style.display = "";
    const now = Date.now();
    const live = new Set();
    // Shared by every war this frame — zoom doesn't change war-to-war. Also drives the arrowhead's
    // size for free: an SVG <marker> defaults to markerUnits="strokeWidth", scaling its content by
    // the referencing path's current stroke-width, so scaling stroke-width scales the arrowhead too
    // without touching the <marker> def itself (see ensureSvg's wdl-war-arrowhead).
    const zoomScale = Math.pow(2, (map.getZoom() - WAR_ARROW_MARGIN_REF_ZOOM) * WAR_ARROW_ZOOM_DAMPING);
    const margin = Math.max(WAR_ARROW_MARGIN_MIN_PX, Math.min(WAR_ARROW_MARGIN_MAX_PX, WAR_ARROW_MARGIN_PX * zoomScale));
    const strokeWidth = Math.max(WAR_ARROW_STROKE_MIN_PX, Math.min(WAR_ARROW_STROKE_MAX_PX, WAR_ARROW_STROKE_PX * zoomScale));
    if (warArrowMarker) {
      const headSize = Math.max(WAR_ARROW_HEAD_MIN_PX, Math.min(WAR_ARROW_HEAD_MAX_PX, WAR_ARROW_HEAD_PX * zoomScale));
      warArrowMarker.setAttribute("markerWidth", String(headSize));
      warArrowMarker.setAttribute("markerHeight", String(headSize));
    }
    for (const [warId, w] of activeWarPriorities) {
      if (w.priorityEndAt <= now) continue; // expired since the last scan — next scan drops it for good
      const origin = w.originPos, target = w.targetPos;
      if (!origin || !target) continue;
      live.add(warId);
      let e = warPriorityEls.get(warId);
      if (!e) {
        const g = document.createElementNS(NS, "g");
        // Faded at the origin end, full color by two-thirds of the way along — own gradient per
        // war (not a shared one) since its x1/y1/x2/y2 have to track that war's own line each
        // frame, same reasoning as makeCountryArc's per-battle gradient below.
        const grad = document.createElementNS(NS, "linearGradient");
        grad.setAttribute("gradientUnits", "userSpaceOnUse");
        grad.id = "wdlwg-" + warId;
        const s0 = document.createElementNS(NS, "stop"); s0.setAttribute("offset", "0");
        s0.setAttribute("stop-color", WAR_PRIORITY_COLOR); s0.setAttribute("stop-opacity", "0.25");
        const s1 = document.createElementNS(NS, "stop"); s1.setAttribute("offset", "0.667");
        s1.setAttribute("stop-color", WAR_PRIORITY_COLOR); s1.setAttribute("stop-opacity", "1");
        grad.append(s0, s1);
        defsEl.appendChild(grad);
        const path = document.createElementNS(NS, "path");
        path.setAttribute("fill", "none"); path.setAttribute("stroke", `url(#${grad.id})`);
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("marker-end", "url(#wdl-war-arrowhead)");
        const label = document.createElementNS(NS, "text");
        label.setAttribute("text-anchor", "middle"); label.setAttribute("font-size", "11");
        label.setAttribute("font-family", FLAG_FONT); label.setAttribute("font-weight", "600");
        label.setAttribute("fill", "#fff"); label.style.paintOrder = "stroke";
        label.style.stroke = "#000"; label.style.strokeWidth = "2px"; label.style.strokeLinejoin = "round";
        g.append(path, label);
        gWarPriority.appendChild(g);
        e = { g, path, grad, label };
        warPriorityEls.set(warId, e);
      }
      // The other side holding zero current regions means `target` is really just their core
      // centroid, not anywhere they actually still hold — an arrow there would misleadingly point
      // at wherever the front line used to be. Show a plain "PRIO <countdown>" label at the
      // priority holder's own (real) position instead of drawing a line to a place they aren't.
      if (w.otherHasNoRegions) {
        const originOcc = isOccludedOnGlobe(origin);
        e.g.style.display = originOcc ? "none" : "";
        e.path.style.display = "none";
        const op = map.project(origin);
        e.label.setAttribute("x", op.x); e.label.setAttribute("y", op.y - 6);
        e.label.textContent = `PRIO ${fmtCountdown(w.priorityEndAt - now)}`;
        e.label.style.display = "";
        continue;
      }
      const originOcc = isOccludedOnGlobe(origin), targetOcc = isOccludedOnGlobe(target);
      e.g.style.display = (originOcc && targetOcc) ? "none" : "";
      let rawPts;
      if (isGlobeMode()) {
        rawPts = [];
        for (let i = 0; i <= GLOBE_ARC_SAMPLES; i++) rawPts.push(map.project(slerpLngLat(origin, target, i / GLOBE_ARC_SAMPLES)));
      } else {
        rawPts = [map.project(origin), map.project(target)];
      }
      const pts = trimPolylineEnds(bendPolyline(rawPts), margin, margin);
      const d = pts.map((p, i) => (i ? "L " : "M ") + p.x + " " + p.y).join(" ");
      const mid = pts[Math.floor(pts.length / 2)];
      const first = pts[0], last = pts[pts.length - 1];
      e.grad.setAttribute("x1", first.x); e.grad.setAttribute("y1", first.y);
      e.grad.setAttribute("x2", last.x); e.grad.setAttribute("y2", last.y);
      e.path.setAttribute("d", d);
      e.path.setAttribute("stroke-width", String(strokeWidth));
      e.path.style.display = targetOcc ? "none" : "";
      e.label.setAttribute("x", mid.x); e.label.setAttribute("y", mid.y - 6);
      e.label.textContent = fmtCountdown(w.priorityEndAt - now);
      e.label.style.display = targetOcc ? "none" : "";
    }
    for (const [warId, e] of warPriorityEls) {
      if (!live.has(warId)) { e.g.remove(); e.grad.remove(); warPriorityEls.delete(warId); }
    }
  };

  const applyWarPriorityMode = () => {
    if (warPriorityEnabled) { ensureWarPriorityTimer(); drawWarPriority(); }
    else { stopWarPriorityTimer(); if (gWarPriority) gWarPriority.style.display = "none"; }
  };

  const setWarPriorityEnabled = (on) => {
    warPriorityEnabled = !!on;
    applyWarPriorityMode();
  };

  const makeCountryArc = (battleId) => {
    const grad = document.createElementNS(NS, "linearGradient");
    grad.setAttribute("gradientUnits", "userSpaceOnUse");
    grad.id = "wdlcg-" + battleId;
    // 4 stops instead of 2: a hard attacker(red)->defender(blue) color switch positioned at that
    // battle's damage ratio (see drawCountry), while opacity still fades smoothly from faint at the
    // source to solid at the region across the whole line — same fade as before, now split by color.
    const s0 = document.createElementNS(NS, "stop"); s0.setAttribute("offset", "0");
    const sMidA = document.createElementNS(NS, "stop");
    const sMidB = document.createElementNS(NS, "stop");
    const s1 = document.createElementNS(NS, "stop"); s1.setAttribute("offset", "1");
    grad.append(s0, sMidA, sMidB, s1);
    defsEl.appendChild(grad);
    const path = document.createElementNS(NS, "path");
    path.setAttribute("fill", `url(#${grad.id})`);
    path.setAttribute("stroke", "none");
    gCountryArcs.appendChild(path);
    return { path, grad, s0, sMidA, sMidB, s1 };
  };

  const drawCountry = () => {
    if (!gCountryArcs) return;
    const p = activeCountryPanelId ? countryPanels.get(activeCountryPanelId) : null;
    const sel = p ? p.sel : null;
    // A MU has no map position of its own — anchor at its home country's position instead (see
    // sendMuList/muMeta above).
    const originId = sel && p.entityType === "mu" ? (muMeta[sel] && muMeta[sel].countryId) : sel;
    const origin = originId && countryPos[originId];
    if (!countryEnabled || !origin) {
      gCountryArcs.style.display = "none";
      if (gCountryNodes) gCountryNodes.style.display = "none";
      return;
    }
    gCountryArcs.style.display = "";
    gCountryNodes.style.display = "";
    const op = map.project(origin);
    const originOcc = isOccludedOnGlobe(origin);
    const entries = [...p.targets.entries()];
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
      // Red (attacker) fades into blue (defender) at the point along the line matching this
      // battle's damage ratio — see makeCountryArc for why this needs 4 stops, not 2.
      const ratio = Math.max(0, Math.min(1, t.ratio));
      const opAtRatio = (0.30 + (0.95 - 0.30) * ratio).toFixed(3);
      e.s0.setAttribute("stop-color", ATT); e.s0.setAttribute("stop-opacity", "0.30");
      e.sMidA.setAttribute("offset", String(ratio)); e.sMidA.setAttribute("stop-color", ATT); e.sMidA.setAttribute("stop-opacity", opAtRatio);
      e.sMidB.setAttribute("offset", String(ratio)); e.sMidB.setAttribute("stop-color", DEF); e.sMidB.setAttribute("stop-opacity", opAtRatio);
      e.s1.setAttribute("stop-color", DEF); e.s1.setAttribute("stop-opacity", "0.95");
      e.path.style.display = (originOcc || isOccludedOnGlobe(rp)) ? "none" : "";
      e.path.classList.toggle("wdl-cpulse", (p.pulseUntil.get(battleId) || 0) > Date.now());
    }
    for (const [battleId, e] of countryArcEls) {
      if (!live.has(battleId)) { e.path.remove(); e.grad.remove(); countryArcEls.delete(battleId); }
    }
    // origin node at the active window's country
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
    drawWarPriority();
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
      history: snap.history || [],
      startedAt: snap.startedAt || null,
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
    activeCountryPanelId = null; // a tracker panel becoming active always takes over from any country window
    draw(true); // swap SVG visibility immediately — no waiting on the next tick
  };

  // A "Country damage" window was clicked — it becomes the thing drawing lines on the map instead
  // of whichever tracker panel was active (activePanelId=null suppresses every tracker battle's
  // lines, see the activeBattleId computation in draw()).
  const setActiveCountryPanel = (panelId) => {
    activePanelId = null;
    activeCountryPanelId = panelId;
    draw(true);
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
      // wdlEnabled — the tracker windows' own toggle. Deliberately does NOT touch anything
      // "by country" (see the separate "countryConfig" message) — the two features are independent.
      enabled = d.enabled !== false;
      draw(true);
    }
    else if (d.kind === "countryConfig") {
      // wdlCountryEnabled — independent of `enabled` above, see countryEnabled's declaration.
      countryEnabled = d.enabled !== false;
      if (!countryEnabled) {
        for (const id of countryPanels.keys()) stopCountryTimers(id);
        if (countryIndexTimer) { clearInterval(countryIndexTimer); countryIndexTimer = null; }
      } else {
        for (const [id, p] of countryPanels) if (p.sel) startCountryTimers(id);
      }
      draw(true);
    }
    else if (d.kind === "registerPanel") registerPanel(d.panelId);
    else if (d.kind === "unregisterPanel") unregisterPanel(d.panelId);
    else if (d.kind === "selectBattle") selectBattle(d.panelId, d.battleId || null);
    else if (d.kind === "setActivePanel") setActivePanel(d.panelId);
    else if (d.kind === "setCountryActive") setActiveCountryPanel(d.panelId);
    else if (d.kind === "requestBattleList") buildBattleList();
    else if (d.kind === "requestCountryList") sendCountryList();
    else if (d.kind === "requestMuList") ensureMuList();
    else if (d.kind === "unregisterCountryPanel") unregisterCountryPanel(d.panelId);
    else if (d.kind === "selectCountry") selectCountry(d.panelId, d.countryId || null, d.entityType);
    else if (d.kind === "selectCountryWindow") selectCountryWindow(d.panelId, d.window);
    else if (d.kind === "coreColors") setCoreColorsEnabled(d.enabled);
    else if (d.kind === "regionStatus") setRegionStatusEnabled(d.enabled);
    else if (d.kind === "proxyConfig") setProxyEnabled(d.enabled);
    else if (d.kind === "proxyData") setProxyData(d.data);
    else if (d.kind === "warPriorityConfig") setWarPriorityEnabled(d.enabled);
  });

  // Clicking a battle pin on the map navigates WarEra's SPA to /battle/<id> without a full page
  // reload, so there's no "click" event this content script can directly observe — polled here
  // (piggybacking the existing 1s tick) the same way battle-money-totals.js detects battle-page
  // navigation elsewhere in this extension. Always posts (battleId is null off a battle page too),
  // so the overlay's own "currently open battle page" cache stays correct after navigating away —
  // not just while landing on one. The overlay decides what to do with it (see the
  // "battlePageOpened" handling near the bottom of overlay.js): fills the FIRST tracker window that
  // doesn't have a battle open yet, if any and if no OTHER window already has that same battle —
  // leaves everything else untouched. `force` bypasses the "only when it changed" check, for the
  // one-off call at startup: if the page is ALREADY on a battle when the engine finishes loading,
  // that still needs to be reported once, even though lastNavPath was seeded with that same path.
  const checkBattleNav = (force) => {
    const path = location.pathname;
    if (!force && path === lastNavPath) return;
    lastNavPath = path;
    const m = path.match(/^\/battle\/([a-fA-F0-9]{24})/);
    window.postMessage({ __wdl: CHANNEL, kind: "battlePageOpened", battleId: m ? m[1] : null }, location.origin);
  };

  const start = async () => {
    ensureSvg();
    try { ready = await buildLookups(); } catch (_) { ready = false; }
    if (!ready) { setTimeout(start, 1500); return; }
    map.on("render", () => { draw(false); repositionCoreFlags(); repositionProxyFlags(); repositionRegionStatusIcons(); });   // reproject only
    setInterval(() => {
      draw(true);           // refresh rates + push summaries
      if (coreColorsEnabled) applyColorMode(); // self-heal if WarEra's app wiped our layer
      if (regionStatusEnabled) applyRegionStatusMode(); // same self-heal, for the region-status layer
      checkBattleNav();
    }, 1000);
    draw(true);
    applyColorMode(); // picks up a toggle message that may have arrived before we were ready
    applyRegionStatusMode();
    applyProxyMode();
    applyWarPriorityMode();
    checkBattleNav(true); // report "already on a battle page" once, if that's where we loaded
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
