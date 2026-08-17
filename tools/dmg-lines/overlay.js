// WarEra Damage lines — ISOLATED-world overlay panel.
//
// Thin UI layer: renders the per-country damage breakdown that the MAIN-world
// engine (map.js) computes and pushes via postMessage, owns the on/off toggle
// (chrome.storage) which it relays to the engine, and hosts the BATTLE PICKER —
// a searchable, flag-rich combobox of active battles. Picking one tells the
// engine to open its own Centrifugo subscription for that battle, so you can
// watch a battle you don't have open. All the real work (sockets, country
// resolution, aggregation, map lines) happens in the MAIN world; this file only
// needs DOM + chrome.storage.
(() => {
  "use strict";
  if (window.top !== window) return;
  try { document.documentElement.dataset.wdlPanel = "0.9.1"; } catch (_) {}
  console.log("[WDL] overlay.js panel v0.9.1 loaded");

  const CHANNEL = "warera-dmg-lines";
  const FLAG = (code) => `https://media.warera.io/images/flags/${code}.svg?v=16`;
  const ATT = "#ff5a5a", DEF = "#5aa9ff";
  // Friendly names for battle.getGroupedActiveBattles groups, in display order.
  const GROUP_ORDER = ["favorites", "yourCountry", "allies", "enemy", "withBounty", "orders", "other", "tournament"];
  const GROUP_LABEL = {
    favorites: "Favorites", yourCountry: "Your country", allies: "Allies", enemy: "Enemies",
    withBounty: "With bounty", orders: "With orders", other: "Other", tournament: "Tournament",
  };

  let enabled = true;
  let host, root, els, lastSummary = null, listRequested = false;
  // Picker state
  let battleItems = [];   // last battleList payload
  let manualSelected = "";// currently-selected battleId ("" = following open battle)
  let pickerOpen = false;
  let activeIndex = -1;   // highlighted row in the filtered list (keyboard nav)
  let flatFiltered = [];  // battleIds in current filtered render order

  const fmt = (n) => {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n));
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[<>&"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  const flagImg = (c) => (c && c.code) ? `<img class="fl" src="${FLAG(c.code)}" alt="">` : `<span class="fl"></span>`;
  const findItem = (id) => battleItems.find((b) => b.battleId === id) || null;

  // ---- panel DOM --------------------------------------------------------
  const CSS = `
    :host { all: initial; }
    .panel { position: fixed; bottom: 24px; left: 24px; width: 380px; z-index: 2147483647;
      box-sizing: border-box; display: flex; flex-direction: column; max-height: calc(100vh - 48px);
      min-width: 280px; min-height: 160px;
      font-family: "Saira", system-ui, sans-serif; color: #e8e8ea;
      background: rgba(18,20,26,.92); border: 1px solid rgba(255,255,255,.12);
      border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.5); }
    .rsz { position:absolute; right:3px; bottom:3px; width:14px; height:14px; cursor:nwse-resize;
      color:#e8e8ea; opacity:.45; }
    .rsz:hover { opacity:.85; }
    .rsz svg { display:block; }
    .hdr { display:flex; align-items:center; gap:8px; padding:8px 10px; cursor:move;
      border-bottom:1px solid rgba(255,255,255,.08); font-weight:700; font-size:13px; }
    .hdr .dot { width:8px; height:8px; border-radius:50%; background:#4ade80; box-shadow:0 0 8px #4ade80; }
    .hdr .sp { flex:1; }
    .hdr button { all:unset; cursor:pointer; opacity:.6; font-size:14px; padding:0 4px; }
    .hdr button:hover { opacity:1; }

    .pick { display:flex; gap:6px; padding:8px 10px 0; }
    .combo { position:relative; flex:1; min-width:0; }
    .cbtn { display:flex; align-items:center; gap:5px; width:100%; box-sizing:border-box;
      background:#20242e; color:#e8e8ea; border:1px solid rgba(255,255,255,.14); border-radius:6px;
      padding:4px 6px; font:inherit; font-size:12px; cursor:pointer; text-align:left;
      white-space:nowrap; overflow:hidden; }
    .cbtn .lbl { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .cbtn .ph { opacity:.55; }
    .cbtn .caret { margin-left:auto; opacity:.6; flex:none; }
    .pick .refresh, .pick .clear { all:unset; cursor:pointer; padding:2px 8px; font-size:13px; opacity:.8;
      border:1px solid rgba(255,255,255,.14); border-radius:6px; }
    .pick .refresh:hover, .pick .clear:hover { opacity:1; }
    .pick .clear[hidden] { display:none; }
    .pick .clear:hover { color:#ff8a8a; border-color:rgba(255,90,90,.5); }

    .cpop { position:absolute; left:0; right:0; top:calc(100% + 4px); z-index:6;
      background:#181b22; border:1px solid rgba(255,255,255,.16); border-radius:8px;
      box-shadow:0 12px 34px rgba(0,0,0,.6); overflow:hidden; }
    .cpop[hidden]{ display:none; }
    .csearch { width:100%; box-sizing:border-box; background:#0f1116; color:#e8e8ea; border:0;
      border-bottom:1px solid rgba(255,255,255,.1); padding:7px 9px; font:inherit; font-size:12px; outline:none; }
    .clist { max-height:240px; overflow-y:auto; padding:4px; }
    .cgrp { font-size:9px; text-transform:uppercase; letter-spacing:.06em; opacity:.5; padding:6px 6px 3px; }
    .copt { display:flex; align-items:center; gap:5px; padding:5px 6px; border-radius:5px;
      cursor:pointer; font-size:12px; }
    .copt:hover, .copt.active { background:rgba(255,255,255,.09); }
    .copt .fl, .cbtn .fl { width:16px; height:12px; object-fit:cover; border-radius:2px; flex:none; display:inline-block; }
    .copt .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .copt .att { color:${ATT}; font-weight:600; }
    .copt .def { color:${DEF}; font-weight:600; }
    .copt .arrow { opacity:.45; flex:none; }
    .copt .creg { opacity:.55; font-size:10px; margin-left:auto; padding-left:6px; white-space:nowrap;
      overflow:hidden; text-overflow:ellipsis; max-width:130px; flex:none; }
    .cclear { display:flex; align-items:center; gap:6px; padding:6px; margin-bottom:2px; border-radius:5px;
      cursor:pointer; font-size:12px; opacity:.85; border-bottom:1px solid rgba(255,255,255,.06); }
    .cclear:hover, .cclear.active { background:rgba(255,255,255,.09); }
    .cnone { opacity:.5; font-size:11px; padding:12px 8px; text-align:center; }

    .bhead { display:flex; align-items:center; justify-content:center; flex-wrap:wrap; gap:6px;
      padding:8px 10px 0; font-size:12px; }
    .bhead img { width:18px; height:13px; object-fit:cover; border-radius:2px; }
    .bhead .att { color:${ATT}; font-weight:700; }
    .bhead .def { color:${DEF}; font-weight:700; }
    .bhead .vs { opacity:.5; }
    .bhead .reg { width:100%; text-align:center; opacity:.6; font-size:10px; margin-top:1px; }

    .body { padding: 8px 10px 10px; flex: 1 1 auto; min-height: 0; overflow-y: auto; }
    .empty { padding: 16px 6px; text-align:center; opacity:.6; font-size:12px; line-height:1.5; }
    .legend { display:flex; gap:12px; font-size:10px; opacity:.7; margin-bottom:8px; }
    .legend i { display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:4px; vertical-align:middle; }
    .row { display:flex; align-items:center; gap:8px; margin:5px 0; font-size:12px; }
    .row img { width:18px; height:13px; object-fit:cover; border-radius:2px; flex:none; }
    .row .nm { flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .row .amt { font-weight:700; font-variant-numeric: tabular-nums; }
    .row .rate { opacity:.6; font-size:10px; margin-left:2px; }
    .bar { height:3px; border-radius:2px; margin-top:2px; }
    .totals { padding-bottom:8px; margin-bottom:8px; border-bottom:1px solid rgba(255,255,255,.08); }
    .totals .row .nm { font-weight:700; }
    .totals .row .swatch { width:9px; height:9px; border-radius:2px; flex:none; }
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
      <div class="hdr"><span class="dot"></span><span>LIVE Damage tracker</span><span class="sp"></span>
        <button data-act="min" title="Collapse">–</button></div>
      <div class="pick">
        <div class="combo">
          <button class="cbtn" data-act="open" title="Pick a battle to watch">
            <span class="lbl ph">Following open battle…</span><span class="caret">▾</span>
          </button>
          <div class="cpop" hidden>
            <input class="csearch" type="text" placeholder="Search battles…" spellcheck="false">
            <div class="clist"></div>
          </div>
        </div>
        <button class="clear" data-act="clear" title="Clear selection (reset)" hidden>✕</button>
        <button class="refresh" data-act="refresh" title="Refresh battle list">↻</button>
      </div>
      <div class="bhead" style="display:none"></div>
      <div class="body"><div class="empty">Pick a battle above, or open one, to see live damage lines.</div></div>
      <div class="rsz" title="Resize">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4">
          <path d="M13 3 L3 13 M13 7 L7 13 M13 11 L11 13"></path>
        </svg>
      </div>`;
    root.appendChild(panel);
    document.documentElement.appendChild(host);

    els = {
      panel,
      body: panel.querySelector(".body"),
      hdr: panel.querySelector(".hdr"),
      bhead: panel.querySelector(".bhead"),
      combo: panel.querySelector(".combo"),
      cbtn: panel.querySelector(".cbtn"),
      lbl: panel.querySelector(".cbtn .lbl"),
      cpop: panel.querySelector(".cpop"),
      csearch: panel.querySelector(".csearch"),
      clist: panel.querySelector(".clist"),
      clear: panel.querySelector(".clear"),
    };

    panel.querySelector('[data-act="min"]').addEventListener("click", () => {
      els.body.style.display = els.body.style.display === "none" ? "" : "none";
    });
    panel.querySelector('[data-act="refresh"]').addEventListener("click", requestBattleList);
    els.clear.addEventListener("click", () => choose(""));
    els.cbtn.addEventListener("click", () => (pickerOpen ? closePicker() : openPicker()));
    els.csearch.addEventListener("input", () => { activeIndex = 0; renderList(); });
    els.csearch.addEventListener("keydown", onSearchKey);
    els.clist.addEventListener("click", (e) => {
      const opt = e.target.closest("[data-id]");
      if (opt) choose(opt.getAttribute("data-id"));
    });
    // Close the popup on any click/tap outside the combo (works through the shadow boundary).
    window.addEventListener("mousedown", (e) => {
      if (pickerOpen && !e.composedPath().includes(els.combo)) closePicker();
    }, true);

    makeDraggable(panel, els.hdr);
    makeResizable(panel, panel.querySelector(".rsz"));
    restore(panel);
  };

  const requestBattleList = () => {
    listRequested = true;
    window.postMessage({ __wdl: CHANNEL, kind: "requestBattleList" }, location.origin);
  };

  // ---- picker: open / filter / choose -----------------------------------
  const openPicker = () => {
    pickerOpen = true;
    els.cpop.hidden = false;
    els.csearch.value = "";
    activeIndex = manualSelected ? -1 : 0;
    renderList();
    els.csearch.focus();
    if (!battleItems.length) requestBattleList();
  };
  const closePicker = () => {
    pickerOpen = false;
    els.cpop.hidden = true;
  };

  const filteredItems = () => {
    const q = els.csearch.value.trim().toLowerCase();
    if (!q) return battleItems.slice();
    return battleItems.filter((b) => {
      const hay = `${(b.attacker && b.attacker.name) || ""} ${(b.defender && b.defender.name) || ""} ${b.regionName || ""}`.toLowerCase();
      return hay.includes(q);
    });
  };

  const renderList = () => {
    const items = filteredItems();
    const byGroup = {};
    for (const b of items) (byGroup[b.group] = byGroup[b.group] || []).push(b);

    // "Following open battle…" clear row is index 0 in the keyboard-nav order.
    flatFiltered = [""];
    let html = `<div class="cclear" data-id="" ${activeIndex === 0 ? 'data-hi="1"' : ""}>` +
      `<span class="fl"></span><span class="nm ph" style="opacity:.75">Following open battle…</span></div>`;

    for (const grp of GROUP_ORDER) {
      const list = byGroup[grp];
      if (!list || !list.length) continue;
      html += `<div class="cgrp">${esc(GROUP_LABEL[grp] || grp)}</div>`;
      for (const b of list) {
        const idx = flatFiltered.length;
        flatFiltered.push(b.battleId);
        const a = b.attacker || {}, d = b.defender || {};
        // Defender always on the left, attacker on the right; arrow points left (attacker attacks defender).
        const title = `${(d.name || "?")} vs ${(a.name || "?")}${b.regionName ? " · " + b.regionName : ""}`;
        html += `<div class="copt" data-id="${esc(b.battleId)}" data-idx="${idx}" title="${esc(title)}">` +
          `${flagImg(d)}<span class="nm def">${esc(d.name || "?")}</span>` +
          `<span class="arrow">←</span>` +
          `${flagImg(a)}<span class="nm att">${esc(a.name || "?")}</span>` +
          (b.regionName ? `<span class="creg">${esc(b.regionName)}</span>` : "") +
          `</div>`;
      }
    }
    if (items.length === 0) html += `<div class="cnone">No matching battles.</div>`;
    els.clist.innerHTML = html;
    highlight();
  };

  // Highlight the active row and keep it in view (keyboard nav).
  const highlight = () => {
    const rows = els.clist.querySelectorAll("[data-id]");
    rows.forEach((r) => {
      const i = r.classList.contains("cclear") ? 0 : Number(r.getAttribute("data-idx"));
      const on = i === activeIndex;
      r.classList.toggle("active", on);
      if (on) r.scrollIntoView({ block: "nearest" });
    });
  };

  const onSearchKey = (e) => {
    if (e.key === "ArrowDown") { activeIndex = Math.min(flatFiltered.length - 1, activeIndex + 1); highlight(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { activeIndex = Math.max(0, activeIndex - 1); highlight(); e.preventDefault(); }
    else if (e.key === "Enter") { if (activeIndex >= 0 && activeIndex < flatFiltered.length) choose(flatFiltered[activeIndex]); e.preventDefault(); }
    else if (e.key === "Escape") { closePicker(); }
  };

  const choose = (battleId) => {
    manualSelected = battleId || "";
    renderTrigger();
    closePicker();
    window.postMessage({ __wdl: CHANNEL, kind: "selectBattle", battleId: manualSelected || null }, location.origin);
  };

  const renderTrigger = () => {
    if (!els) return;
    els.clear.hidden = !manualSelected; // ✕ only shows when a battle is selected
    if (!manualSelected) {
      els.lbl.className = "lbl ph";
      els.lbl.textContent = "Following open battle…";
      return;
    }
    const it = findItem(manualSelected);
    els.lbl.className = "lbl";
    if (it) {
      const a = it.attacker || {}, d = it.defender || {};
      els.lbl.innerHTML = `${flagImg(d)}${esc(d.name || "?")} <span style="opacity:.45">←</span> ${flagImg(a)}${esc(a.name || "?")}`;
    } else {
      els.lbl.textContent = "Watching battle";
    }
  };

  const onBattleList = (battles, selected) => {
    battleItems = battles || [];
    if (selected != null) manualSelected = selected || "";
    renderTrigger();
    if (pickerOpen) renderList();
  };

  // ---- battle header + damage rows --------------------------------------
  const renderHeader = (header) => {
    if (!els) return;
    if (!header) { els.bhead.style.display = "none"; els.bhead.innerHTML = ""; return; }
    const a = header.attacker || {}, d = header.defender || {};
    const flag = (c) => (c && c.code) ? `<img src="${FLAG(c.code)}" alt="">` : "";
    els.bhead.style.display = "";
    // Defender on the left, attacker on the right — consistent with the picker.
    els.bhead.innerHTML =
      `${flag(d)}<span class="def">${esc(d.name || "?")}</span>` +
      `<span class="vs">vs</span>` +
      `<span class="att">${esc(a.name || "?")}</span>${flag(a)}` +
      (header.regionName ? `<span class="reg">${esc(header.regionName)}</span>` : "");
  };

  const renderEmpty = (msg) => {
    els.body.innerHTML = `<div class="empty">${esc(msg || "Pick a battle above, or open one, to see live damage lines.")}</div>`;
  };

  const render = (summary) => {
    renderHeader(summary && summary.header);
    if (!summary || !summary.active || !summary.countries || !summary.countries.length) {
      renderEmpty(summary && summary.header ? "Waiting for hits in this battle…" : null);
      return;
    }
    const max = Math.max(1, ...summary.countries.map((c) => c.total));
    const rows = summary.countries.map((c) => {
      const color = c.side === "attacker" ? ATT : DEF;
      return `<div>
        <div class="row">
          <img src="${FLAG(c.code)}" alt="">
          <span class="nm">${esc(c.name)}</span>
          <span class="amt" style="color:${color}">${fmt(c.total)}</span>
          <span class="rate">${fmt(c.rate)}/min</span>
        </div>
        <div class="bar" style="width:${Math.max(2, (c.total / max) * 100)}%;background:${color}"></div>
      </div>`;
    }).join("");
    const t = summary.totals || {};
    const totals = `<div class="totals">
        <div class="row">
          <i class="swatch" style="background:${ATT}"></i>
          <span class="nm">All attackers</span>
          <span class="amt" style="color:${ATT}">${fmt(t.attackerRate || 0)}/min</span>
        </div>
        <div class="row">
          <i class="swatch" style="background:${DEF}"></i>
          <span class="nm">All defenders</span>
          <span class="amt" style="color:${DEF}">${fmt(t.defenderRate || 0)}/min</span>
        </div>
      </div>`;
    els.body.innerHTML =
      `<div class="legend"><span><i style="background:${DEF}"></i>Defender side</span>
        <span><i style="background:${ATT}"></i>Attacker side</span></div>${totals}${rows}`;
  };

  // ---- wiring -----------------------------------------------------------
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.__wdl !== CHANNEL) return;
    if (d.kind === "summary") {
      lastSummary = d;
      if (enabled) render(d);
    } else if (d.kind === "battleList") {
      onBattleList(d.battles || [], d.selected);
    }
  });

  // ---- toggle + position persistence ------------------------------------
  const relayConfig = () => {
    window.postMessage({ __wdl: CHANNEL, kind: "config", enabled }, location.origin);
  };
  const setEnabled = (on) => {
    enabled = on;
    if (host) host.style.display = on ? "" : "none";
    relayConfig();
    if (on) {
      render(lastSummary);
      clampPanel(); // a saved position / smaller window mustn't leave it off-screen
      if (!listRequested) requestBattleList();
    } else {
      closePicker();
    }
  };

  // Keep the whole panel within the viewport (with a small margin). Only repositions when it's
  // actually out of bounds, so it doesn't disturb the default bottom-left anchoring.
  const MARGIN = 4;
  const clampPanel = () => {
    if (!els || !els.panel || !host || host.style.display === "none") return;
    const p = els.panel;
    const r = p.getBoundingClientRect();
    if (!r.width) return;
    const maxLeft = Math.max(MARGIN, window.innerWidth - r.width - MARGIN);
    const maxTop = Math.max(MARGIN, window.innerHeight - r.height - MARGIN);
    const left = Math.min(Math.max(MARGIN, r.left), maxLeft);
    const top = Math.min(Math.max(MARGIN, r.top), maxTop);
    if (Math.round(left) !== Math.round(r.left) || Math.round(top) !== Math.round(r.top)) {
      p.style.left = left + "px"; p.style.top = top + "px";
      p.style.right = "auto"; p.style.bottom = "auto";
    }
  };

  // Bottom-right grip resizes width + height. Switches the panel to top/left anchoring on grab
  // (it defaults to bottom/left) so dragging the grip down-right grows the panel down-right.
  // Growth is capped so the panel can't extend past the right/bottom edge of the screen.
  function makeResizable(panel, handle) {
    let sx, sy, sw, sh, ol, ot, resizing = false;
    handle.addEventListener("mousedown", (e) => {
      resizing = true;
      const r = panel.getBoundingClientRect();
      sw = r.width; sh = r.height; sx = e.clientX; sy = e.clientY; ol = r.left; ot = r.top;
      panel.style.left = r.left + "px"; panel.style.top = r.top + "px";
      panel.style.right = "auto"; panel.style.bottom = "auto";
      e.preventDefault(); e.stopPropagation();
    });
    window.addEventListener("mousemove", (e) => {
      if (!resizing) return;
      const maxW = Math.max(280, window.innerWidth - ol - MARGIN);
      const maxH = Math.max(160, window.innerHeight - ot - MARGIN);
      panel.style.width = Math.max(280, Math.min(sw + (e.clientX - sx), maxW)) + "px";
      panel.style.height = Math.max(160, Math.min(sh + (e.clientY - sy), maxH)) + "px";
    });
    window.addEventListener("mouseup", () => {
      if (!resizing) return;
      resizing = false;
      try {
        chrome.storage?.local.set({
          wdlSize: { width: panel.style.width, height: panel.style.height },
          wdlPos: { left: panel.style.left, top: panel.style.top },
        });
      } catch (_) {}
    });
  }

  function makeDraggable(panel, handle) {
    let sx, sy, ox, oy, dragging = false;
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
      try { chrome.storage?.local.set({ wdlPos: { left: panel.style.left, top: panel.style.top } }); } catch (_) {}
    });
    // Re-clamp on viewport resize so a shrinking window can't leave the panel off-screen.
    window.addEventListener("resize", clampPanel);
  }

  function restore(panel) {
    try {
      chrome.storage?.local.get(["wdlPos", "wdlSize", "wdlEnabled"], (v) => {
        if (v.wdlPos) {
          panel.style.left = v.wdlPos.left; panel.style.top = v.wdlPos.top;
          panel.style.right = "auto"; panel.style.bottom = "auto";
        }
        if (v.wdlSize) {
          if (v.wdlSize.width) panel.style.width = v.wdlSize.width;
          if (v.wdlSize.height) panel.style.height = v.wdlSize.height;
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
  const boot = () => {
    build();
    relayConfig();
    // Give the engine a moment to build its country/region lookups so battle labels resolve.
    setTimeout(() => { if (enabled) requestBattleList(); }, 1500);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
