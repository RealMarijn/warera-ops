// WarEra Ops — Military bases / bunkers map overlay (MAIN world engine + renderer).
//
// Badges every region that has an ACTIVE or soon-to-be-active ("pending") military base and/or
// bunker, ON TOP of the game's normal map — the game itself has no such at-a-glance view. Data
// comes from our whitelist-gated backend (see docs/using-the-backend.md), which the ISOLATED
// overlay (base-overlay.js) polls every 2 min and forwards here; this engine owns the map geometry
// (region positions + names, from region.getRegionsObject) and does the join + drawing + the
// "something new lit up" diff that drives the notification toasts.
//
// Same overlay technique as tools/dmg-lines/map.js: an SVG injected INTO the MapLibre container,
// reprojected on every map render. This engine has no chrome.runtime access (MAIN world), so ALL
// backend data arrives via postMessage from the ISOLATED overlay.
//
// Messages (discriminator __wbm: "warera-base-map"):
//   in  { kind:"config", enabled:{bases,bunkers} }   which layers to draw (already AND-ed with login)
//   in  { kind:"data",   bases?, bunkers? }           status maps { regionId: {s,l,t?} }; layer omitted = unchanged
//   out { kind:"notify", items:[{layer,regionId,name,status,t,level}] }  newly active/pending regions
(() => {
  "use strict";
  if (window.top !== window) return;
  try { document.documentElement.dataset.wbmEngine = "0.10.1"; } catch (_) {}
  console.log("[WBM] base-map.js engine v0.10.1 loaded");

  const CHANNEL = "warera-base-map";
  const NS = "http://www.w3.org/2000/svg";
  const LAYERS = ["bases", "bunkers"]; // status-based upgrade layers (active/pending/disabled)
  // Per-layer badge colour + label — the exact accent colors from the user's
  // own icon artwork (sword_with_outer_rim.svg / shield_with_outer_rim.svg),
  // not a separately chosen palette. Positioning offset (when this region
  // also has a badge from another layer/engine) comes from badgeOffset()
  // below, not a fixed per-layer value. Resistance has no fixed color (see
  // resistanceColor below — it's a live health gradient, set per-update).
  const LAYER = {
    bases:      { color: "#ffcea5", label: "Military base" },
    bunkers:    { color: "#a6d1f2", label: "Bunker" },
    resistance: { color: null,      label: "Resistance" },
  };
  const RELEVANT = new Set(["a", "p"]); // active / pending — what we draw and notify on

  let map = null;
  let started = false;
  let ready = false;
  const enabled = { bases: false, bunkers: false, resistance: false };
  const data = { bases: null, bunkers: null, resistance: null }; // {regionId:{s,l,t?}} / {regionId:{r,m}}
  const prev = { bases: null, bunkers: null };            // Set<regionId> of last-seen relevant regions (bases/bunkers only — resistance has no toast/notify)
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

  // ---- cross-engine badge layout (shared with tools/sr-map/sr-map.js) ---
  // Bases, bunkers and strategic resources are drawn by two INDEPENDENT
  // MAIN-world engines (this file, and sr-map.js) that otherwise know
  // nothing about each other — but they run in the same page realm, so a
  // plain window global is the simplest way for them to agree on how many
  // badge "slots" a given region needs and which slot is this engine's,
  // without either one owning the other's data. Each engine publishes the
  // set of regionIds it currently has a badge on for each of its own layer
  // keys; badgeOffset() below reads ALL engines' published sets to place its
  // own badge relative to true region center instead of a hardcoded fixed
  // offset (which used to shift bases/bunkers off-center even when no other
  // badge was present in that region at all).
  const BADGE_TYPES = ["bases", "bunkers", "sr", "resistance"];
  const badgeRegistry = (window.__wdlBadgeRegistry = window.__wdlBadgeRegistry || {
    bases: new Set(), bunkers: new Set(), sr: new Set(), resistance: new Set(),
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
  // Symmetric pair / equilateral-ish triangle / diamond, all centered on
  // (0,0) so the GROUP of badges reads as centered on the region even though
  // no single badge sits exactly on the point anymore. Resistance is common
  // enough (most owned regions have some) that 4-badge regions (base +
  // bunker + SR + resistance, all at once) are a real case, not just a
  // theoretical one.
  const BADGE_OFFSET_PAIR = [[-14, 0], [14, 0]];
  const BADGE_OFFSET_TRIANGLE = [[0, -16], [-14, 9], [14, 9]];
  const BADGE_OFFSET_QUAD = [[0, -16], [16, 0], [0, 16], [-16, 0]];
  const badgeOffset = (myKey, regionId) => {
    const present = BADGE_TYPES.filter((k) => badgeRegistry[k] && badgeRegistry[k].has(regionId));
    const idx = present.indexOf(myKey);
    if (idx === -1 || present.length <= 1) return [0, 0];
    if (present.length === 2) return BADGE_OFFSET_PAIR[idx];
    if (present.length === 3) return BADGE_OFFSET_TRIANGLE[idx];
    return BADGE_OFFSET_QUAD[idx];
  };
  window.addEventListener("wdl-badge-registry-changed", () => draw());

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

  // Each layer's icon is now hand-designed as a matched outer/inner PAIR
  // (user-supplied SVGs — sword for bases, shield for bunkers, an armor
  // shape for resistance), rather than us deriving an "outer" by crudely
  // rescaling a single shape (which never hugged thin/off-center parts like
  // a sword's hilt correctly no matter how the scale ratio was tuned). Both
  // paths per layer share one center + one scale, computed from the outer
  // path's own bounding box (outerStrokeWidth is the designer's original
  // border thickness in that same coordinate space, scaled down naturally
  // along with everything else by the transform below — not reproduced by
  // us). `outerD`/`innerD` are the raw path data exactly as supplied.
  const ICONS = {
    bases: { // sword_with_outer_rim.svg
      outerD:
        "m 488.37203,183.39046 -44.05695,-0.49728 -0.001,-0.001 -71.77021,71.77021 -13.45747,-13.45747 " +
        "-33.62598,33.62598 16.03418,16.03417 -14.43548,14.43548 c -3.40685,3.40685 -3.34422,8.95534 " +
        "0.14041,12.43997 l 26.36336,26.36336 c 3.48462,3.48463 9.03278,3.54692 12.43962,0.14007 l " +
        "14.43548,-14.43548 14.56347,14.56347 33.62598,-33.62599 -11.52652,-11.52652 71.77021,-71.7702 " +
        "-10e-4,-0.001 z",
      innerD:
        "m 451.61605,201.94356 -76.87312,76.87312 -13.98629,-13.98606 -9.10844,9.10844 16.29524,16.29524 " +
        "-20.54245,20.54245 c -2.51943,2.51943 -2.47617,6.63252 0.0968,9.20552 l 4.68395,4.68395 c 2.573," +
        "2.573 6.68583,2.61626 9.20527,0.0968 l 20.80444,-20.47455 16.09932,16.29316 9.10869,-9.10842 " +
        "-13.98631,-13.9863 76.87312,-76.87312 -0.19434,-18.47591 z",
      cx: 406.2617, cy: 265.27149, outerStrokeWidth: 6.45436,
    },
    bunkers: { // shield_with_outer_rim.svg
      outerD:
        "m 422.21805,375.50796 -61.33962,27.26222 v 40.89309 c 0,37.82588 26.17156,73.19848 61.33962," +
        "81.78615 35.16804,-8.58767 61.33961,-43.96027 61.33961,-81.78615 v -40.89309 z",
      innerD:
        "m 422.22007,399.6465 -41.45291,18.57387 v 27.86039 c 0,25.77094 17.68664,49.87041 41.45291," +
        "55.72122 23.76626,-5.85081 41.45292,-29.95028 41.45292,-55.72122 v -27.86039 z",
      cx: 422.218045, cy: 450.47869, outerStrokeWidth: 6.815,
    },
    resistance: { // resistance_with_outer_rim.svg
      outerD:
        "m 409.57611,535.88249 c -3.89168,0 -7.02498,3.1333 -7.02498,7.02497 v 2.42043 h -19.31542 c " +
        "-3.90226,0 -7.04361,3.14191 -7.04361,7.04422 v 2.66297 h -18.40572 c -5.29871,0 -9.56469,4.26541 " +
        "-9.56469,9.56414 v 33.98388 h -0.005 v 32.46922 h 0.0278 v 12.60083 h 0.0295 a 20.94177," +
        "6.8856939 58.791421 0 0 7.4999,19.45677 20.94177,6.8856939 58.791421 0 0 10.80914,11.76012 v " +
        "22.52964 h 88.25679 v -23.98722 a 6.8039079,20.354311 32.396348 0 0 10.74919,-11.2671 " +
        "6.8039079,20.354311 32.396348 0 0 7.4999,-18.49221 h 0.0187 v -30.50786 a 15.551155,17.76823 0 " +
        "0 0 0.007,-0.11761 15.551155,17.76823 0 0 0 -8.9846,-16.104 c 0.009,-0.14662 0.022,-0.29203 " +
        "0.022,-0.44101 v -44.11056 c 0,-3.90231 -3.14135,-7.04422 -7.04363,-7.04422 h -19.822 v " +
        "-2.42043 c 0,-3.89167 -3.1333,-7.02497 -7.02495,-7.02497 z",
      innerD:
        "m 425.84264,595.43308 v -34.68059 c 0,-2.129 -1.7244,-3.8534 -3.8534,-3.8534 h -7.7068 c " +
        "-2.12901,0 -3.8534,1.7244 -3.8534,3.8534 v 35.38625 c 1.20901,-0.42869 2.49026,-0.70566 " +
        "3.84617,-0.70566 z m 30.8272,23.11799 c -0.003,-8.5112 -6.90241,-15.41119 -15.4112,-15.41119 " +
        "h -27.0075 c -2.11456,0 -3.82932,1.70272 -3.82932,3.81727 v 0.13487 c 0,6.32681 5.12984,11.46146 " +
        "11.45664,11.46146 h 8.49192 c 2.33131,0 3.17906,0.8622 3.17906,1.9267 v 3.90157 c 0,1.03319 " +
        "-0.86461,1.87371 -1.8978,1.9267 -10.72209,0.54911 -15.45214,5.95109 -23.13244,17.47276 l " +
        "-1.51968,2.28072 a 1.9252546,1.9252546 0 0 1 -2.67089,0.53467 l -3.20554,-2.13864 a 1.9252546," +
        "1.9252546 0 0 1 -0.53467,-2.67089 l 1.51969,-2.28073 c 3.78837,-5.68376 7.27329,-10.41863 " +
        "11.39402,-13.98784 -4.15926,-1.32701 -7.5623,-4.36398 -9.36135,-8.29685 -1.58712,0.82126 " +
        "-3.3621,1.32942 -5.26712,1.32942 h -7.7068 c -2.97193,0 -5.65727,-1.15843 -7.70679,-3.00565 " +
        "-2.05194,1.84964 -4.73728,3.00806 -7.7068,3.00806 h -7.7068 c -1.35833,0 -2.64199,-0.27696 " +
        "-3.8534,-0.71047 v 18.76846 c 0,8.17643 3.24649,16.01569 9.029,21.7982 l 6.38219,6.3846 v " +
        "15.4136 h 61.64957 v -15.40396 l 8.64847,-8.65089 a 23.128824,23.128824 0 0 0 6.77236,-16.35527 " +
        "z m -7.70921,-21.69705 v -28.39473 c 0,-2.129 -1.7244,-3.85339 -3.85341,-3.85339 h -7.70679 " +
        "c -2.129,0 -3.8534,1.72439 -3.8534,3.85339 v 26.97379 h 7.7068 c 2.71664,0 5.28397,0.55634 " +
        "7.7068,1.42094 z m -80.91416,13.99267 h 7.7068 c 2.129,0 3.85339,-1.7244 3.85339,-3.85341 " +
        "v -30.82719 c 0,-2.129 -1.72439,-3.8534 -3.85339,-3.8534 h -7.7068 c -2.129,0 -3.8534,1.7244 " +
        "-3.8534,3.8534 v 30.82719 c 0,2.12901 1.7244,3.85341 3.8534,3.85341 z m 23.11799,0 h 7.70679 " +
        "c 2.12901,0 3.85341,-1.7244 3.85341,-3.85341 v -38.53399 c 0,-2.129 -1.7244,-3.85339 " +
        "-3.85341,-3.85339 h -7.70679 c -2.12901,0 -3.85341,1.72439 -3.85341,3.85339 v 38.53399 " +
        "c 0,2.12901 1.7244,3.85341 3.85341,3.85341 z",
      cx: 410.66565, cy: 616.64108, outerStrokeWidth: 4.67539,
    },
  };
  // One scale per layer (not two) — outer/inner are already correctly
  // proportioned relative to each other in the source artwork, so all that's
  // needed is bringing the whole combined shape down to badge size (~20px
  // across, matching the old plain-circle badge's footprint).
  const ICON_SCALE = { bases: 0.121, bunkers: 0.1334, resistance: 0.1238 };
  const BIG_FILL = "#0b0d12"; // near-black, matches the corner level-bubble's own dark fill

  const makeIconPath = (layer, d) => {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    return path;
  };

  // Higher resistance reads as MORE dangerous (a harder target), not
  // healthier — so red is high, green is low, the opposite of a typical
  // health bar. No fixed color for this layer (see LAYER.resistance); this
  // is computed live per-update instead.
  const resistanceColor = (pct) => {
    const clamped = Math.max(0, Math.min(100, pct));
    return `hsl(${Math.round((100 - clamped) * 1.2)}, 72%, 46%)`; // 100=red, 50=yellow, 0=green
  };

  const makeBadge = (layer) => {
    const g = document.createElementNS(NS, "g");
    // One filter for the WHOLE badge (not per-shape) — confirmed live that
    // giving only the outer icon its own drop-shadow, while the inner icon
    // and ring had none, made the two appear to drift apart from each other
    // while panning: a filtered element gets composited on its own layer
    // with different sub-pixel rounding than its unfiltered siblings, so
    // continuous position updates (draw() re-translates this group on every
    // map render) made them visibly "swim" relative to one another. One
    // shared filter on the group keeps everything pixel-locked together.
    g.style.filter = "drop-shadow(0 1px 2px rgba(0,0,0,.55))";
    // Pending-pulse glow — stays a plain circle (a subtle animated ring
    // behind the icon; matching the icon's own silhouette isn't worth the
    // complexity for this, and it only ever shows for bases/bunkers anyway).
    const ring = document.createElementNS(NS, "circle");
    ring.setAttribute("class", "wbm-ring");
    ring.setAttribute("r", "10");
    ring.setAttribute("fill", "none");
    ring.setAttribute("stroke-width", "2.5");
    // The CSS pending "breathe" animation (.wbm-pending .wbm-core, further
    // down) needs `transform-box: fill-box` on the animated element itself —
    // confirmed live that putting that AND an SVG `transform` presentation
    // attribute (the scale/center positioning below) on the very same
    // element makes browsers compute the animation's reference box wrong,
    // flinging the icon off to one side during the pulse. Fix: the
    // `wbm-core` class (and its animation) go on this plain, transform-less
    // wrapper `<g>` instead — the shape group inside it keeps its own
    // positioning transform, but is no longer the element CSS is animating.
    const bigWrap = document.createElementNS(NS, "g");
    bigWrap.setAttribute("class", "wbm-core");
    const icon = ICONS[layer];
    const shapeGroup = document.createElementNS(NS, "g");
    shapeGroup.setAttribute("transform", `scale(${ICON_SCALE[layer]}) translate(${-icon.cx} ${-icon.cy})`);
    // Outer = black fill, colored edge, drawn first (underneath).
    const big = makeIconPath(layer, icon.outerD);
    big.setAttribute("fill", BIG_FILL);
    big.setAttribute("stroke-width", String(icon.outerStrokeWidth));
    big.setAttribute("stroke-linejoin", "round");
    // Inner = solid colored fill, drawn on top. Color is set in updateBadge
    // (dynamic for resistance, static per-layer otherwise) — not here, so
    // both cases go through one code path.
    const small = makeIconPath(layer, icon.innerD);
    shapeGroup.append(big, small);
    bigWrap.appendChild(shapeGroup);
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
    g.append(ring, bigWrap, lvlBg, lvlText, cd, title);
    return { g, big, small, ring, lvlBg, lvlText, cd, title };
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
    if (d.layer === "resistance") {
      const pct = d.max > 0 ? Math.round((d.value / d.max) * 100) : 0;
      const color = resistanceColor(pct);
      b.g.setAttribute("class", "");
      b.big.setAttribute("fill-opacity", "1");
      b.big.setAttribute("stroke-dasharray", "");
      b.big.setAttribute("stroke", color);
      b.small.setAttribute("fill", color);
      b.ring.setAttribute("stroke", color);
      b.title.textContent = `Resistance — ${d.value} / ${d.max} (${pct}%)`;
      // Reuses the same corner bubble bases/bunkers use for upgrade level —
      // bare percentage (no "%"), same visual footprint, exact value is one
      // hover away via the title above.
      b.lvlText.textContent = String(pct);
      b.lvlBg.style.display = "";
      b.lvlText.style.display = "";
      b.cd.style.display = "none";
      b.cd.textContent = "";
      return;
    }
    const meta = LAYER[d.layer];
    const pending = d.status === "p";
    // Pending reads differently at a glance: pulsing ring, translucent (black)
    // fill and a dashed edge; active is a solid black rim with a crisp edge.
    b.g.setAttribute("class", pending ? "wbm-pending" : "");
    b.big.setAttribute("fill-opacity", pending ? "0.55" : "1");
    // Dash lengths are in the same pre-scale coordinate space as
    // outerStrokeWidth (~5-7) — sized proportionally to that now, not the
    // old flat "2" stroke-width these dashes were originally tuned for.
    b.big.setAttribute("stroke-dasharray", pending ? "10 7" : "");
    b.big.setAttribute("stroke", meta.color);
    b.small.setAttribute("fill", meta.color);
    b.ring.setAttribute("stroke", meta.color);
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
    const activeByLayer = { bases: new Set(), bunkers: new Set(), resistance: new Set() };
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
        activeByLayer[layer].add(id);
      }
    }
    // Resistance isn't status-based (no active/pending/disabled) — just a
    // number, so its own filter is simply "zero resistance -> no icon" per
    // the user's own framing, not the RELEVANT status-code set above.
    if (enabled.resistance && data.resistance) {
      for (const id in data.resistance) {
        const st = data.resistance[id];
        if (!st || !(st.r > 0)) continue;
        const geo = regions[id];
        if (!geo || !Array.isArray(geo.pos)) continue;
        desired.set("resistance:" + id, {
          layer: "resistance", regionId: id, value: st.r, max: st.m, pos: geo.pos, name: geo.name || id,
        });
        activeByLayer.resistance.add(id);
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
    // Publish before draw() so this same call's own positioning already sees
    // the up-to-date set (and so sr-map.js, listening for the change event,
    // repositions its own badges around ours too).
    publishBadgeRegions({ bases: activeByLayer.bases, bunkers: activeByLayer.bunkers, resistance: activeByLayer.resistance });
    draw();
  };

  const draw = () => {
    if (!ready || !svg) return;
    const anyOn = enabled.bases || enabled.bunkers || enabled.resistance;
    if (!anyOn) { svg.style.display = "none"; return; }
    svg.style.display = "";
    let cw = window.innerWidth, ch = window.innerHeight;
    try { const cv = map.getCanvas(); if (cv) { cw = cv.clientWidth || cw; ch = cv.clientHeight || ch; } } catch (_) {}
    const M = 24; // cull margin
    for (const b of badges.values()) {
      const d = b.d; if (!d) continue;
      if (isOccludedOnGlobe(d.pos)) { b.g.style.display = "none"; continue; }
      const p = map.project(d.pos);
      if (p.x < -M || p.y < -M || p.x > cw + M || p.y > ch + M) { b.g.style.display = "none"; continue; }
      const [ox, oy] = badgeOffset(d.layer, d.regionId);
      b.g.setAttribute("transform", `translate(${p.x + ox} ${p.y + oy})`);
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
      enabled.resistance = !!en.resistance; // no notify baseline needed — resistance never toasts
      if ((enabled.bases || enabled.bunkers || enabled.resistance) && !started) startEngine();
      reconcile();
    } else if (d.kind === "data") {
      let notify = [];
      for (const layer of LAYERS) {
        if (!(layer in d)) continue;          // layer omitted → unchanged
        data[layer] = d[layer] || null;
        if (enabled[layer] && ready) notify = notify.concat(diffNotify(layer));
      }
      if ("resistance" in d) data.resistance = d.resistance || null; // no diffNotify — not a toast-worthy event
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

  // region.getRegionsObject's `position` field is NOT reliably the visual
  // center of the region's shape — confirmed live (e.g. Dakar): badges landed
  // consistently off to one side, not just when paired with another badge.
  // The real "regions" map source has the actual polygon geometry already
  // loaded client-side (the game fetches it to draw the map itself), so
  // compute a proper area-weighted centroid from that instead and use it in
  // place of the position field wherever available.
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
      // Degenerate ring — fall back to a plain vertex average.
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
      for (const f of feats) {
        const rid = f.properties && f.properties.regionId;
        if (!rid || !regions[rid]) continue;
        const centroid = regionCentroidFromGeometry(f.geometry);
        if (centroid) regions[rid].pos = centroid;
      }
    } catch (err) {
      console.warn("[WBM] geometry centroid computation failed, using region.getRegionsObject position instead", err);
    }
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
    applyGeometryCentroids();
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
