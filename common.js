// Shared framework: on/off state for all features. Loaded before any feature script.
//
// The on/off switch lives in the browser-action popup (menu.html/menu.js), which writes the
// `warera-ops-enabled` key in storage. This framework watches that key and activates/deactivates
// every registered feature accordingly — there is no on-screen button.
//
// To add a new feature in the future:
//   1. Create extension/yourfeature.js
//   2. Wrap your logic in activate()/deactivate() functions that start/stop everything
//      your feature does (observers, intervals, injected DOM) — deactivate() must undo
//      everything activate() did.
//   3. Call window.WarEraOps.registerFeature({ name: "yourfeature", activate, deactivate })
//   4. Add "yourfeature.js" to the content_scripts "js" array in manifest.json, after common.js.
// The popup toggle will then turn your feature on/off automatically, no changes needed here.
(function () {
  const STORAGE_KEY = "warera-ops-enabled";

  const features = [];
  let enabled = true;
  let storageLoaded = false;

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
  }

  function isEnabled() {
    return enabled;
  }

  browser.storage.local.get(STORAGE_KEY).then((res) => {
    enabled = res[STORAGE_KEY] !== false; // default on
    storageLoaded = true;
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
