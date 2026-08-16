// Popup toggle -> chrome.storage.local.wdlEnabled (the overlay watches this key).
const toggle = document.getElementById("toggle");

chrome.storage.local.get(["wdlEnabled"], (v) => {
  toggle.checked = v.wdlEnabled !== false;
});

toggle.addEventListener("change", () => {
  chrome.storage.local.set({ wdlEnabled: toggle.checked });
});
