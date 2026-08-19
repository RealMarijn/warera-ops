// Popup toggles. Each drives one storage key that a content-script subsystem watches:

//   warera-ops-enabled    -> the extra-stats features (common.js framework)
//   wdlEnabled            -> the damage-lines overlay (tools/dmg-lines)
//   coreColorsEnabled     -> the core-country-colors map mode (tools/dmg-lines/map.js)
const toggles = [
  { el: document.getElementById("toggle-stats"), key: "warera-ops-enabled", defaultOn: true },
  { el: document.getElementById("toggle-dmg"), key: "wdlEnabled", defaultOn: true },
  // Off by default — a bigger visual change to the map than the others, opt-in.
  { el: document.getElementById("toggle-core-colors"), key: "coreColorsEnabled", defaultOn: false },
  { el: document.getElementById("toggle-sr"), key: "srMapEnabled", defaultOn: false },
  { el: document.getElementById("toggle-bases"), key: "showBasesEnabled", defaultOn: false },
  { el: document.getElementById("toggle-bunkers"), key: "showBunkersEnabled", defaultOn: false },
];

const keys = toggles.map((t) => t.key);
browser.storage.local.get(keys).then((v) => {
  for (const t of toggles) {
    t.el.checked = t.key in v ? v[t.key] === true : t.defaultOn;
  }
  updateMapCount();
});

for (const t of toggles) {
  t.el.addEventListener("change", () => {
    browser.storage.local.set({ [t.key]: t.el.checked });
  });
}

// ── "Map features" collapsible group ──────────────────────────────────────
// Strategic resources, core-country-colors, bases and bunkers all live under
// a single expandable section. The header shows how many of them are on so
// the state is visible while the group is collapsed (its default).
const mapFeatureKeys = ["srMapEnabled", "coreColorsEnabled", "showBasesEnabled", "showBunkersEnabled"];
const mapFeatureEls = mapFeatureKeys
  .map((key) => toggles.find((t) => t.key === key)?.el)
  .filter(Boolean);
const mapBtn = document.getElementById("map-features-btn");
const mapSubmenu = document.getElementById("map-submenu");
const mapCountEl = document.getElementById("map-count");

// Bases/bunkers pull from the whitelist-gated backend, so their menu rows only
// exist for logged-in (approved) users. Hidden until auth resolves, and not
// counted in the "N on" pill while hidden.
const authGatedEls = new Set(
  ["showBasesEnabled", "showBunkersEnabled"].map((k) => toggles.find((t) => t.key === k)?.el).filter(Boolean),
);
const authGatedRows = [document.getElementById("row-bases"), document.getElementById("row-bunkers")].filter(Boolean);
let authGated = true; // assume not-approved until WARERA_OPS_AUTH_STATUS says otherwise

function applyAuthGate(loggedIn) {
  authGated = !loggedIn;
  for (const row of authGatedRows) row.hidden = authGated;
  updateMapCount();
}

function updateMapCount() {
  if (!mapCountEl) return;
  const n = mapFeatureEls.filter((el) => el.checked && !(authGated && authGatedEls.has(el))).length;
  mapCountEl.textContent = `${n} on`;
  mapCountEl.hidden = n === 0;
}

if (mapBtn && mapSubmenu) {
  mapBtn.addEventListener("click", () => {
    const open = mapSubmenu.classList.toggle("open");
    mapBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });
}
for (const el of mapFeatureEls) el.addEventListener("change", updateMapCount);

// ── Discord login (whitelist-gated access to our backend) ─────────────────
// All the actual auth logic (pairing, token storage, refresh) lives in
// background.js — this is just a thin status display + two buttons.
const authStatusEl = document.getElementById("auth-status");
const authNameEl = document.getElementById("auth-name");
const authBtn = document.getElementById("auth-btn");
const authNoteEl = document.getElementById("auth-note");

let authBusy = false;

