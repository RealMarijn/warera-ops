// Shared framework: on/off state + the toggle button. Loaded before any feature script.
//
// To add a new feature in the future:
//   1. Create extension/yourfeature.js
//   2. Wrap your logic in activate()/deactivate() functions that start/stop everything
//      your feature does (observers, intervals, injected DOM) — deactivate() must undo
//      everything activate() did.
//   3. Call window.WarEraOps.registerFeature({ name: "yourfeature", activate, deactivate })
//   4. Add "yourfeature.js" to the content_scripts "js" array in manifest.json, after common.js.
// The toggle button will then turn your feature on/off automatically, no changes needed here.
(function () {
  const STORAGE_KEY = "warera-ops-enabled";

  const features = [];
  let enabled = true;
  let storageLoaded = false;
  let buttonEl = null;

  function safeActivate(feature) {
    try {
      feature.activate();
    } catch (err) {
      console.error(`[WarEra Ops] failed to activate feature "${feature.name}"`, err);
    }
  }

  function safeDeactivate(feature) {
    try {
      feature.deactivate();
    } catch (err) {
      console.error(`[WarEra Ops] failed to deactivate feature "${feature.name}"`, err);
    }
  }

  function registerFeature(feature) {
    features.push(feature);
    if (storageLoaded && enabled) safeActivate(feature);
  }

  function applyEnabled(next) {
    if (next === enabled) return;
    enabled = next;
    for (const feature of features) {
      if (enabled) safeActivate(feature);
      else safeDeactivate(feature);
    }
    updateButtonState();
  }

  function setEnabled(next) {
    if (next === enabled) return;
    applyEnabled(next);
    browser.storage.local.set({ [STORAGE_KEY]: next });
  }

  function isEnabled() {
    return enabled;
  }

  const POWER_ICON = `<path d="M16.56,5.44L15.11,6.89C16.84,7.94 18,9.83 18,12A6,6 0 0,1 12,18A6,6 0 0,1 6,12C6,9.83 7.16,7.94 8.88,6.88L7.44,5.44C5.36,6.88 4,9.28 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12C20,9.28 18.64,6.88 16.56,5.44M13,3H11V13H13" />`;

  function injectStyles() {
    if (document.getElementById("warera-ops-style")) return;
    const style = document.createElement("style");
    style.id = "warera-ops-style";
    style.textContent = `
      #warera-ops-toggle {
        position: fixed;
        top: 12px;
        left: 12px;
        z-index: 2147483647;
        width: 36px;
        height: 36px;
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        cursor: pointer;
        background: #29323c;
        transition: transform 0.15s ease, color 0.2s ease, opacity 0.2s ease;
      }
      #warera-ops-toggle svg {
        width: 20px;
        height: 20px;
        filter: drop-shadow(black 1px 1px 0px);
      }
      #warera-ops-toggle:hover {
        transform: scale(1.06);
      }
      #warera-ops-toggle:active {
        transform: scale(0.95);
      }
      #warera-ops-toggle.wi-on {
        color: #6ea8ff;
      }
      #warera-ops-toggle.wi-off {
        color: #8b93a1;
        opacity: 0.6;
      }
    `;
    document.head.appendChild(style);
  }

  function createButton() {
    if (buttonEl || !document.body) return;
    buttonEl = document.createElement("button");
    buttonEl.id = "warera-ops-toggle";
    buttonEl.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor">${POWER_ICON}</svg>`;
    buttonEl.addEventListener("click", () => setEnabled(!enabled));
    document.body.appendChild(buttonEl);
    updateButtonState();
  }

  function updateButtonState() {
    if (!buttonEl) return;
    buttonEl.classList.toggle("wi-on", enabled);
    buttonEl.classList.toggle("wi-off", !enabled);
    buttonEl.title = `WarEra Ops: ${enabled ? "ON" : "OFF"} (click to toggle)`;
  }

  injectStyles();
  createButton();

  browser.storage.local.get(STORAGE_KEY).then((res) => {
    enabled = res[STORAGE_KEY] !== false; // default on
    storageLoaded = true;
    updateButtonState();
    if (enabled) {
      for (const feature of features) safeActivate(feature);
    }
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(STORAGE_KEY in changes)) return;
    applyEnabled(changes[STORAGE_KEY].newValue !== false);
  });

  window.WarEraOps = { registerFeature, isEnabled };
})();
