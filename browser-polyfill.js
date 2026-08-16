// Firefox exposes a promise-based `browser` global natively; Chrome only has `chrome`. Since
// MV3, chrome.* already returns promises when the callback is omitted, and it has the same
// method shapes this extension uses (runtime.sendMessage/onMessage, storage.local,
// storage.onChanged) — so aliasing is enough, no full polyfill library needed.
if (typeof browser === "undefined" && typeof chrome !== "undefined") {
  globalThis.browser = chrome;
}
