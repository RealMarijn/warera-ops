// Popup toggles. Each drives one storage key that a content-script subsystem watches:
//   warera-ops-enabled -> the extra-stats features (common.js framework)   [default on]
//   wdlEnabled         -> the damage-lines overlay (tools/dmg-lines)        [default on]
//   srMapEnabled       -> the strategic-resources map overlay (tools/sr-map) [default off]
const toggles = [
  { el: document.getElementById("toggle-stats"), key: "warera-ops-enabled", defaultOn: true },
  { el: document.getElementById("toggle-dmg"), key: "wdlEnabled", defaultOn: true },
  { el: document.getElementById("toggle-sr"), key: "srMapEnabled", defaultOn: false },
];

const keys = toggles.map((t) => t.key);
chrome.storage.local.get(keys, (v) => {
  for (const t of toggles) {
    t.el.checked = t.defaultOn ? v[t.key] !== false : v[t.key] === true;
  }
});

for (const t of toggles) {
  t.el.addEventListener("change", () => {
    chrome.storage.local.set({ [t.key]: t.el.checked });
  });
}
