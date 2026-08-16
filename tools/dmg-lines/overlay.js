// WarEra Damage lines — ISOLATED-world overlay panel.
//
// Thin UI layer: renders the per-country damage breakdown that the MAIN-world
// engine (map.js) computes and pushes via postMessage, and owns the on/off
// toggle (chrome.storage) which it relays to the engine. All the real work
// (WebSocket tap, country resolution, aggregation, map lines) happens in the
// MAIN world; this file only needs the DOM and chrome.storage.
(() => {
  "use strict";
  if (window.top !== window) return;
  try { document.documentElement.dataset.wdlPanel = "0.4.0"; } catch (_) {}
  console.log("[WDL] overlay.js panel v0.4.0 loaded");

  const CHANNEL = "warera-dmg-lines";
  const FLAG = (code) => `https://media.warera.io/images/flags/${code}.svg?v=16`;
  const ATT = "#ff5a5a", DEF = "#5aa9ff";

  let enabled = true;
  let host, root, els, lastSummary = null;

  const fmt = (n) => {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n));
  };

  // ---- panel DOM --------------------------------------------------------
  const CSS = `
    :host { all: initial; }
    .panel { position: fixed; bottom: 24px; left: 24px; width: 300px; z-index: 2147483647;
      font-family: "Saira", system-ui, sans-serif; color: #e8e8ea;
      background: rgba(18,20,26,.92); border: 1px solid rgba(255,255,255,.12);
      border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.5); }
    .hdr { display:flex; align-items:center; gap:8px; padding:8px 10px; cursor:move;
      border-bottom:1px solid rgba(255,255,255,.08); font-weight:700; font-size:13px; }
    .hdr .dot { width:8px; height:8px; border-radius:50%; background:#4ade80; box-shadow:0 0 8px #4ade80; }
    .hdr .sp { flex:1; }
    .hdr button { all:unset; cursor:pointer; opacity:.6; font-size:14px; padding:0 4px; }
    .hdr button:hover { opacity:1; }
    .body { padding: 8px 10px 10px; max-height: 320px; overflow-y: auto; }
    .empty { padding: 16px 6px; text-align:center; opacity:.6; font-size:12px; line-height:1.5; }
    .legend { display:flex; gap:12px; font-size:10px; opacity:.7; margin-bottom:8px; }
    .legend i { display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:4px; vertical-align:middle; }
    .row { display:flex; align-items:center; gap:8px; margin:5px 0; font-size:12px; }
    .row img { width:18px; height:13px; object-fit:cover; border-radius:2px; flex:none; }
    .row .nm { flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .row .amt { font-weight:700; font-variant-numeric: tabular-nums; }
    .row .rate { opacity:.6; font-size:10px; margin-left:2px; }
    .bar { height:3px; border-radius:2px; margin-top:2px; }
  `;

  const build = () => {
    host = document.createElement("div");
    host.id = "wdl-host";
    root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <div class="hdr"><span class="dot"></span><span>Damage lines</span><span class="sp"></span>
        <button data-act="min" title="Collapse">–</button></div>
      <div class="body"><div class="empty">Open or spectate a battle to see live damage lines.</div></div>`;
    root.appendChild(panel);
    document.documentElement.appendChild(host);

    els = { panel, body: panel.querySelector(".body"), hdr: panel.querySelector(".hdr") };
    panel.querySelector('[data-act="min"]').addEventListener("click", () => {
      els.body.style.display = els.body.style.display === "none" ? "" : "none";
    });
    makeDraggable(panel, els.hdr);
    restore(panel);
  };

  const renderEmpty = () => {
    els.body.innerHTML = `<div class="empty">Open or spectate a battle to see live damage lines.</div>`;
  };

  const render = (summary) => {
    if (!summary || !summary.active || !summary.countries || !summary.countries.length) {
      renderEmpty();
      return;
    }
    const max = Math.max(1, ...summary.countries.map((c) => c.total));
    const rows = summary.countries.map((c) => {
      const color = c.side === "attacker" ? ATT : DEF;
      return `<div>
        <div class="row">
          <img src="${FLAG(c.code)}" alt="">
          <span class="nm">${c.name}</span>
          <span class="amt" style="color:${color}">${fmt(c.total)}</span>
          <span class="rate">${fmt(c.rate)}/min</span>
        </div>
        <div class="bar" style="width:${Math.max(2, (c.total / max) * 100)}%;background:${color}"></div>
      </div>`;
    }).join("");
    els.body.innerHTML =
      `<div class="legend"><span><i style="background:${ATT}"></i>Attacker side</span>
        <span><i style="background:${DEF}"></i>Defender side</span></div>${rows}`;
  };

  // ---- wiring -----------------------------------------------------------
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.__wdl !== CHANNEL || d.kind !== "summary") return;
    lastSummary = d;
    if (enabled) render(d);
  });

  // ---- toggle + position persistence ------------------------------------
  const relayConfig = () => {
    window.postMessage({ __wdl: CHANNEL, kind: "config", enabled }, location.origin);
  };
  const setEnabled = (on) => {
    enabled = on;
    if (host) host.style.display = on ? "" : "none";
    relayConfig();
    if (on) render(lastSummary);
  };

  function makeDraggable(panel, handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      const r = panel.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY; e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      panel.style.left = ox + (e.clientX - sx) + "px";
      panel.style.top = oy + (e.clientY - sy) + "px";
      panel.style.right = "auto"; panel.style.bottom = "auto";
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      try { chrome.storage?.local.set({ wdlPos: { left: panel.style.left, top: panel.style.top } }); } catch (_) {}
    });
  }

  function restore(panel) {
    try {
      chrome.storage?.local.get(["wdlPos", "wdlEnabled"], (v) => {
        if (v.wdlPos) {
          panel.style.left = v.wdlPos.left; panel.style.top = v.wdlPos.top;
          panel.style.right = "auto"; panel.style.bottom = "auto";
        }
        setEnabled(v.wdlEnabled !== false);
      });
    } catch (_) { relayConfig(); }
  }

  try {
    chrome.storage?.onChanged.addListener((ch) => {
      if (ch.wdlEnabled) setEnabled(ch.wdlEnabled.newValue !== false);
    });
  } catch (_) {}

  // ---- boot -------------------------------------------------------------
  const boot = () => { build(); relayConfig(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
