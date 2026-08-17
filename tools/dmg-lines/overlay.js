// WarEra Damage lines — ISOLATED-world overlay panel(s).
//
// Thin UI layer: renders the per-country damage breakdown that the MAIN-world
// engine (map.js) computes and pushes via postMessage, owns the on/off toggle
// (chrome.storage) which it relays to the engine, and hosts the BATTLE PICKER —
// a searchable, flag-rich combobox of active battles. Picking one tells the
// engine to open its own Centrifugo subscription for that battle, so you can
// watch a battle you don't have open. All the real work (sockets, country
// resolution, aggregation, map lines) happens in the MAIN world; this file only
// needs DOM + chrome.storage.
//
// Multiple windows: any number of independent "LIVE Damage tracker" panels can
// be open at once (the "+" button spawns another), each picking its own battle.
// By default every panel is LINKED — dragging any one of them moves the whole
// group together, "side to side". Each panel has a detach button to break free
// (it keeps its position; the rest of the group stays linked to each other) and
// an attach button to snap back into the group. Whichever panel was clicked most
// recently is "active" (highlighted) — only ITS battle's lines are drawn on the
// map, since drawing every open panel's lines at once would be unreadable. See
// map.js for how it keeps every watched battle's arcs continuously up to date
// (not just the active one) so switching which panel is active is instant.
(() => {
  "use strict";
  if (window.top !== window) return;
  try { document.documentElement.dataset.wdlPanel = "1.3.0"; } catch (_) {}
  console.log("[WDL] overlay.js panel v1.3.0 (multi-window) loaded");

  const CHANNEL = "warera-dmg-lines";
  const FLAG = (code) => `https://media.warera.io/images/flags/${code}.svg?v=16`;
  const ATT = "#ff5a5a", DEF = "#5aa9ff";
  // Friendly names for battle.getGroupedActiveBattles groups, in display order.
  const GROUP_ORDER = ["favorites", "yourCountry", "allies", "enemy", "withBounty", "orders", "other", "tournament"];
  const GROUP_LABEL = {
    favorites: "Favorites", yourCountry: "Your country", allies: "Allies", enemy: "Enemies",
    withBounty: "With bounty", orders: "With orders", other: "Other", tournament: "Tournament",
  };
  const MARGIN = 4;
  const GAP = 12; // px between linked panels when laid out side by side

  const fmt = (n) => {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n));
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[<>&"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  const flagImg = (c) => (c && c.code) ? `<img class="fl" src="${FLAG(c.code)}" alt="">` : `<span class="fl"></span>`;

  // ---- shared (cross-panel) state ----------------------------------------
  let enabled = true;
  let battleItems = [];   // last battleList payload — shared, one fetch serves every panel's picker
  let listRequested = false;
  const panels = new Map();   // panelId -> panel instance
  const linkedSet = new Set(); // panelIds currently in the linked group (moved together)
  // Each linked panel's offset from the group anchor, fixed at layout time (spawn/attach) and
  // NOT re-derived from on-screen position during a drag — see makeDraggable for why: screen
  // position gets clamped at the viewport edge, and if a panel's offset were re-read from its
  // (possibly already-clamped-to-the-edge) rect, dragging back away from the edge would have
  // nothing left to reconstruct the original spacing from, permanently collapsing the group.
  const groupOffset = new Map(); // panelId -> {dx, dy} relative to the anchor panel
  let activePanelId = null;
  let primaryPanelId = null;   // the first panel created this page load — the only one whose
                                // position/size persists across reloads (see restore()/persist below)
  let zTop = 2147483000;
  let panelSeq = 0;

  const findItem = (id) => battleItems.find((b) => b.battleId === id) || null;

  // ---- panel DOM/CSS (shared string, injected into each panel's own shadow root) -----
  const CSS = `
    :host { all: initial; }
    .panel { position: fixed; top: 24px; left: 24px; width: 380px;
      box-sizing: border-box; display: flex; flex-direction: column; max-height: calc(100vh - 48px);
      min-width: 280px; min-height: 160px;
      font-family: "Saira", system-ui, sans-serif; color: #e8e8ea;
      background: rgba(18,20,26,.92); border: 1px solid rgba(255,255,255,.12);
      border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.5);
      transition: box-shadow .15s; }
    .panel.active { box-shadow: 0 0 0 2px rgba(255,255,255,.55), 0 10px 34px rgba(0,0,0,.55); }
    .hrsz { display:block; flex:none; height:9px; cursor:ns-resize; position:relative; }
    .hrsz::after { content:""; position:absolute; left:50%; top:50%; width:28px; height:3px;
      transform:translate(-50%,-50%); border-radius:2px; background:rgba(255,255,255,.22); }
    .hrsz:hover::after { background:rgba(255,255,255,.4); }
    .hdr { display:flex; align-items:center; gap:8px; padding:8px 10px; cursor:move;
      border-bottom:1px solid rgba(255,255,255,.08); font-weight:700; font-size:13px; }
    .hdr .dot { width:8px; height:8px; border-radius:50%; background:#4ade80; box-shadow:0 0 8px #4ade80; flex:none; }
    .hdr .ttl { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .hdr .sp { flex:1; }
    .hdr button { all:unset; position:relative; cursor:pointer; opacity:.6; font-size:14px; padding:0 4px; }
    .hdr button:hover { opacity:1; }
    .hdr button:disabled { opacity:.25; cursor:default; }
    .hdr button:disabled:hover { opacity:.25; }
    .hdr .link[data-linked="0"] { opacity: .4; }
    .hdr .link[data-linked="0"]::before {
      content:""; position:absolute; left:1px; right:1px; top:50%; height:1px;
      background: currentColor; transform: rotate(-38deg);
    }

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
    .bhead .rate { font-size:11px; font-variant-numeric: tabular-nums; opacity:.85; }
    .bhead .reg { width:100%; text-align:center; opacity:.6; font-size:10px; margin-top:1px; }

    .uncollapse { all:unset; display:block; box-sizing:border-box; width:100%; text-align:center;
      margin-top:8px; padding:5px 10px; font:inherit; font-size:11px; opacity:.7; cursor:pointer;
      border-top:1px solid rgba(255,255,255,.08); }
    .uncollapse:hover { opacity:1; }

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
  `;

  // ---- group layout --------------------------------------------------------
  // Positions every linked panel left-to-right, starting from the first (anchor) panel's
  // current top-left. Called whenever the group's membership changes (spawn, attach).
  const layoutSideBySide = () => {
    const ids = [...linkedSet];
    if (!ids.length) return;
    const anchor = panels.get(ids[0]);
    if (!anchor) return;
    const { left: anchorLeft, top: anchorTop } = anchor.getPos();
    let left = anchorLeft;
    for (const id of ids) {
      const inst = panels.get(id);
      if (!inst) continue;
      inst.setPos(left, anchorTop);
      groupOffset.set(id, { dx: left - anchorLeft, dy: 0 });
      left += inst.getRect().width + GAP;
    }
  };

  const setLinked = (panelId, linked) => {
    if (linked) linkedSet.add(panelId); else { linkedSet.delete(panelId); groupOffset.delete(panelId); }
    const inst = panels.get(panelId);
    if (inst) inst.setLinkButton(linked);
    if (linked) layoutSideBySide();
  };

  const persistPrimary = () => {
    const inst = primaryPanelId && panels.get(primaryPanelId);
    if (!inst) return;
    const r = inst.getRect();
    try {
      chrome.storage?.local.set({
        wdlPos: { left: r.left + "px", top: r.top + "px" },
        // Width is intentionally not stored — it's always the fixed 380px now (no free-form
        // width resize), so an old width from before this change is simply never applied (see
        // setSize below, which only ever touches height).
        wdlSize: { height: r.height + "px" },
      });
    } catch (_) {}
  };

  const setActivePanel = (panelId) => {
    if (activePanelId === panelId) {
      // Still bring it to front — clicking an already-active panel shouldn't be a no-op
      // if something else has since been raised above it.
      panels.get(panelId)?.bringToFront();
      return;
    }
    const prev = activePanelId;
    activePanelId = panelId;
    if (prev) panels.get(prev)?.setActive(false);
    const inst = panels.get(panelId);
    if (inst) { inst.setActive(true); inst.bringToFront(); }
    window.postMessage({ __wdl: CHANNEL, kind: "setActivePanel", panelId }, location.origin);
  };

  // ---- panel factory ---------------------------------------------------------------
  function createPanel(panelId) {
    let host, root, els;
    let battleListPicker = { manualSelected: "", pickerOpen: false, activeIndex: -1, flatFiltered: [] };
    // Remembers the last (restored or manually dragged) height so uncollapsing can restore it.
    // Never applied while collapsed — the body that height was measured against is hidden, so an
    // explicit style.height would leave a blank gap below the header/picker/region; collapsing
    // always clears the inline height back to auto (see setUncollapsed) for exactly that reason.
    let customHeight = null;

    const build = () => {
      host = document.createElement("div");
      host.id = "wdl-host-" + panelId;
      root = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = CSS;
      root.appendChild(style);

      const panel = document.createElement("div");
      panel.className = "panel";
      panel.style.zIndex = String(++zTop);
      panel.innerHTML = `
        <div class="hdr"><span class="dot"></span><span class="ttl">LIVE Damage tracker</span><span class="sp"></span>
          <button data-act="add" title="New tracker window">+</button>
          <button class="link" data-act="link" data-linked="1" title="Detach from group">⛓</button>
          <button class="close" data-act="close" title="Close this tracker window">✕</button></div>
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
        <button class="uncollapse" data-act="toggle-body" style="display:none">▾ Show supporting countries</button>
        <div class="body" style="display:none"><div class="empty">Pick a battle above, or open one, to see live damage lines.</div></div>
        <div class="hrsz" title="Drag to resize" style="display:none"></div>`;
      root.appendChild(panel);
      document.documentElement.appendChild(host);

      els = {
        panel,
        body: panel.querySelector(".body"),
        hdr: panel.querySelector(".hdr"),
        bhead: panel.querySelector(".bhead"),
        uncollapseBtn: panel.querySelector(".uncollapse"),
        hrsz: panel.querySelector(".hrsz"),
        combo: panel.querySelector(".combo"),
        cbtn: panel.querySelector(".cbtn"),
        lbl: panel.querySelector(".cbtn .lbl"),
        cpop: panel.querySelector(".cpop"),
        csearch: panel.querySelector(".csearch"),
        clist: panel.querySelector(".clist"),
        clear: panel.querySelector(".clear"),
        linkBtn: panel.querySelector(".link"),
        closeBtn: panel.querySelector(".close"),
      };

      els.uncollapseBtn.addEventListener("click", () => setUncollapsed(els.body.style.display === "none"));
      panel.querySelector('[data-act="add"]').addEventListener("click", () => {
        spawnPanel();
        requestBattleList(); // opening a new tracker window refreshes the list too
      });
      els.linkBtn.addEventListener("click", () => {
        const nowLinked = els.linkBtn.getAttribute("data-linked") !== "1";
        setLinked(panelId, nowLinked);
      });
      els.closeBtn.addEventListener("click", () => closePanel(panelId));
      panel.querySelector('[data-act="refresh"]').addEventListener("click", requestBattleList);
      els.clear.addEventListener("click", () => choose(""));
      els.cbtn.addEventListener("click", () => (battleListPicker.pickerOpen ? closePicker() : openPicker()));
      els.csearch.addEventListener("input", () => { battleListPicker.activeIndex = 0; renderList(); });
      els.csearch.addEventListener("keydown", onSearchKey);
      els.clist.addEventListener("click", (e) => {
        const opt = e.target.closest("[data-id]");
        if (opt) choose(opt.getAttribute("data-id"));
      });
      // Close this panel's popup on any click/tap outside its own combo.
      window.addEventListener("mousedown", (e) => {
        if (battleListPicker.pickerOpen && !e.composedPath().includes(els.combo)) closePicker();
      }, true);
      // Any interaction with this panel makes it the active one (whose lines draw on the map).
      panel.addEventListener("mousedown", () => setActivePanel(panelId));

      makeDraggable(panelId, els.hdr);
      makeHeightResizable(panelId, panel, els.hrsz);
    };

    // Collapsed by default (header + picker + fighting countries/region only). Uncollapsing
    // reveals the supporting-countries breakdown and the height-resize handle; the same button
    // (positioned right under the region) flips between "show"/"hide" in place.
    const setUncollapsed = (on) => {
      els.body.style.display = on ? "" : "none";
      els.hrsz.style.display = on ? "" : "none";
      els.uncollapseBtn.textContent = on ? "▴ Hide supporting countries" : "▾ Show supporting countries";
      if (on) {
        // Reapply the last known custom height, if any — otherwise leave height unset so the
        // panel auto-sizes to fit its (now-visible) content.
        if (customHeight) els.panel.style.height = customHeight;
      } else {
        // Collapsing always reverts to auto height — otherwise the panel would keep whatever
        // tall height it had while uncollapsed, leaving an empty gap below the collapsed content.
        els.panel.style.height = "";
      }
    };

    // ---- picker: open / filter / choose ----------------------------------
    const openPicker = () => {
      battleListPicker.pickerOpen = true;
      els.cpop.hidden = false;
      els.csearch.value = "";
      battleListPicker.activeIndex = battleListPicker.manualSelected ? -1 : 0;
      renderList();
      els.csearch.focus();
      requestBattleList(); // always refresh on open, not just when empty
    };
    const closePicker = () => {
      if (!battleListPicker.pickerOpen) return; // avoid a redundant refresh if already closed
      battleListPicker.pickerOpen = false;
      els.cpop.hidden = true;
      requestBattleList();
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
      battleListPicker.flatFiltered = [""];
      let html = `<div class="cclear" data-id="" ${battleListPicker.activeIndex === 0 ? 'data-hi="1"' : ""}>` +
        `<span class="fl"></span><span class="nm ph" style="opacity:.75">Following open battle…</span></div>`;

      for (const grp of GROUP_ORDER) {
        const list = byGroup[grp];
        if (!list || !list.length) continue;
        html += `<div class="cgrp">${esc(GROUP_LABEL[grp] || grp)}</div>`;
        for (const b of list) {
          const idx = battleListPicker.flatFiltered.length;
          battleListPicker.flatFiltered.push(b.battleId);
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
        const on = i === battleListPicker.activeIndex;
        r.classList.toggle("active", on);
        if (on) r.scrollIntoView({ block: "nearest" });
      });
    };

    const onSearchKey = (e) => {
      const bp = battleListPicker;
      if (e.key === "ArrowDown") { bp.activeIndex = Math.min(bp.flatFiltered.length - 1, bp.activeIndex + 1); highlight(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { bp.activeIndex = Math.max(0, bp.activeIndex - 1); highlight(); e.preventDefault(); }
      else if (e.key === "Enter") { if (bp.activeIndex >= 0 && bp.activeIndex < bp.flatFiltered.length) choose(bp.flatFiltered[bp.activeIndex]); e.preventDefault(); }
      else if (e.key === "Escape") { closePicker(); }
    };

    const choose = (battleId) => {
      battleListPicker.manualSelected = battleId || "";
      renderTrigger();
      closePicker();
      window.postMessage({ __wdl: CHANNEL, kind: "selectBattle", panelId, battleId: battleListPicker.manualSelected || null }, location.origin);
    };

    const renderTrigger = () => {
      if (!els) return;
      const sel = battleListPicker.manualSelected;
      els.clear.hidden = !sel; // ✕ only shows when a battle is selected
      if (!sel) {
        els.lbl.className = "lbl ph";
        els.lbl.textContent = "Following open battle…";
        return;
      }
      const it = findItem(sel);
      els.lbl.className = "lbl";
      if (it) {
        const a = it.attacker || {}, d = it.defender || {};
        els.lbl.innerHTML = `${flagImg(d)} ${esc(d.name || "?")} <span style="opacity:.45">←</span> ${flagImg(a)} ${esc(a.name || "?")}`;
      } else {
        els.lbl.textContent = "Watching battle";
      }
    };

    const onBattleListUpdated = () => {
      renderTrigger();
      if (battleListPicker.pickerOpen) renderList();
    };

    // ---- battle header + damage rows -------------------------------------
    const renderHeader = (header, totals) => {
      if (!els) return;
      if (!header) {
        els.bhead.style.display = "none"; els.bhead.innerHTML = "";
        els.uncollapseBtn.style.display = "none";
        setUncollapsed(false); // nothing to show — don't leave it stuck open with an empty body
        return;
      }
      const a = header.attacker || {}, d = header.defender || {};
      const t = totals || {};
      const flag = (c) => (c && c.code) ? `<img src="${FLAG(c.code)}" alt="">` : "";
      els.bhead.style.display = "";
      els.uncollapseBtn.style.display = "";
      // Defender on the left, attacker on the right — consistent with the picker. Each side's
      // total damage rate sits just outside its own flag+name, so it reads as "belonging" to
      // that side without needing an "All attackers"/"All defenders" label.
      els.bhead.innerHTML =
        `<span class="rate def">${fmt(t.defenderRate || 0)}/min</span>` +
        `${flag(d)}<span class="def">${esc(d.name || "?")}</span>` +
        `<span class="vs">vs</span>` +
        `<span class="att">${esc(a.name || "?")}</span>${flag(a)}` +
        `<span class="rate att">${fmt(t.attackerRate || 0)}/min</span>` +
        (header.regionName ? `<span class="reg">${esc(header.regionName)}</span>` : "");
    };

    const renderEmpty = (msg) => {
      els.body.innerHTML = `<div class="empty">${esc(msg || "Pick a battle above, or open one, to see live damage lines.")}</div>`;
    };

    const render = (summary) => {
      renderHeader(summary && summary.header, summary && summary.totals);
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
      // Attacker/defender total damage rate is now shown directly on the map, next to each
      // fighting nation's own position (see map.js) — not duplicated here.
      els.body.innerHTML =
        `<div class="legend"><span><i style="background:${DEF}"></i>Defender side</span>
          <span><i style="background:${ATT}"></i>Attacker side</span></div>${rows}`;
    };

    // ---- position/size/visibility ------------------------------------------
    // Keep the whole panel within the viewport (with a small margin). Only repositions when
    // it's actually out of bounds, so it doesn't disturb the default anchoring.
    const clamp = () => {
      if (!els || !host || host.style.display === "none") return;
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

    const getRect = () => els.panel.getBoundingClientRect();
    const getPos = () => {
      const r = getRect();
      return { left: r.left, top: r.top };
    };
    const setPos = (left, top) => {
      els.panel.style.left = left + "px"; els.panel.style.top = top + "px";
      els.panel.style.right = "auto"; els.panel.style.bottom = "auto";
    };

    const setActive = (on) => els.panel.classList.toggle("active", on);
    const bringToFront = () => { els.panel.style.zIndex = String(++zTop); };
    const setLinkButton = (linked) => {
      els.linkBtn.setAttribute("data-linked", linked ? "1" : "0");
      els.linkBtn.title = linked ? "Detach from group" : "Attach to group";
    };
    // `disabled` (not just a CSS/visual state) is what actually blocks the click — that's a DOM
    // semantic unaffected by the `all:unset` CSS reset on .hdr button, so this reliably prevents
    // closing the last remaining window even if someone finds another way to trigger a click.
    const setCloseEnabled = (on) => {
      els.closeBtn.disabled = !on;
      els.closeBtn.title = on ? "Close this tracker window" : "Can't close the last tracker window";
    };

    const setHostVisible = (on) => { if (host) host.style.display = on ? "" : "none"; };
    // Height only — width is always the fixed 380px, no free-form resizing (see makeHeightResizable).
    // Just remembers the value (see setUncollapsed for when/how it's actually applied) — called
    // both at boot (restoring a saved height) and after every manual resize-drag.
    const setSize = (height) => { if (height) customHeight = height; };

    const destroy = () => { if (host) { host.remove(); host = null; } };

    build();

    return {
      panelId,
      get panelEl() { return els.panel; },
      onSummary: render,
      onBattleListUpdated,
      getRect, getPos, setPos, clamp, setActive, bringToFront, setLinkButton,
      setCloseEnabled, setHostVisible, setSize, destroy,
      choose,
    };
  }

  // ---- dragging / resizing (group-aware) -------------------------------------
  const clampAxis = (v, size, viewportSize) => Math.min(Math.max(MARGIN, v), Math.max(MARGIN, viewportSize - size - MARGIN));

  function makeDraggable(panelId, handle) {
    let dragging = false;
    let startMouseX, startMouseY;
    let draggedStart = null; // {left, top, w, h} of the panel actually grabbed, captured at drag start
    let followers = null;    // Map<panelId, {dx, dy, w, h}> other linked panels, offset relative to the dragged one

    handle.addEventListener("mousedown", (e) => {
      const inst = panels.get(panelId);
      if (!inst) return;
      dragging = true;
      startMouseX = e.clientX; startMouseY = e.clientY;
      const r = inst.getRect();
      draggedStart = { left: r.left, top: r.top, w: r.width, h: r.height };

      // Followers' positions are derived from the DRAGGED panel's offset (see groupOffset) —
      // never from their own current on-screen rect, which may currently be clamped to an edge
      // and indistinguishable from every other collapsed panel. This is what lets a group that's
      // stacked at the viewport edge un-stack correctly instead of staying collapsed forever.
      followers = new Map();
      if (linkedSet.has(panelId)) {
        const myOffset = groupOffset.get(panelId) || { dx: 0, dy: 0 };
        for (const id of linkedSet) {
          if (id === panelId) continue;
          const other = panels.get(id);
          const off = groupOffset.get(id);
          if (!other || !off) continue;
          const or = other.getRect();
          followers.set(id, { dx: off.dx - myOffset.dx, dy: off.dy - myOffset.dy, w: or.width, h: or.height });
        }
      }
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging || !draggedStart) return;
      const dx = e.clientX - startMouseX, dy = e.clientY - startMouseY;

      const draggedLeft = clampAxis(draggedStart.left + dx, draggedStart.w, window.innerWidth);
      const draggedTop = clampAxis(draggedStart.top + dy, draggedStart.h, window.innerHeight);
      panels.get(panelId)?.setPos(draggedLeft, draggedTop);

      // Each follower sticks to the edge (via its own clamp) while draggedLeft/Top + its fixed
      // offset would still be off-screen, and snaps directly to its correct spot the moment that
      // stops being true — it never has to "catch up" from a collapsed position because its
      // target position is always computed fresh from the dragged panel's actual position, not
      // from wherever it last happened to render.
      for (const [id, f] of followers) {
        const inst = panels.get(id);
        if (!inst) continue;
        const left = clampAxis(draggedLeft + f.dx, f.w, window.innerWidth);
        const top = clampAxis(draggedTop + f.dy, f.h, window.innerHeight);
        inst.setPos(left, top);
      }
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      draggedStart = null;
      followers = null;
      persistPrimary();
    });
  }
  // Re-clamp every panel on viewport resize so a shrinking window can't leave any panel off-screen.
  window.addEventListener("resize", () => { for (const inst of panels.values()) inst.clamp(); });

  // Bottom-edge handle resizes HEIGHT ONLY (this one panel only — resizing never affects the rest
  // of a linked group) — width stays fixed at 380px always, no free-form resizing. Only present
  // while uncollapsed (see setUncollapsed), since the collapsed state's height is just whatever
  // the header/picker/region content needs. Switches the panel to top anchoring on grab (it
  // defaults to bottom) so dragging the handle down grows the panel downward, capped so it can't
  // extend past the bottom edge of the screen.
  function makeHeightResizable(panelId, panel, handle) {
    let sy, sh, ot, resizing = false;
    handle.addEventListener("mousedown", (e) => {
      resizing = true;
      const r = panel.getBoundingClientRect();
      sh = r.height; sy = e.clientY; ot = r.top;
      panel.style.top = r.top + "px"; panel.style.bottom = "auto";
      e.preventDefault(); e.stopPropagation();
    });
    window.addEventListener("mousemove", (e) => {
      if (!resizing) return;
      const maxH = Math.max(160, window.innerHeight - ot - MARGIN);
      panel.style.height = Math.max(160, Math.min(sh + (e.clientY - sy), maxH)) + "px";
    });
    window.addEventListener("mouseup", () => {
      if (!resizing) return;
      // Remember the resulting height so it survives a collapse/uncollapse cycle (setUncollapsed
      // always clears the inline height on collapse — without this it'd be forgotten on re-open).
      panels.get(panelId)?.setSize(panel.style.height);
      resizing = false;
      persistPrimary();
    });
  }

  // ---- spawn / registry ---------------------------------------------------
  function spawnPanel() {
    const panelId = "p" + (++panelSeq) + "-" + Math.random().toString(36).slice(2, 6);
    const inst = createPanel(panelId);
    panels.set(panelId, inst);
    inst.setHostVisible(enabled);
    window.postMessage({ __wdl: CHANNEL, kind: "registerPanel", panelId }, location.origin);
    linkedSet.add(panelId);
    inst.setLinkButton(true);
    layoutSideBySide();
    inst.clamp();
    setActivePanel(panelId);
    updateCloseButtons();
    return inst;
  }

  // Closing is a no-op while only one window remains — updateCloseButtons keeps every close
  // button's disabled state in sync with panels.size, so this guard and that display state can
  // never disagree.
  function closePanel(panelId) {
    if (panels.size <= 1) return;
    const inst = panels.get(panelId);
    if (!inst) return;

    panels.delete(panelId);
    linkedSet.delete(panelId);
    groupOffset.delete(panelId);
    inst.destroy();

    // Both roles must move to a surviving panel — there's always at least one left, since the
    // guard above refuses to close the last window.
    if (primaryPanelId === panelId) primaryPanelId = panels.keys().next().value;
    if (activePanelId === panelId) setActivePanel(panels.keys().next().value);

    window.postMessage({ __wdl: CHANNEL, kind: "unregisterPanel", panelId }, location.origin);
    updateCloseButtons();
    persistPrimary();
  }

  function updateCloseButtons() {
    const canClose = panels.size > 1;
    for (const inst of panels.values()) inst.setCloseEnabled(canClose);
  }

  const requestBattleList = () => {
    listRequested = true;
    window.postMessage({ __wdl: CHANNEL, kind: "requestBattleList" }, location.origin);
  };

  // ---- wiring: engine -> overlay -------------------------------------------
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.__wdl !== CHANNEL) return;
    if (d.kind === "summary") {
      const inst = panels.get(d.panelId);
      if (inst && enabled) inst.onSummary(d);
    } else if (d.kind === "battleList") {
      battleItems = d.battles || [];
      for (const inst of panels.values()) inst.onBattleListUpdated();
    }
  });

  // ---- toggle (extension on/off) -------------------------------------------
  const relayConfig = () => {
    window.postMessage({ __wdl: CHANNEL, kind: "config", enabled }, location.origin);
  };
  const setEnabled = (on) => {
    enabled = on;
    for (const inst of panels.values()) inst.setHostVisible(on);
    relayConfig();
    if (on) {
      for (const inst of panels.values()) inst.clamp(); // saved position mustn't leave a panel off-screen
      if (!listRequested) requestBattleList();
    }
  };

  try {
    chrome.storage?.onChanged.addListener((ch) => {
      if (ch.wdlEnabled) setEnabled(ch.wdlEnabled.newValue !== false);
    });
  } catch (_) {}

  // ---- boot -----------------------------------------------------------------
  const boot = () => {
    const first = spawnPanel();
    primaryPanelId = first.panelId;
    try {
      // Only touch position/size if something was actually saved — otherwise the CSS default
      // (top:24px;left:24px, set above) is already correct and needs no JS repositioning,
      // so there's no flash-then-jump on a fresh install / first-ever load.
      chrome.storage?.local.get(["wdlPos", "wdlSize", "wdlEnabled"], (v) => {
        if (v.wdlPos) {
          const left = parseFloat(v.wdlPos.left), top = parseFloat(v.wdlPos.top);
          if (Number.isFinite(left) && Number.isFinite(top)) first.setPos(left, top);
        }
        if (v.wdlSize) first.setSize(v.wdlSize.height);
        first.clamp();
        setEnabled(v.wdlEnabled !== false);
      });
    } catch (_) {
      first.clamp();
      relayConfig();
    }
    // The engine (map.js) needs a moment to build its country/region lookups before
    // battle.getGroupedActiveBattles is worth calling, and this whole thing runs at
    // document_start — very early — so the first attempt can occasionally come back empty
    // (page/session not fully settled yet). First shot after a short delay, then a safety-net
    // retry a bit later, only if the list is still empty by then.
    setTimeout(() => { if (enabled) requestBattleList(); }, 1500);
    setTimeout(() => { if (enabled && !battleItems.length) requestBattleList(); }, 4000);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
