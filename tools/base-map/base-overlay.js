// WarEra Ops — Military bases / bunkers overlay (ISOLATED world).
//
// Two jobs, both requiring extension APIs the MAIN-world engine (base-map.js) can't touch:
//   1. Poll our whitelist-gated backend every 2 min for base/bunker status, and forward it to the
//      engine to draw. Only polls the layers the user enabled, and only while logged in.
//   2. Render the "a base/bunker just lit up" notification toasts the engine asks for — a stack of
//      glass cards, Shadow-DOM isolated, that stay until manually dismissed.
//
// Backend access rules (see docs/using-the-backend.md): never fetch() the backend directly; go
// through background.js via browser.runtime.sendMessage. A logged-out/de-whitelisted user just gets
// a rejected promise ("not_logged_in") — we treat that as "feature off" and show nothing.
(() => {
  "use strict";
  if (window.top !== window) return;
  try { document.documentElement.dataset.wbmPanel = "0.1.0"; } catch (_) {}
  console.log("[WBM] base-overlay.js panel v0.1.0 loaded");

  const CHANNEL = "warera-base-map";
  const LAYERS = ["bases", "bunkers"];
  const POLL_MS = 2 * 60 * 1000; // spec: refresh every 2 minutes
  const PATH = { bases: "/api/ext/regions/bases", bunkers: "/api/ext/regions/bunkers" };
  const META = {
    bases:   { color: "#f59e0b", label: "Military base" },
    bunkers: { color: "#38bdf8", label: "Bunker" },
  };

  const toggles = { bases: false, bunkers: false }; // user intent (popup/menu)
  let loggedIn = false;
  let pollTimer = null;
  let polling = false;

  const eff = (layer) => toggles[layer] && loggedIn;   // actually-on for this layer
  const anyEff = () => eff("bases") || eff("bunkers");

  const relay = (msg) => window.postMessage(Object.assign({ __wbm: CHANNEL }, msg), location.origin);
  const relayConfig = () => relay({ kind: "config", enabled: { bases: eff("bases"), bunkers: eff("bunkers") } });

  // ---- backend polling --------------------------------------------------
  const isLoggedOut = (err) =>
    err && (err.code === "not_logged_in" || /not_logged_in/.test(String(err.message || err)));

  async function poll() {
    if (polling || !anyEff()) return;
    polling = true;
    try {
      const out = {};
      for (const layer of LAYERS) {
        if (!eff(layer)) continue;
        try {
          const data = await browser.runtime.sendMessage({
            type: "WARERA_OPS_AUTHED_FETCH", path: PATH[layer], method: "GET",
          });
          out[layer] = data || {};
        } catch (err) {
          if (isLoggedOut(err)) { setLoggedIn(false); return; }
          console.warn("[WBM] backend fetch failed:", layer, err); // network/non-2xx → skip this cycle
        }
      }
      if (Object.keys(out).length) relay(Object.assign({ kind: "data" }, out));
    } finally {
      polling = false;
    }
  }

  function schedulePolling() {
    if (anyEff()) {
      if (!pollTimer) pollTimer = setInterval(poll, POLL_MS);
      poll(); // fetch immediately so the map/notifications don't wait up to 2 min
    } else if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function setLoggedIn(v) {
    if (loggedIn === v) return;
    loggedIn = v;
    relayConfig();      // engine clears layers that are no longer effectively on
    schedulePolling();
  }

  async function refreshAuth() {
    try {
      const status = await browser.runtime.sendMessage({ type: "WARERA_OPS_AUTH_STATUS" });
      setLoggedIn(!!status?.loggedIn);
    } catch (_) { setLoggedIn(false); }
  }

  // ---- notification toasts (Shadow DOM, glass, manual dismiss) ----------
  let host, root, stack;
  const shown = new Set(); // "layer:regionId" currently on screen — avoid duplicate toasts

  const CSS = `
    :host { all: initial; }
    .stack {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483646;
      display: flex; flex-direction: column; gap: 10px; max-width: 300px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", system-ui, sans-serif;
    }
    .card {
      display: flex; align-items: flex-start; gap: 10px; width: 300px; box-sizing: border-box;
      padding: 11px 12px; border-radius: 13px; color: #eef0f4;
      background: rgba(20, 23, 30, 0.72);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-left: 3px solid var(--accent, #f59e0b);
      backdrop-filter: blur(18px) saturate(150%); -webkit-backdrop-filter: blur(18px) saturate(150%);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
      animation: wbmIn 0.28s cubic-bezier(0.2, 0.9, 0.3, 1) both;
    }
    @keyframes wbmIn { from { opacity: 0; transform: translateY(12px) scale(0.98); } to { opacity: 1; transform: none; } }
    .card.out { animation: wbmOut 0.2s ease forwards; }
    @keyframes wbmOut { to { opacity: 0; transform: translateX(16px); } }
    .ico {
      width: 22px; height: 22px; border-radius: 7px; flex: none; margin-top: 1px;
      background: var(--accent, #f59e0b);
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
    }
    .ico svg { width: 14px; height: 14px; display: block; }
    .body { flex: 1; min-width: 0; }
    .ttl { font-size: 12.5px; font-weight: 600; letter-spacing: 0.1px; }
    .sub { font-size: 11px; margin-top: 2px; color: rgba(238, 240, 244, 0.62); line-height: 1.35; }
    .sub .accent { color: var(--accent, #f59e0b); font-weight: 600; }
    .ttl a { color: inherit; text-decoration: none; }
    .ttl a:hover { text-decoration: underline; }
    .sub a { color: var(--accent, #f59e0b); font-weight: 600; text-decoration: none; }
    .sub a:hover { text-decoration: underline; }
    .x {
      all: unset; cursor: pointer; flex: none; margin: -2px -2px 0 0;
      width: 20px; height: 20px; border-radius: 6px; color: rgba(238, 240, 244, 0.5);
      display: flex; align-items: center; justify-content: center; font-size: 15px; line-height: 1;
    }
    .x:hover { background: rgba(255, 255, 255, 0.08); color: #eef0f4; }
    .clear {
      all: unset; cursor: pointer; align-self: flex-end; font-size: 10.5px; font-weight: 600;
      color: rgba(238, 240, 244, 0.6); padding: 4px 10px; border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(20, 23, 30, 0.72);
      backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
    }
    .clear:hover { color: #eef0f4; border-color: rgba(255, 255, 255, 0.22); }
    .clear[hidden] { display: none; }
  `;

  const GLYPH = {
    bases: '<polygon points="0,-5.4 1.3,-1.7 5.1,-1.7 2,0.6 3.2,4.4 0,2 -3.2,4.4 -2,0.6 -5.1,-1.7 -1.3,-1.7" fill="#1a1400"/>',
    bunkers: '<path d="M -5 3.5 L -5 0 A 5 5 0 0 1 5 0 L 5 3.5 Z" fill="#062230"/>',
  };
  const svgIco = (layer) =>
    `<svg viewBox="-7 -7 14 14" xmlns="http://www.w3.org/2000/svg">${GLYPH[layer]}</svg>`;

  const esc = (s) => String(s == null ? "" : s).replace(/[<>&"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

  const fmtCountdown = (t) => {
    const ms = new Date(t).getTime() - Date.now();
    if (isNaN(ms)) return "";
    if (ms <= 0) return "any moment";
    const m = Math.round(ms / 60000);
    if (m < 60) return "in " + m + "m";
    const h = Math.floor(m / 60), mm = m % 60;
    return "in " + h + "h" + (mm ? " " + mm + "m" : "");
  };

  let clearBtn;
  const ensureHost = () => {
    if (host) return;
    host = document.createElement("div");
    host.id = "wbm-toasts";
    root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    stack = document.createElement("div");
    stack.className = "stack";
    clearBtn = document.createElement("button");
    clearBtn.className = "clear";
    clearBtn.hidden = true;
    clearBtn.textContent = "Dismiss all";
    clearBtn.addEventListener("click", () => { for (const c of [...stack.querySelectorAll(".card")]) removeCard(c); });
    stack.appendChild(clearBtn);
    root.append(style, stack);
    document.documentElement.appendChild(host);
  };

  const updateClearBtn = () => {
    if (clearBtn) clearBtn.hidden = stack.querySelectorAll(".card").length < 2;
  };

  const removeCard = (card) => {
    if (!card || card.classList.contains("out")) return;
    const key = card.dataset.key;
    card.classList.add("out");
    setTimeout(() => { card.remove(); shown.delete(key); updateClearBtn(); }, 200);
  };

  const regionUrl = (id) => "https://app.warera.io/region/" + encodeURIComponent(id);
  const regionLink = (name, id) =>
    id ? `<a target="_blank" href="${esc(regionUrl(id))}">${esc(name)}</a>` : esc(name);

  const makeCard = (key, layer, titleHtml, subHtml) => {
    if (shown.has(key)) return; // already on screen
    shown.add(key);
    ensureHost();
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.key = key;
    card.style.setProperty("--accent", META[layer].color);
    card.innerHTML = `
      <span class="ico">${svgIco(layer)}</span>
      <span class="body">
        <div class="ttl">${titleHtml}</div>
        <div class="sub">${subHtml}</div>
      </span>
      <button class="x" title="Dismiss">&times;</button>`;
    card.querySelector(".x").addEventListener("click", () => removeCard(card));
    stack.appendChild(card); // stack grows upward; newest sits nearest the screen edge
    updateClearBtn();
  };

  const addToast = (item) => {
    const meta = META[item.layer];
    const pending = item.status === "p";
    const state = pending
      ? `<span class="accent">activating</span>${item.t ? " " + esc(fmtCountdown(item.t)) : ""}`
      : `<span class="accent">now active</span>`;
    makeCard(
      item.layer + ":" + item.regionId,
      item.layer,
      regionLink(item.name, item.regionId),
      `${meta.label} ${state} · level ${esc(item.level ?? "?")}`,
    );
  };

  // Example toast fired the moment the user switches a layer on (a quick preview
  // of what a real "it lit up" notification looks like).
  const showTest = (layer, region) => {
    const label = layer === "bunkers" ? "bunker" : "military base";
    const name = (region && region.name) || "X";
    const id = region && region.id;
    makeCard(
      "test:" + layer,
      layer,
      "Voorbeeldnotificatie",
      `Dit is een voorbeeld notificatie van als een ${label} aan gaat in regio ${regionLink(name, id)}`,
    );
  };

  // The link should point at a real region, which only the MAIN engine knows.
  // Ask it for one; fall back to a placeholder if it can't answer in time (e.g.
  // the user enabled the layer while not on a map page).
  let sampleRegion = null;
  const pendingTest = { bases: false, bunkers: false };
  const requestTest = (layer) => {
    if (shown.has("test:" + layer)) return;
    if (sampleRegion) { showTest(layer, sampleRegion); return; }
    pendingTest[layer] = true;
    relay({ kind: "requestSample" });
    setTimeout(() => {
      if (pendingTest[layer]) { pendingTest[layer] = false; showTest(layer, null); }
    }, 2500);
  };

  // ---- wiring -----------------------------------------------------------
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.__wbm !== CHANNEL) return;
    if (d.kind === "notify") {
      for (const item of d.items || []) addToast(item);
    } else if (d.kind === "sample") {
      sampleRegion = d.region || null;
      for (const layer of LAYERS) {
        if (pendingTest[layer]) { pendingTest[layer] = false; showTest(layer, sampleRegion); }
      }
    }
  });

  const applyToggles = (v) => {
    toggles.bases = v.showBasesEnabled === true;
    toggles.bunkers = v.showBunkersEnabled === true;
  };

  browser.storage.local.get(["showBasesEnabled", "showBunkersEnabled"]).then((v) => {
    applyToggles(v);
    relayConfig();
    refreshAuth().then(schedulePolling);
  });

  browser.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if ("showBasesEnabled" in ch || "showBunkersEnabled" in ch) {
      for (const layer of LAYERS) {
        const key = layer === "bases" ? "showBasesEnabled" : "showBunkersEnabled";
        if (!(key in ch)) continue;
        const on = ch[key].newValue === true;
        const was = ch[key].oldValue === true;
        toggles[layer] = on;
        if (on && !was) requestTest(layer); // preview toast the moment it's switched on
      }
      relayConfig();
      schedulePolling();
    }
    // Login/logout lands as token changes in storage (background.js owns these);
    // runtime broadcasts don't reach content scripts, so this is how we notice.
    if ("wopsRefreshToken" in ch || "wopsAccessToken" in ch) refreshAuth();
  });
})();
