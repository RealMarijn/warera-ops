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
  try { document.documentElement.dataset.wdlPanel = "1.12.0"; } catch (_) {}
  console.log("[WDL] overlay.js panel v1.12.0 (multi-window) loaded");

  const CHANNEL = "warera-dmg-lines";
  const FLAG = (code) => `https://media.warera.io/images/flags/${code}.svg?v=16`;
  const ATT = "#ff5a5a", DEF = "#5aa9ff";
  // Friendly names for battle.getGroupedActiveBattles groups, in display order.
  const GROUP_ORDER = ["favorites", "yourCountry", "orders", "enemy", "withBounty", "allies", "other", "tournament"];
  const GROUP_LABEL = {
    favorites: "Favorites", yourCountry: "Your country", allies: "Allies", enemy: "Enemies",
    withBounty: "With bounty", orders: "With orders", other: "Other", tournament: "Tournament",
  };
  const MARGIN = 4;
  const GAP = 12; // px between linked panels when laid out side by side
  const MIN_REVEAL = 130; // px the panel grows by, at minimum, whenever it's uncollapsed (~3 country rows)

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
  let countryFeatureEnabled = true; // wdlCountryEnabled — the "Country damage" card's own on/off,
                                     // independent of the tracker windows' wdlEnabled toggle above
  let battleItems = [];   // last battleList payload — shared, one fetch serves every panel's picker
  let listRequested = false;
  const panels = new Map();   // panelId -> panel instance
  // "Country damage" windows (see near the bottom of this file) live in their own registry —
  // countryPanels — but participate in the SAME linked-group dragging/layout machinery as the
  // tracker panels above (linkedSet/groupOffset/layoutSideBySide/makeDraggable) via instOf(), which
  // resolves either kind of panelId to a common minimal interface (getRect/getPos/setPos/clamp/
  // setLinkButton/setActive/bringToFront/panelEl). The two registries use distinct id prefixes
  // ("p" vs "cp"), so there's no collision risk in sharing lookups this way.
  const countryPanels = new Map(); // panelId -> country-panel instance
  const instOf = (id) => countryPanels.get(id) || panels.get(id);
  const linkedSet = new Set(); // panelIds (tracker + country) currently in the linked group (moved together)
  // Each linked member's offset from the group anchor, fixed at layout time (spawn/attach) and
  // NOT re-derived from on-screen position during a drag — see makeDraggable for why: screen
  // position gets clamped at the viewport edge, and if a panel's offset were re-read from its
  // (possibly already-clamped-to-the-edge) rect, dragging back away from the edge would have
  // nothing left to reconstruct the original spacing from, permanently collapsing the group.
  const groupOffset = new Map(); // panelId -> {dx, dy} relative to the anchor panel
  let activePanelId = null;
  let primaryPanelId = null;   // the first panel created this page load — the only one whose
                                // position/size persists across reloads (see restore()/persist below)
  let panelSeq = 0;

  // z-index: explicit and bounded, NOT auto. z-index:auto would let us lose gracefully to
  // WarEra's own auto-tier floating UI (chat, dialogs), but it *also* loses — unconditionally,
  // regardless of DOM order — to absolutely anything on the page with ANY explicit z-index, and
  // WarEra's ordinary page chrome has some (small values, but explicit beats auto no matter the
  // magnitude). That made our panels invisible, buried under normal page content instead of just
  // under chat. There's no single z-index value that both beats ordinary content AND loses to
  // auto-tier chat — those two constraints are in direct conflict per how CSS stacking works, not
  // something tunable. So: back to an explicit value, which at least keeps panels visible above
  // ordinary content (matches every other floating panel already on the page); the chat-specific
  // overlap needs a different, non-z-index approach if it's worth solving.
  // `zOrder` (back-to-front) is re-flattened onto [Z_BASE, Z_BASE+zOrder.length) on every
  // bringToFront, so the range used can't creep upward no matter how many activations happen
  // across a long session.
  const Z_BASE = 5;
  const zOrder = []; // panelIds (tracker + country), back-to-front
  const restackZ = () => {
    zOrder.forEach((id, i) => {
      const inst = instOf(id);
      if (inst) inst.panelEl.style.zIndex = String(Z_BASE + i);
    });
  };
  const raiseInZOrder = (panelId) => {
    const i = zOrder.indexOf(panelId);
    if (i !== -1) zOrder.splice(i, 1);
    zOrder.push(panelId);
    restackZ();
  };

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
    .row { display:flex; align-items:center; gap:8px; margin:5px 0; font-size:12px; }
    .row img { width:18px; height:13px; object-fit:cover; border-radius:2px; flex:none; }
    .row .nm { flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .row .amt { font-weight:700; font-variant-numeric: tabular-nums; }
    .row .rate { opacity:.6; font-size:10px; margin-left:2px; }
    .bar { height:3px; border-radius:2px; margin-top:2px; }
  `;

  // ---- shared position clamping ---------------------------------------------
  // Keeps an element within the viewport (with a small margin), only touching its position if it's
  // actually out of bounds. Used by every panel-like thing (tracker panels AND the country card) —
  // factored out here so both share the exact same edge behavior.
  const clampEl = (el) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    const maxLeft = Math.max(MARGIN, window.innerWidth - r.width - MARGIN);
    const maxTop = Math.max(MARGIN, window.innerHeight - r.height - MARGIN);
    const left = Math.min(Math.max(MARGIN, r.left), maxLeft);
    const top = Math.min(Math.max(MARGIN, r.top), maxTop);
    if (Math.round(left) !== Math.round(r.left) || Math.round(top) !== Math.round(r.top)) {
      el.style.left = left + "px"; el.style.top = top + "px";
      el.style.right = "auto"; el.style.bottom = "auto";
    }
  };

  // ---- group layout --------------------------------------------------------
  // Positions every linked member (tracker panels + the country card, if linked) left-to-right,
  // starting from the first (anchor) member's current top-left, then clamps the whole row back
  // on-screen. Called whenever the group's membership changes (spawn, attach).
  const layoutSideBySide = () => {
    const ids = [...linkedSet];
    if (!ids.length) return;
    const anchor = instOf(ids[0]);
    if (!anchor) return;
    const { left: anchorLeft, top: anchorTop } = anchor.getPos();
    let left = anchorLeft;
    for (const id of ids) {
      const inst = instOf(id);
      if (!inst) continue;
      inst.setPos(left, anchorTop);
      groupOffset.set(id, { dx: left - anchorLeft, dy: 0 });
      left += inst.getRect().width + GAP;
    }
    for (const id of ids) instOf(id)?.clamp();
  };

  const setLinked = (id, linked) => {
    if (linked) linkedSet.add(id); else { linkedSet.delete(id); groupOffset.delete(id); }
    const inst = instOf(id);
    if (inst) inst.setLinkButton(linked);
    // Re-flow the group either way: attaching adds a member at the end of the row, and detaching
    // closes the gap left behind — the remaining linked members slide together instead of staying
    // spread out around where the detached one used to be. The detached member itself isn't in
    // `ids` anymore (removed above), so its own position is left untouched.
    layoutSideBySide();
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

  // panelId may be a real tracker panelId OR a country-window panelId — "active" is a single,
  // mutually exclusive concept across both registries: whichever was clicked last is what draws
  // lines on the map (see map.js's activeBattleId / activeCountryPanelId), and gets the
  // highlighted border here.
  const setActivePanel = (panelId) => {
    if (activePanelId === panelId) {
      // Still bring it to front — clicking an already-active panel shouldn't be a no-op
      // if something else has since been raised above it.
      instOf(panelId)?.bringToFront();
      return;
    }
    const prev = activePanelId;
    activePanelId = panelId;
    if (prev) instOf(prev)?.setActive(false);
    const inst = instOf(panelId);
    if (inst) { inst.setActive(true); inst.bringToFront(); }
    if (countryPanels.has(panelId)) {
      window.postMessage({ __wdl: CHANNEL, kind: "setCountryActive", panelId }, location.origin);
    } else {
      window.postMessage({ __wdl: CHANNEL, kind: "setActivePanel", panelId }, location.origin);
    }
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
      panel.style.zIndex = String(Z_BASE); // raiseInZOrder assigns the real value right after this returns
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
      if (on) {
        // Grow DOWN from however tall the collapsed panel currently is, by at least MIN_REVEAL —
        // never just reapply a remembered custom height as-is: if that height was recorded while
        // shrinking the resize handle way up (dragged close to the collapsed height, or smaller),
        // reapplying it verbatim barely reveals anything. Whichever is taller wins, so a
        // deliberately-set larger custom height is still respected.
        const collapsedHeight = els.panel.getBoundingClientRect().height;
        const customPx = customHeight ? parseFloat(customHeight) : 0;
        els.panel.style.height = Math.max(collapsedHeight + MIN_REVEAL, customPx) + "px";
        els.body.style.display = "";
        els.hrsz.style.display = "";
      } else {
        els.body.style.display = "none";
        els.hrsz.style.display = "none";
        // Collapsing always reverts to auto height — otherwise the panel would keep whatever
        // tall height it had while uncollapsed, leaving an empty gap below the collapsed content.
        els.panel.style.height = "";
      }
      els.uncollapseBtn.textContent = on ? "▴ Hide supporting countries" : "▾ Show supporting countries";
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
      // fighting nation's own position (see map.js) — not duplicated here. No legend for
      // defender/attacker color either — the bar colors already read directly against the
      // header's def/att colors right above.
      els.body.innerHTML = rows;
    };

    // ---- position/size/visibility ------------------------------------------
    // Keep the whole panel within the viewport (with a small margin). Only repositions when
    // it's actually out of bounds, so it doesn't disturb the default anchoring.
    const clamp = () => {
      if (!els || !host || host.style.display === "none") return;
      clampEl(els.panel);
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
    const bringToFront = () => raiseInZOrder(panelId);
    const setLinkButton = (linked) => {
      els.linkBtn.setAttribute("data-linked", linked ? "1" : "0");
      els.linkBtn.title = linked ? "Detach from group" : "Attach to group";
    };
    const setCloseEnabled = (on) => {
      els.closeBtn.disabled = !on;
      els.closeBtn.title = "Close this tracker window";
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

  // panelId may be a real tracker panelId OR a country-window panelId — instOf() resolves either
  // to a common getRect/getPos/setPos interface, so a country window can be dragged (and can drag
  // its linked group along with it) exactly like a tracker panel.
  function makeDraggable(panelId, handle) {
    let dragging = false;
    let startMouseX, startMouseY;
    let draggedStart = null; // {left, top, w, h} of the panel actually grabbed, captured at drag start
    let followers = null;    // Map<panelId, {dx, dy, w, h}> other linked panels, offset relative to the dragged one

    handle.addEventListener("mousedown", (e) => {
      const inst = instOf(panelId);
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
          const other = instOf(id);
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
      instOf(panelId)?.setPos(draggedLeft, draggedTop);

      // Each follower sticks to the edge (via its own clamp) while draggedLeft/Top + its fixed
      // offset would still be off-screen, and snaps directly to its correct spot the moment that
      // stops being true — it never has to "catch up" from a collapsed position because its
      // target position is always computed fresh from the dragged panel's actual position, not
      // from wherever it last happened to render.
      for (const [id, f] of followers) {
        const inst = instOf(id);
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
  // Re-clamp every panel (tracker AND country windows) on viewport resize so a shrinking window
  // can't leave anything off-screen.
  window.addEventListener("resize", () => {
    for (const inst of panels.values()) inst.clamp();
    for (const inst of countryPanels.values()) inst.clamp();
  });

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

  // Closing the very last window is allowed too — the popup's "Damage tracker"
  // toggle (off then on) respawns a fresh first panel, see setEnabled below.
  function closePanel(panelId) {
    const inst = panels.get(panelId);
    if (!inst) return;

    panels.delete(panelId);
    linkedSet.delete(panelId);
    groupOffset.delete(panelId);
    // Must actually remove (not just leave a dead entry) — zOrder.length directly determines the
    // z-index range restackZ hands out, so a dead entry left behind would let that range creep up
    // over many open/close cycles across a long session, same problem this scheme exists to avoid.
    const zi = zOrder.indexOf(panelId);
    if (zi !== -1) zOrder.splice(zi, 1);
    inst.destroy();

    // Close the gap the removed panel left behind — same as detaching (setLinked): the remaining
    // linked members (tracker panels and/or the country card) slide together instead of staying
    // spread out around where the closed window used to sit.
    layoutSideBySide();

    // A surviving tracker panel takes over the "primary" (position-persisting) role, if there is
    // one — otherwise there's nothing left to hand it to until setEnabled respawns one.
    const trackerSurvivor = panels.size ? panels.keys().next().value : null;
    if (primaryPanelId === panelId) primaryPanelId = trackerSurvivor;
    // "Active" prefers another tracker panel first (matching prior behavior), falling back to a
    // country window if none are left — mirrors closeCountryPanel's own (reversed) preference.
    if (activePanelId === panelId) {
      const activeSurvivor = trackerSurvivor || (countryPanels.size ? countryPanels.keys().next().value : null);
      if (activeSurvivor) setActivePanel(activeSurvivor);
      else activePanelId = null;
    }

    window.postMessage({ __wdl: CHANNEL, kind: "unregisterPanel", panelId }, location.origin);
    updateCloseButtons();
    persistPrimary();

    // Closing the last window leaves nothing on screen — reflect that in the
    // popup's "Damage lines" toggle rather than leaving it checked with
    // nothing to show for it. This also drives setEnabled(false) via the
    // storage listener below; re-checking the toggle afterward is how the
    // user gets a first window back (see setEnabled).
    if (!panels.size) {
      try { chrome.storage?.local.set({ wdlEnabled: false }); } catch (_) {}
    }
  }

  function updateCloseButtons() {
    for (const inst of panels.values()) inst.setCloseEnabled(true);
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
    } else if (d.kind === "countryList") {
      ccCountries = d.countries || [];
      for (const inst of countryPanels.values()) inst.onCountryListUpdated();
    } else if (d.kind === "countrySummary") {
      const inst = countryPanels.get(d.panelId);
      if (inst) inst.onSummary(d);
    }
  });

  // ---- toggle (extension on/off) -------------------------------------------
  const relayConfig = () => {
    window.postMessage({ __wdl: CHANNEL, kind: "config", enabled }, location.origin);
  };
  const setEnabled = (on) => {
    enabled = on;
    // The user can close every tracker window (including the last one) via
    // its ✕ button now — re-enabling here with zero panels left is how they
    // get one back, same as a fresh page load's initial spawnPanel().
    if (on && panels.size === 0) {
      const p = spawnPanel();
      primaryPanelId = p.panelId;
    }
    for (const inst of panels.values()) inst.setHostVisible(on);
    relayConfig();
    if (on) {
      for (const inst of panels.values()) inst.clamp(); // saved position mustn't leave a panel off-screen
      if (!listRequested) requestBattleList();
    }
  };

  // ---- toggle (country damage on/off) ---------------------------------------
  // Fully independent of setEnabled/wdlEnabled above — closing every tracker window auto-disables
  // wdlEnabled (see closePanel), and that must NOT cascade into hiding the country windows too, nor
  // should wdlEnabled being off ever block turning country damage on. Mirrors setEnabled's own
  // shape (respawn-on-zero, relay a config message to the engine) but as its own independent toggle.
  const ccVisibleNow = () => countryFeatureEnabled;
  const relayCountryConfig = () => {
    window.postMessage({ __wdl: CHANNEL, kind: "countryConfig", enabled: countryFeatureEnabled }, location.origin);
  };
  const setCountryFeatureEnabled = (on) => {
    countryFeatureEnabled = on;
    setCountryPanelsVisible(on);
    relayCountryConfig();
    if (on) requestCountryList();
  };

  // ---- toggle (core-country-colors map mode) --------------------------------
  // Independent of the damage-tracker on/off above — purely relays the popup's
  // storage toggle to the MAIN-world engine (map.js), which owns the actual
  // map-layer logic. Defaults OFF (unlike the other toggles): it's a bigger
  // visual change to the map, not something everyone wants on by default.
  const relayCoreColors = (on) => {
    window.postMessage({ __wdl: CHANNEL, kind: "coreColors", enabled: on }, location.origin);
  };

  try {
    chrome.storage?.onChanged.addListener((ch) => {
      if (ch.wdlEnabled) setEnabled(ch.wdlEnabled.newValue !== false);
      if (ch.coreColorsEnabled) relayCoreColors(ch.coreColorsEnabled.newValue === true);
      if (ch.wdlCountryEnabled) setCountryFeatureEnabled(ch.wdlCountryEnabled.newValue !== false);
    });
  } catch (_) {}

  // ---- "Country damage" panels (multi-window, mirrors the tracker panels above) ----------------
  // Pick a country and the engine draws a line to every active battle it deals damage in (see
  // map.js "by country" mode). Any number of these windows can be open at once (the "+" button
  // spawns another, same as the tracker panels), each independently picking its own country.
  // Shown/hidden by BOTH wdlEnabled (the whole tracker) and their own wdlCountryEnabled toggle.
  // Drag-links to the tracker panels (and each other) via the shared linkedSet/groupOffset/
  // layoutSideBySide/makeDraggable machinery above, through instOf().
  let ccCountries = [];      // [{cid,name,code}] — SHARED list, same data in every window
  let countryPanelSeq = 0;
  // Only "total" (the raw cumulative per-battle total) and "now" (since last clicked) — a rolling
  // "last hour"/"last minute" window was tried and dropped: with only a 10-30s poll cadence it's
  // never accurate right after switching to it (nothing to backfill from), which read as broken.
  const CC_WINDOWS = [
    { id: "total", label: "Ongoing battles" },
    { id: "now", label: "Now" },
  ];
  const requestCountryList = () => window.postMessage({ __wdl: CHANNEL, kind: "requestCountryList" }, location.origin);

  const CC_CSS = `
    :host { all: initial; }
    .cp { position: fixed; top: 24px; right: 24px; width: 232px; box-sizing: border-box; z-index: ${Z_BASE};
      display:flex; flex-direction:column; max-height: calc(100vh - 48px); min-height: 0;
      font-family: "Saira", system-ui, sans-serif; color: #e8e8ea;
      background: rgba(18,20,26,.92); border: 1px solid rgba(255,255,255,.12);
      border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.5); transition: box-shadow .15s; }
    .cp.active { box-shadow: 0 0 0 2px rgba(255,255,255,.55), 0 10px 34px rgba(0,0,0,.55); }
    .h { display:flex; align-items:center; gap:6px; padding:8px 10px; cursor:move; font-weight:700; font-size:12px;
      border-bottom:1px solid rgba(255,255,255,.08); flex:none; }
    .h .dot { width:8px; height:8px; border-radius:50%; background:#ffcc44; box-shadow:0 0 8px #ffcc44; flex:none; }
    .h .sp { flex:1; }
    .h .cd { font-size:9.5px; opacity:.55; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .h button { all:unset; position:relative; cursor:pointer; opacity:.6; font-size:13px; padding:0 3px; }
    .h button:hover { opacity:1; }
    .h button:disabled { opacity:.25; cursor:default; }
    .h button:disabled:hover { opacity:.25; }
    .h .link[data-linked="0"] { opacity:.4; }
    .h .link[data-linked="0"]::before {
      content:""; position:absolute; left:1px; right:1px; top:50%; height:1px;
      background: currentColor; transform: rotate(-38deg);
    }
    .b { padding:8px 10px 10px; flex:1 1 auto; min-height:0; display:flex; flex-direction:column; }
    .fl { width:16px; height:12px; object-fit:cover; border-radius:2px; flex:none; display:inline-block; }
    .combo { position:relative; flex:none; }
    .cbtn { display:flex; align-items:center; gap:5px; width:100%; box-sizing:border-box; background:#20242e; color:#e8e8ea;
      border:1px solid rgba(255,255,255,.14); border-radius:6px; padding:5px 6px; font:inherit; font-size:12px; cursor:pointer; text-align:left; }
    .cbtn .lbl { display:flex; align-items:center; gap:6px; flex:1; min-width:0; overflow:hidden; white-space:nowrap; }
    .cbtn .lbl.ph { opacity:.55; }
    .cbtn .lbl .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .cbtn .caret { margin-left:auto; opacity:.6; flex:none; }
    .cpop { position:absolute; left:0; right:0; top:calc(100% + 4px); z-index:2;
      background:#181b22; border:1px solid rgba(255,255,255,.16); border-radius:8px;
      box-shadow:0 12px 34px rgba(0,0,0,.6); overflow:hidden; }
    .cpop[hidden]{ display:none; }
    .csearch { width:100%; box-sizing:border-box; background:#0f1116; color:#e8e8ea; border:0;
      border-bottom:1px solid rgba(255,255,255,.1); padding:7px 9px; font:inherit; font-size:12px; outline:none; }
    .clist { max-height:240px; overflow-y:auto; padding:4px; }
    .copt { display:flex; align-items:center; gap:6px; padding:5px 6px; border-radius:5px; cursor:pointer; font-size:12px; }
    .copt:hover, .copt.active { background:rgba(255,255,255,.09); }
    .copt .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .cclear { display:flex; align-items:center; gap:6px; padding:6px; margin-bottom:2px; border-radius:5px; cursor:pointer;
      font-size:12px; opacity:.85; border-bottom:1px solid rgba(255,255,255,.06); }
    .cclear:hover, .cclear.active { background:rgba(255,255,255,.09); }
    .cnone { opacity:.5; font-size:11px; padding:12px 8px; text-align:center; }
    .wins { display:flex; gap:4px; margin-top:8px; flex:none; }
    .wins button { all:unset; flex:1; text-align:center; cursor:pointer; font-size:10.5px; padding:3px 0;
      border:1px solid rgba(255,255,255,.14); border-radius:5px; opacity:.75; box-sizing:border-box; }
    .wins button:hover { opacity:1; }
    .wins button.active { background:rgba(255,204,68,.16); border-color:rgba(255,204,68,.5); opacity:1; color:#ffcc44; }
    .out { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; overflow:hidden; margin-top:8px; }
    .tot[hidden], .lst[hidden], .empty[hidden] { display:none; }
    .tot { font-size:11px; opacity:.7; margin:0 0 4px; flex:none; }
    .lst { overflow-y:hidden; min-height:0; max-height:54px; transition:max-height .15s ease; }
    .lst.open { max-height:190px; overflow-y:auto; }
    .lst.grown { max-height:none; flex:1 1 auto; overflow-y:auto; }
    .r { display:flex; align-items:center; gap:8px; font-size:12px; margin:4px 0 1px; }
    .r .nm { flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .r .amt { font-weight:700; color:#ffcc44; font-variant-numeric:tabular-nums; }
    .bar { height:3px; border-radius:2px; background:#ffcc44; }
    .empty { opacity:.55; font-size:11px; padding:10px 2px; text-align:center; line-height:1.4; flex:none; }
    .uncollapse { all:unset; display:block; box-sizing:border-box; width:100%; text-align:center;
      margin-top:6px; padding:4px 8px; font:inherit; font-size:10.5px; opacity:.7; cursor:pointer;
      border-top:1px solid rgba(255,255,255,.08); flex:none; }
    .uncollapse:hover { opacity:1; }
    .hrsz { display:block; flex:none; height:8px; cursor:ns-resize; position:relative; margin-top:2px; }
    .hrsz::after { content:""; position:absolute; left:50%; top:50%; width:24px; height:3px;
      transform:translate(-50%,-50%); border-radius:2px; background:rgba(255,255,255,.22); }
    .hrsz:hover::after { background:rgba(255,255,255,.4); }
  `;

  function createCountryPanel(panelId) {
    let host, root, els;
    let selected = "";
    let comboOpen = false, activeIdx = -1, flat = [];
    let uncollapsed = false;   // collapsed by default: peek of ~2 rows, see CSS .lst/.lst.open
    let customHeight = null;  // remembered manual resize height, like the tracker panels'
    let windowSel = "total";  // "total" | "now" — see map.js windowedDamage()
    let nextUpdateAt = 0;     // countdown target, from the engine's countrySummary messages

    const build = () => {
      host = document.createElement("div");
      host.id = "wdl-country-host-" + panelId;
      root = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = CC_CSS;
      root.appendChild(style);

      const cp = document.createElement("div");
      cp.className = "cp";
      cp.style.zIndex = String(Z_BASE); // raiseInZOrder assigns the real value right after this returns
      cp.innerHTML = `<div class="h"><span class="dot"></span><span>Country damage</span><span class="sp"></span>
          <span class="cd" title="Time until the next refresh"></span>
          <button data-act="add" title="New country damage window">+</button>
          <button class="link" data-act="link" data-linked="1" title="Detach from group">⛓</button>
          <button class="close" data-act="close" title="Close this country damage window">✕</button></div>
        <div class="b">
          <div class="combo">
            <button class="cbtn" type="button"><span class="lbl ph">Select a country…</span><span class="caret">▾</span></button>
            <div class="cpop" hidden>
              <input class="csearch" type="text" placeholder="Search countries…" spellcheck="false">
              <div class="clist"></div>
            </div>
          </div>
          <div class="wins">
            <button data-win="total" class="active" type="button" title="Each battle's full damage total since it started">Ongoing battles</button>
            <button data-win="now" type="button" title="Damage dealt since this button was last clicked — click again to reset">Now</button>
          </div>
          <div class="out">
            <div class="tot" hidden></div>
            <div class="lst" hidden></div>
            <div class="empty">Pick a country to see where it deals damage.</div>
          </div>
          <button class="uncollapse" type="button">▾ Show more</button>
          <div class="hrsz" title="Drag to resize" style="display:none"></div>
        </div>`;
      root.appendChild(cp);
      document.documentElement.appendChild(host);

      els = {
        cp, h: cp.querySelector(".h"), cd: cp.querySelector(".cd"), linkBtn: cp.querySelector(".link"),
        closeBtn: cp.querySelector(".close"),
        combo: cp.querySelector(".combo"),
        cbtn: cp.querySelector(".cbtn"), lbl: cp.querySelector(".cbtn .lbl"),
        cpop: cp.querySelector(".cpop"), csearch: cp.querySelector(".csearch"),
        clist: cp.querySelector(".clist"), out: cp.querySelector(".out"),
        tot: cp.querySelector(".tot"), lst: cp.querySelector(".lst"), emptyEl: cp.querySelector(".empty"),
        winBtns: cp.querySelectorAll(".wins button"),
        uncollapseBtn: cp.querySelector(".uncollapse"), hrsz: cp.querySelector(".hrsz"),
      };
      els.cbtn.addEventListener("click", () => (comboOpen ? closeCombo() : openCombo()));
      els.csearch.addEventListener("input", () => { activeIdx = 0; renderList(); });
      els.csearch.addEventListener("keydown", onSearchKey);
      els.clist.addEventListener("click", (e) => {
        const opt = e.target.closest("[data-id]");
        if (opt) choose(opt.getAttribute("data-id"));
      });
      window.addEventListener("mousedown", (e) => {
        if (comboOpen && !e.composedPath().includes(els.combo)) closeCombo();
      }, true);
      cp.querySelector('[data-act="add"]').addEventListener("click", () => {
        spawnCountryPanel();
        requestCountryList(); // opening a new window refreshes the shared list too
      });
      els.linkBtn.addEventListener("click", () => {
        const nowLinked = els.linkBtn.getAttribute("data-linked") !== "1";
        setLinked(panelId, nowLinked);
      });
      // Closing this window; closing the LAST one turns off the popup's "Country damage" toggle,
      // same as closing the last LIVE tracker window turns off "Damage lines".
      els.closeBtn.addEventListener("click", () => closeCountryPanel(panelId));
      for (const btn of els.winBtns) {
        btn.addEventListener("click", () => chooseWindow(btn.getAttribute("data-win")));
      }
      els.uncollapseBtn.addEventListener("click", () => setUncollapsed(!uncollapsed));
      // Any interaction with the window makes it the active thing (its country's lines draw on
      // the map instead of any tracker panel's battle, or any other country window's) — same as
      // clicking into a tracker panel.
      cp.addEventListener("mousedown", () => setActivePanel(panelId));
      makeDraggable(panelId, els.h);
      makeHeightResizable();
      setUncollapsed(true); // "Show more" is the default view
    };

    // Bottom-edge handle resizes this window's height only, exactly like the tracker panels'
    // makeHeightResizable — only present while uncollapsed (see setUncollapsed).
    function makeHeightResizable() {
      let sy, sh, ot, resizing = false;
      els.hrsz.addEventListener("mousedown", (e) => {
        resizing = true;
        const r = els.cp.getBoundingClientRect();
        sh = r.height; sy = e.clientY; ot = r.top;
        els.cp.style.top = r.top + "px"; els.cp.style.bottom = "auto";
        els.lst.classList.add("grown");
        e.preventDefault(); e.stopPropagation();
      });
      window.addEventListener("mousemove", (e) => {
        if (!resizing) return;
        const maxH = Math.max(160, window.innerHeight - ot - MARGIN);
        els.cp.style.height = Math.max(160, Math.min(sh + (e.clientY - sy), maxH)) + "px";
      });
      window.addEventListener("mouseup", () => {
        if (!resizing) return;
        resizing = false;
        customHeight = els.cp.style.height;
      });
    }

    // Collapsed (default): the list is capped to a ~2-row peek (CSS .lst, no scroll). Uncollapsed:
    // capped to a ~7-row window with scrolling (CSS .lst.open); dragging .hrsz grows the WINDOW,
    // and .lst.grown switches it to fill that extra space (flex) instead of staying capped,
    // revealing more of the (always fully-rendered) list.
    const setUncollapsed = (on) => {
      uncollapsed = on;
      if (on) {
        els.lst.classList.add("open");
        els.hrsz.style.display = "";
        if (customHeight) { els.cp.style.height = customHeight; els.lst.classList.add("grown"); }
      } else {
        els.lst.classList.remove("open", "grown");
        els.hrsz.style.display = "none";
        els.cp.style.height = "";
      }
      els.uncollapseBtn.textContent = on ? "▴ Show less" : "▾ Show more";
    };

    const openCombo = () => {
      comboOpen = true; els.cpop.hidden = false; els.csearch.value = "";
      activeIdx = 0; renderList(); els.csearch.focus();
      requestCountryList(); // always refresh on open, not just when empty — see the battle picker's openPicker
    };
    const closeCombo = () => { if (!comboOpen) return; comboOpen = false; els.cpop.hidden = true; };

    const filteredCountries = () => {
      const q = els.csearch.value.trim().toLowerCase();
      return q ? ccCountries.filter((c) => (c.name || "").toLowerCase().includes(q)) : ccCountries;
    };

    const renderList = () => {
      const items = filteredCountries();
      flat = [""]; // index 0 = the clear/none row
      let html = `<div class="cclear" data-id=""><span class="fl"></span><span class="nm" style="opacity:.7">None (clear)</span></div>`;
      for (const c of items) {
        const idx = flat.length;
        flat.push(c.cid);
        html += `<div class="copt" data-id="${esc(c.cid)}" data-idx="${idx}" title="${esc(c.name || "")}">${flagImg(c)}<span class="nm">${esc(c.name || "?")}</span></div>`;
      }
      if (!items.length) html += `<div class="cnone">No matching countries.</div>`;
      els.clist.innerHTML = html;
      highlight();
    };

    const highlight = () => {
      els.clist.querySelectorAll("[data-id]").forEach((r) => {
        const i = r.classList.contains("cclear") ? 0 : Number(r.getAttribute("data-idx"));
        const on = i === activeIdx;
        r.classList.toggle("active", on);
        if (on) r.scrollIntoView({ block: "nearest" });
      });
    };

    const onSearchKey = (e) => {
      if (e.key === "ArrowDown") { activeIdx = Math.min(flat.length - 1, activeIdx + 1); highlight(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { activeIdx = Math.max(0, activeIdx - 1); highlight(); e.preventDefault(); }
      else if (e.key === "Enter") { if (activeIdx >= 0 && activeIdx < flat.length) choose(flat[activeIdx]); e.preventDefault(); }
      else if (e.key === "Escape") { closeCombo(); }
    };

    const renderTrigger = () => {
      const c = ccCountries.find((x) => x.cid === selected);
      if (selected && c) { els.lbl.className = "lbl"; els.lbl.innerHTML = `${flagImg(c)}<span class="nm">${esc(c.name || "?")}</span>`; }
      else if (selected) { els.lbl.className = "lbl"; els.lbl.textContent = "Selected country"; }
      else { els.lbl.className = "lbl ph"; els.lbl.textContent = "Select a country…"; }
    };

    const setEmpty = (msg) => {
      els.tot.hidden = true;
      els.lst.hidden = true;
      els.emptyEl.hidden = false;
      els.emptyEl.textContent = msg;
    };

    const choose = (cid) => {
      selected = cid || "";
      renderTrigger();
      closeCombo();
      nextUpdateAt = 0;
      window.postMessage({ __wdl: CHANNEL, kind: "selectCountry", panelId, countryId: selected || null }, location.origin);
      setEmpty(selected ? "Loading…" : "Pick a country to see where it deals damage.");
    };

    const chooseWindow = (win) => {
      if (!CC_WINDOWS.some((w) => w.id === win)) return;
      windowSel = win;
      for (const b of els.winBtns) b.classList.toggle("active", b.getAttribute("data-win") === win);
      window.postMessage({ __wdl: CHANNEL, kind: "selectCountryWindow", panelId, window: win }, location.origin);
    };

    // Clears the selection without closing the window — used when the whole feature is hidden
    // (toggled off) so nothing keeps polling in the background while nothing is shown.
    const clearSelection = () => {
      if (!selected) return;
      selected = "";
      nextUpdateAt = 0;
      renderTrigger();
      closeCombo();
      setEmpty("Pick a country to see where it deals damage.");
      window.postMessage({ __wdl: CHANNEL, kind: "selectCountry", panelId, countryId: null }, location.origin);
    };

    const onCountryListUpdated = () => {
      renderTrigger();               // the selected country's flag/name may only now be resolvable
      if (comboOpen) renderList();
    };

    // The list/total are STABLE elements (built once in build()) — only their content is updated
    // here, never the elements themselves, so els.lst stays a valid reference for the collapse/
    // resize CSS-class toggling in setUncollapsed/makeHeightResizable.
    const onSummary = (d) => {
      if (d.countryId !== selected) return; // ignore stale / other-selection updates
      nextUpdateAt = d.nextUpdateAt || 0;
      if (!selected) { setEmpty("Pick a country to see where it deals damage."); return; }
      const targets = d.targets || [];
      if (!targets.length) {
        setEmpty(`No damage from ${d.name || "this country"} in the selected window right now.`);
        return;
      }
      els.emptyEl.hidden = true;
      els.tot.hidden = false;
      els.tot.textContent = `${targets.length} battle${targets.length > 1 ? "s" : ""} · ${fmt(d.total)} total`;
      els.lst.hidden = false;
      const max = Math.max(1, ...targets.map((t) => t.damage));
      els.lst.innerHTML = targets.map((t) =>
        `<div><div class="r"><span class="nm">${esc(t.regionName || "?")}</span><span class="amt">${fmt(t.damage)}</span></div>` +
        `<div class="bar" style="width:${Math.max(3, (t.damage / max) * 100)}%"></div></div>`).join("");
    };

    // Ticks the "time until the next refresh" label in the header every second.
    let tickTimer = setInterval(() => {
      if (!selected || !nextUpdateAt) { els.cd.textContent = ""; return; }
      const secs = Math.max(0, Math.ceil((nextUpdateAt - Date.now()) / 1000));
      els.cd.textContent = `↻ ${secs}s`;
    }, 1000);

    const getRect = () => els.cp.getBoundingClientRect();
    const getPos = () => { const r = getRect(); return { left: r.left, top: r.top }; };
    const setPos = (left, top) => {
      els.cp.style.left = left + "px"; els.cp.style.top = top + "px";
      els.cp.style.right = "auto"; els.cp.style.bottom = "auto";
    };
    const clamp = () => clampEl(els && els.cp);
    const setActive = (on) => els.cp.classList.toggle("active", on);
    const bringToFront = () => raiseInZOrder(panelId);
    const setLinkButton = (linked) => {
      els.linkBtn.setAttribute("data-linked", linked ? "1" : "0");
      els.linkBtn.title = linked ? "Detach from group" : "Attach to group";
    };
    const setHostVisible = (on) => { if (host) host.style.display = on ? "" : "none"; };
    const destroy = () => {
      clearInterval(tickTimer);
      if (host) { host.remove(); host = null; }
    };

    build();

    return {
      panelId,
      get panelEl() { return els.cp; },
      onSummary, onCountryListUpdated,
      getRect, getPos, setPos, clamp, setActive, bringToFront, setLinkButton,
      setHostVisible, clearSelection, destroy,
      choose,
    };
  }

  // ---- spawn / registry (mirrors spawnPanel/closePanel above) ---------------------------------
  // activate=false is used only at boot, for the very first country window — it should exist but
  // NOT steal "active" away from the tracker panel that boot() already activated moments earlier.
  // Every other spawn (the "+" button, or re-enabling from zero) activates, same as tracker panels.
  function spawnCountryPanel(activate = true) {
    const panelId = "cp" + (++countryPanelSeq) + "-" + Math.random().toString(36).slice(2, 6);
    const inst = createCountryPanel(panelId);
    countryPanels.set(panelId, inst);
    inst.setHostVisible(ccVisibleNow());
    linkedSet.add(panelId);
    inst.setLinkButton(true);
    layoutSideBySide();
    inst.clamp();
    if (activate) setActivePanel(panelId);
    return inst;
  }

  function closeCountryPanel(panelId) {
    const inst = countryPanels.get(panelId);
    if (!inst) return;

    countryPanels.delete(panelId);
    linkedSet.delete(panelId);
    groupOffset.delete(panelId);
    const zi = zOrder.indexOf(panelId);
    if (zi !== -1) zOrder.splice(zi, 1);
    inst.destroy();

    // Close the gap the removed window left behind — same as detaching (setLinked) or closing a
    // tracker panel (closePanel): the remaining linked members slide together.
    layoutSideBySide();

    if (activePanelId === panelId) {
      // Hand activity to a surviving country window first, then a tracker panel, matching the
      // "closest kind of thing" preference closePanel uses for its own survivor.
      const survivor = countryPanels.size ? countryPanels.keys().next().value
        : (panels.size ? panels.keys().next().value : null);
      if (survivor) setActivePanel(survivor);
      else activePanelId = null;
    }

    window.postMessage({ __wdl: CHANNEL, kind: "unregisterCountryPanel", panelId }, location.origin);

    // Closing the last country window leaves nothing on screen — reflect that in the popup's
    // "Country damage" toggle, same as closing the last LIVE tracker window turns off "Damage
    // lines". Re-checking it there is how the user gets a first window back (see setCountryFeatureEnabled).
    if (!countryPanels.size) {
      setCountryFeatureEnabled(false); // no-op on the (now-empty) countryPanels, just flips the flag + relays
      try { chrome.storage?.local.set({ wdlCountryEnabled: false }); } catch (_) {}
    }
  }

  // Shows/hides every open country window together (driven by wdlCountryEnabled alone — see
  // setCountryFeatureEnabled/ccVisibleNow; independent of the tracker windows' wdlEnabled). Mirrors
  // setEnabled's tracker-panel handling: respawns a first window when turning on from zero, and
  // hands "active" back to a tracker panel (plus clears every window's selection) when turning off.
  const setCountryPanelsVisible = (on) => {
    if (on && countryPanels.size === 0) spawnCountryPanel();
    for (const inst of countryPanels.values()) inst.setHostVisible(on);
    if (on) {
      for (const inst of countryPanels.values()) inst.clamp();
    } else {
      if (activePanelId && countryPanels.has(activePanelId)) {
        const survivor = panels.size ? panels.keys().next().value : null;
        if (survivor) setActivePanel(survivor);
        else activePanelId = null;
      }
      for (const inst of countryPanels.values()) inst.clearSelection();
    }
  };

  // ---- boot -----------------------------------------------------------------
  const boot = () => {
    const first = spawnPanel();
    primaryPanelId = first.panelId;
    // activate=false: this window should exist, but not steal "active" away from the tracker
    // panel spawnPanel() just activated above (see spawnCountryPanel's own comment).
    spawnCountryPanel(false);
    try {
      // Only touch position/size if something was actually saved — otherwise the CSS default
      // (top:24px;left:24px, set above) is already correct and needs no JS repositioning,
      // so there's no flash-then-jump on a fresh install / first-ever load.
      chrome.storage?.local.get(
        ["wdlPos", "wdlSize", "wdlEnabled", "coreColorsEnabled", "wdlCountryEnabled"],
        (v) => {
          if (v.wdlPos) {
            const left = parseFloat(v.wdlPos.left), top = parseFloat(v.wdlPos.top);
            if (Number.isFinite(left) && Number.isFinite(top)) first.setPos(left, top);
          }
          if (v.wdlSize) first.setSize(v.wdlSize.height);
          first.clamp();
          // spawnCountryPanel() (above) already ran layoutSideBySide() once, anchoring the country
          // window to the tracker panel's DEFAULT position — but the restore just above may have
          // just moved that panel to a different saved position, which doesn't itself re-flow the
          // group. Redo it now so they start out properly aligned/adjacent instead of only fixing
          // itself the first time the user drags something.
          layoutSideBySide();
          // Independent toggles — order between them doesn't matter (see setCountryFeatureEnabled).
          setEnabled(v.wdlEnabled !== false);
          setCountryFeatureEnabled(v.wdlCountryEnabled !== false);
          relayCoreColors(v.coreColorsEnabled === true);
        }
      );
    } catch (_) {
      first.clamp();
      relayConfig();
      relayCountryConfig();
      relayCoreColors(false);
    }
    // The engine (map.js) needs a moment to build its country/region lookups before
    // battle.getGroupedActiveBattles is worth calling, and this whole thing runs at
    // document_start — very early — so the first attempt can occasionally come back empty
    // (page/session not fully settled yet). First shot after a short delay, then a safety-net
    // retry a bit later, only if the list is still empty by then. (The country combo also
    // re-requests every time it's opened — see openCombo — but this retry still matters for
    // the map lines' own country-label lookups, which don't get that same on-open nudge.)
    setTimeout(() => {
      if (enabled) requestBattleList();
      if (countryFeatureEnabled) requestCountryList();
    }, 1500);
    setTimeout(() => {
      if (enabled && !battleItems.length) requestBattleList();
      if (countryFeatureEnabled && !ccCountries.length) requestCountryList();
    }, 4000);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
