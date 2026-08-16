// Popup toggles. Each drives one storage key that a content-script subsystem watches:
//   warera-ops-enabled -> the extra-stats features (common.js framework)
//   wdlEnabled         -> the damage-lines overlay (tools/dmg-lines)
const toggles = [
  { el: document.getElementById("toggle-stats"), key: "warera-ops-enabled" },
  { el: document.getElementById("toggle-dmg"), key: "wdlEnabled" },
];

const keys = toggles.map((t) => t.key);
chrome.storage.local.get(keys, (v) => {
  for (const t of toggles) t.el.checked = v[t.key] !== false; // default on
});

for (const t of toggles) {
  t.el.addEventListener("change", () => {
    chrome.storage.local.set({ [t.key]: t.el.checked });
  });
}