function renderAuth(status) {
  authStatusEl.classList.toggle("on", !!status.loggedIn);
  if (status.loggedIn) {
    authNameEl.textContent = status.username ? `Logged in as ${status.username}` : "Logged in";
    authBtn.textContent = "Logout";
    authBtn.dataset.act = "logout";
  } else {
    authNameEl.textContent = "Not logged in";
    authBtn.textContent = "Login with Discord";
    authBtn.dataset.act = "login";
  }
  authBtn.disabled = authBusy;
  applyAuthGate(!!status.loggedIn); // hide bases/bunkers rows unless approved
}

function setNote(text, isError) {
  authNoteEl.textContent = text || "";
  authNoteEl.classList.toggle("error", !!isError);
}

async function refreshAuthUI() {
  const status = await browser.runtime.sendMessage({ type: "WARERA_OPS_AUTH_STATUS" });
  renderAuth(status || { loggedIn: false });
  connRowEl.hidden = !status?.loggedIn;
  if (status?.loggedIn) checkConnection();
}

// ── Server connection check ────────────────────────────────────────────────
// Being logged in only proves we once had a valid token — it says nothing
// about whether the backend is actually reachable *right now*, or whether a
// since-revoked/de-whitelisted token would still be accepted. /api/ext/whoami
// is cheap and requires a live, whitelist-checked bearer token, so a
// successful call is real evidence of a working connection, not just cached
// local state. Only shown (and only polled) while logged in — a non-
// whitelisted user can never reach this state in the first place.
const connRowEl = document.getElementById("conn-row");
const connStatusEl = document.getElementById("conn-status");
const connNameEl = document.getElementById("conn-name");

let connCheckBusy = false;

async function checkConnection() {
  if (connCheckBusy) return;
  connCheckBusy = true;
  try {
    await browser.runtime.sendMessage({
      type: "WARERA_OPS_AUTHED_FETCH",
      path: "/api/ext/whoami",
      method: "GET",
    });
    connStatusEl.classList.add("on");
    connNameEl.textContent = "Connected to server";
  } catch (err) {
    connStatusEl.classList.remove("on");
    connNameEl.textContent = "Can't reach server";
  } finally {
    connCheckBusy = false;
  }
}

// Popup documents are torn down (and this interval with them) as soon as the
// popup closes, so there's nothing to clear it explicitly.
setInterval(() => {
  if (!connRowEl.hidden) checkConnection();
}, 4000);

const DENY_REASONS = {
  not_whitelisted: "That Discord account isn't on the WarEra Ops whitelist.",
  expired: "Login link expired — try again.",
  timeout: "Login timed out — try again.",
  start_failed: "Couldn't reach the backend — try again.",
  tab_open_failed: "Couldn't open the Discord login tab — try again.",
  error: "Something went wrong — try again.",
};

authBtn.addEventListener("click", async () => {
  const act = authBtn.dataset.act;
  authBusy = true;
  authBtn.disabled = true;
  setNote("");

  try {
    if (act === "logout") {
      await browser.runtime.sendMessage({ type: "WARERA_OPS_AUTH_LOGOUT" });
      return;
    }

    authNameEl.textContent = "Opening Discord login…";
    setNote("A tab should open in a moment — complete the login there.");
    const result = await browser.runtime.sendMessage({ type: "WARERA_OPS_AUTH_LOGIN" });
    if (!result?.ok) {
      setNote(DENY_REASONS[result?.reason] || "Login failed — try again.", true);
    } else {
      setNote("");
    }
  } catch (err) {
    // e.g. the message channel died (service worker got killed mid-request) —
    // without this, the button would stay stuck on "Waiting..." forever with
    // no feedback at all.
    console.error("[WarEra Ops] auth action failed:", err);
    setNote("Something went wrong — try again.", true);
  } finally {
    authBusy = false;
    await refreshAuthUI();
  }
});

// Live-update while the popup is open during login (background.js broadcasts
// this after a successful pairing/refresh/logout).
browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "WARERA_OPS_AUTH_CHANGED") refreshAuthUI();
});

refreshAuthUI();
