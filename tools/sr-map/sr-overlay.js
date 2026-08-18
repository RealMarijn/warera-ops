// WarEra Ops — Strategic Resources overlay panel (ISOLATED world).
//
// Thin UI: a small draggable legend/filter card. Each row is a resource type with its badge
// colour + glyph + how many regions hold it, and clicking a row toggles that type on/off on the
// map. Owns the on/off state (chrome.storage `srMapEnabled`, also flipped from the popup) and the
// per-type filter (`srTypes`), and relays both to the MAIN-world engine (sr-map.js) via
// postMessage. The engine does all the map work.
(() => {
  "use strict";
  if (window.top !== window) return;
  try { document.documentElement.dataset.wsrPanel = "0.1.0"; } catch (_) {}
  console.log("[WSR] sr-overlay.js panel v0.1.0 loaded");

  const CHANNEL = "warera-sr-map";
  const ORDER = ["coal", "gold", "uranium", "diamonds", "lithium", "rareEarths"];
  const RES = {
    coal:       { color: "#4b5563", fg: "#ffffff", glyph: "C",  label: "Coal" },
    gold:       { color: "#f2c14e", fg: "#1a1400", glyph: "Au", label: "Gold" },
    uranium:    { color: "#7ee787", fg: "#08240f", glyph: "U",  label: "Uranium" },
    diamonds:   { color: "#7fd7ff", fg: "#062230", glyph: "◆",  label: "Diamonds" },
    lithium:    { color: "#c792ff", fg: "#1c0630", glyph: "Li", label: "Lithium" },
    rareEarths: { color: "#ff9f6b", fg: "#301300", glyph: "RE", label: "Rare earths" },
  };

  let enabled = false;
  let types = {};        // { coal:true, ... }
  let counts = {};
  let host, root, els;
  ORDER.forEach((k) => (types[k] = true));

  const esc = (s) => String(s == null ? "" : s).replace(/[<>&"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

  const CSS = `
    :host { all: initial; }
    .panel { position: fixed; top: 24px; right: 24px; width: 210px; z-index: 2147483646;
      box-sizing: border-box; font-family: "Saira", system-ui, sans-serif; color: #e8e8ea;
      background: rgba(18,20,26,.92); border: 1px solid rgba(255,255,255,.12);
      border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.5); }
    .hdr { display:flex; align-items:center; gap:8px; padding:8px 10px; cursor:move;
      border-bottom:1px solid rgba(255,255,255,.08); font-weight:700; font-size:13px; }
    .hdr .sp { flex:1; }
    .hdr button { all:unset; cursor:pointer; opacity:.6; font-size:11px; padding:1px 5px;
      border:1px solid rgba(255,255,255,.14); border-radius:5px; }
    .hdr button:hover { opacity:1; }
    .body { padding: 6px; }
    .row { display:flex; align-items:center; gap:8px; padding:5px 6px; border-radius:6px;
      cursor:pointer; font-size:12px; user-select:none; }
    .row:hover { background:rgba(255,255,255,.06); }
    .row.off { opacity:.38; }
    .badge { width:18px; height:18px; border-radius:50%; flex:none; display:flex; align-items:center;
      justify-content:center; font-size:9px; font-weight:700; border:1.5px solid #fff; }
    .row .nm { flex:1; }
    .row .ct { opacity:.6; font-variant-numeric:tabular-nums; font-size:11px; }
    .row .chk { width:14px; height:14px; border-radius:3px; border:1.5px solid rgba(255,255,255,.35);
      flex:none; display:flex; align-items:center; justify-content:center; font-size:10px; color:#0b0d0f; }
    .row:not(.off) .chk { background:#4ade80; border-color:#4ade80; }
    .hint { padding: 2px 8px 8px; font-size:10px; opacity:.45; line-height:1.4; }
  `;

  const build = () => {
    host = document.createElement("div");
    host.id = "wsr-host";
    root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <div class="hdr"><span>Strategic resources</span><span class="sp"></span>
        <button data-act="all" title="Show all">All</button>
        <button data-act="none" title="Hide all">None</button></div>
      <div class="body"></div>
      <div class="hint">Click a resource to toggle it on the map. Country colours stay visible.</div>`;
    root.appendChild(panel);
    document.documentElement.appendChild(host);

    els = { panel, body: panel.querySelector(".body"), hdr: panel.querySelector(".hdr") };
    panel.querySelector('[data-act="all"]').addEventListener("click", () => setAll(true));
    panel.querySelector('[data-act="none"]').addEventListener("click", () => setAll(false));
    els.body.addEventListener("click", (e) => {
      const row = e.target.closest("[data-res]");
      if (row) toggleType(row.getAttribute("data-res"));
    });
    makeDraggable(panel, els.hdr);
    renderRows();
    restore(panel);
  };

  const renderRows = () => {
    if (!els) return;
    els.body.innerHTML = ORDER.map((k) => {
      const m = RES[k];
      const on = types[k] !== false;
      const ct = counts[k] != null ? counts[k] : "";
      return `<div class="row ${on ? "" : "off"}" data-res="${k}">
        <span class="badge" style="background:${m.color};color:${m.fg}">${esc(m.glyph)}</span>
        <span class="nm">${esc(m.label)}</span>
        <span class="ct">${ct}</span>
        <span class="chk">${on ? "✓" : ""}</span>
      </div>`;
    }).join("");
  };

  // The MAIN-world engine can't call chrome.runtime.getURL, so we resolve the
  // badge-image base URL here and hand it over with every config message.
  let imgBase = "";
  try { imgBase = chrome.runtime.getURL("assets/images/"); } catch (_) {}

  const relay = () => {
    window.postMessage({ __wsr: CHANNEL, kind: "config", enabled, types, imgBase }, location.origin);
  };
  const persistTypes = () => {
    try { chrome.storage?.local.set({ srTypes: types }); } catch (_) {}
  };

  const toggleType = (k) => {
    types[k] = types[k] === false;   // flip
    renderRows(); relay(); persistTypes();
  };
  const setAll = (on) => {
    ORDER.forEach((k) => (types[k] = on));
    renderRows(); relay(); persistTypes();
  };

  const setEnabled = (on) => {
    enabled = on;
    if (host) host.style.display = on ? "" : "none";
    relay();
    if (on) window.postMessage({ __wsr: CHANNEL, kind: "requestCounts" }, location.origin);
  };

  // ---- wiring -----------------------------------------------------------
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.__wsr !== CHANNEL || d.kind !== "counts") return;
    counts = d.counts || {};
    renderRows();
  });

  function makeDraggable(panel, handle) {
    let sx, sy, ox, oy, dragging = false;
    const MARGIN = 4;
    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      const r = panel.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY; e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const w = panel.offsetWidth, h = panel.offsetHeight;
      const left = Math.min(Math.max(MARGIN, ox + (e.clientX - sx)), Math.max(MARGIN, window.innerWidth - w - MARGIN));
      const top = Math.min(Math.max(MARGIN, oy + (e.clientY - sy)), Math.max(MARGIN, window.innerHeight - h - MARGIN));
      panel.style.left = left + "px"; panel.style.top = top + "px";
      panel.style.right = "auto"; panel.style.bottom = "auto";
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      try { chrome.storage?.local.set({ srMapPos: { left: panel.style.left, top: panel.style.top } }); } catch (_) {}
    });
  }

  function restore(panel) {
    try {
      chrome.storage?.local.get(["srMapPos", "srTypes", "srMapEnabled"], (v) => {
        if (v.srMapPos) {
          panel.style.left = v.srMapPos.left; panel.style.top = v.srMapPos.top;
          panel.style.right = "auto"; panel.style.bottom = "auto";
        }
        if (v.srTypes && typeof v.srTypes === "object") {
          ORDER.forEach((k) => { if (v.srTypes[k] === false) types[k] = false; });
          renderRows();
        }
        setEnabled(v.srMapEnabled === true); // default OFF (opt-in map filter)
      });
    } catch (_) { relay(); }
  }

  try {
    chrome.storage?.onChanged.addListener((ch) => {
      if (ch.srMapEnabled) setEnabled(ch.srMapEnabled.newValue === true);
    });
  } catch (_) {}

  const boot = () => { build(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
