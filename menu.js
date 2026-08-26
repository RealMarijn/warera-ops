// Popup toggles. Each drives one storage key that a content-script subsystem watches:

//   warera-ops-enabled    -> the extra-stats features (common.js framework)
//   wdlEnabled            -> the damage-lines overlay (tools/dmg-lines)
//   wdlCountryEnabled     -> the "Country damage" card (tools/dmg-lines), independent of wdlEnabled
//   coreColorsEnabled     -> the core-country-colors map mode (tools/dmg-lines/map.js)
//   regionStatusEnabled   -> the capitals/unlinked-regions overlay (tools/dmg-lines/map.js) —
//                            mutually exclusive with coreColorsEnabled, see MUTUALLY_EXCLUSIVE below
//   warPriorityEnabled    -> the war-priority arrow overlay (tools/dmg-lines/map.js)
//   showProxyEnabled      -> the proxy-country overlay (tools/dmg-lines), whitelist-gated
//   battleBonusEnabled    -> the per-side damage-bonus breakdown on battle pages (battle-bonus.js)
//   inventoryExportEnabled       -> the "Export JSON" button on the inventory page (inventory-export.js)
//   accountInventoryValueEnabled -> total inventory value on country/MU account pages (account-inventory-value.js)
const toggles = [
  { el: document.getElementById("toggle-stats"), key: "warera-ops-enabled", defaultOn: true },
  { el: document.getElementById("toggle-dmg"), key: "wdlEnabled", defaultOn: true },
  { el: document.getElementById("toggle-country-dmg"), key: "wdlCountryEnabled", defaultOn: true },
  // Off by default — a bigger visual change to the map than the others, opt-in.
  { el: document.getElementById("toggle-core-colors"), key: "coreColorsEnabled", defaultOn: false },
  // Off by default, same reasoning — also mutually exclusive with coreColorsEnabled above (see
  // MUTUALLY_EXCLUSIVE below), so only one of the two region-fill overlays is ever on at once.
  { el: document.getElementById("toggle-region-status"), key: "regionStatusEnabled", defaultOn: false },
  // Off by default — scanning every country's war list is the heaviest of these toggles, opt-in.
  { el: document.getElementById("toggle-war-priority"), key: "warPriorityEnabled", defaultOn: false },
  { el: document.getElementById("toggle-sr"), key: "srMapEnabled", defaultOn: false },
  { el: document.getElementById("toggle-bases"), key: "showBasesEnabled", defaultOn: false },
  { el: document.getElementById("toggle-bunkers"), key: "showBunkersEnabled", defaultOn: false },
  { el: document.getElementById("toggle-resistance"), key: "showResistanceEnabled", defaultOn: false },
  { el: document.getElementById("toggle-proxy"), key: "showProxyEnabled", defaultOn: true },
  // Battle-view stat features (watched by their own feature scripts, e.g. battle-contracts.js).
  { el: document.getElementById("toggle-open-contracts"), key: "openContractsEnabled", defaultOn: true },
  { el: document.getElementById("toggle-battle-bonus"), key: "battleBonusEnabled", defaultOn: true },
  // Inventory/account page features (watched by their own feature scripts).
  { el: document.getElementById("toggle-inventory-export"), key: "inventoryExportEnabled", defaultOn: true },
  { el: document.getElementById("toggle-account-value"), key: "accountInventoryValueEnabled", defaultOn: true },
];

const keys = toggles.map((t) => t.key);
browser.storage.local.get(keys).then((v) => {
  for (const t of toggles) {
    t.el.checked = t.key in v ? v[t.key] === true : t.defaultOn;
  }
  updateMapCount();
  updateBattleCount();
  updateInventoryCount();
});

// Core country colors and capitals/unlinked regions both recolor the map's regions — having both
// on at once would be visually confusing, so checking one here turns the other off (map.js also
// enforces this independently, but doing it here too keeps the popup's checkboxes/storage honest).
const MUTUALLY_EXCLUSIVE = { coreColorsEnabled: "regionStatusEnabled", regionStatusEnabled: "coreColorsEnabled" };

for (const t of toggles) {
  t.el.addEventListener("change", () => {
    const updates = { [t.key]: t.el.checked };
    const partnerKey = MUTUALLY_EXCLUSIVE[t.key];
    if (t.el.checked && partnerKey) {
      const partner = toggles.find((x) => x.key === partnerKey);
      if (partner && partner.el.checked) {
        partner.el.checked = false;
        updates[partnerKey] = false;
        // Setting .checked in JS doesn't fire the partner's own "change" listener (which is what
        // normally keeps the "N on" map-features badge in sync) — refresh it here instead.
        updateMapCount();
      }
    }
    browser.storage.local.set(updates);
  });
}

// ── "Map features" collapsible group ──────────────────────────────────────
// Strategic resources, core-country-colors, bases and bunkers all live under
// a single expandable section. The header shows how many of them are on so
// the state is visible while the group is collapsed (its default).
const mapFeatureKeys = [
  "srMapEnabled", "coreColorsEnabled", "regionStatusEnabled", "warPriorityEnabled", "showBasesEnabled",
  "showBunkersEnabled", "showResistanceEnabled", "showProxyEnabled",
];
const mapFeatureEls = mapFeatureKeys
  .map((key) => toggles.find((t) => t.key === key)?.el)
  .filter(Boolean);
const mapBtn = document.getElementById("map-features-btn");
const mapSubmenu = document.getElementById("map-submenu");
const mapCountEl = document.getElementById("map-count");

// Bases/bunkers/resistance/proxy/damage-bonuses all pull from the whitelist-gated backend
// (every /api/ext/... endpoint requires it, no exceptions — see BACKEND_API.md), so their menu
// rows only exist for logged-in (approved) users. Hidden until auth resolves, and not counted in
// the "N on" pill while hidden.
const authGatedEls = new Set(
  ["showBasesEnabled", "showBunkersEnabled", "showResistanceEnabled", "showProxyEnabled", "battleBonusEnabled"]
    .map((k) => toggles.find((t) => t.key === k)?.el).filter(Boolean),
);
const authGatedRows = [
  document.getElementById("row-bases"),
  document.getElementById("row-bunkers"),
  document.getElementById("row-resistance"),
  document.getElementById("row-proxy"),
  document.getElementById("row-battle-bonus"),
].filter(Boolean);
let authGated = true; // assume not-approved until WARERA_OPS_AUTH_STATUS says otherwise

function applyAuthGate(loggedIn) {
  authGated = !loggedIn;
  for (const row of authGatedRows) row.hidden = authGated;
  updateMapCount();
  updateBattleCount();
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

// ── "Battle features" collapsible group ───────────────────────────────────
// Same accordion pattern as the map group, for stat features injected into the
// battle view (currently just Open contracts).
const battleFeatureKeys = ["openContractsEnabled", "battleBonusEnabled"];
const battleFeatureEls = battleFeatureKeys
  .map((key) => toggles.find((t) => t.key === key)?.el)
  .filter(Boolean);
const battleBtn = document.getElementById("battle-features-btn");
const battleSubmenu = document.getElementById("battle-submenu");
const battleCountEl = document.getElementById("battle-count");

function updateBattleCount() {
  if (!battleCountEl) return;
  const n = battleFeatureEls.filter((el) => el.checked && !(authGated && authGatedEls.has(el))).length;
  battleCountEl.textContent = `${n} on`;
  battleCountEl.hidden = n === 0;
}

if (battleBtn && battleSubmenu) {
  battleBtn.addEventListener("click", () => {
    const open = battleSubmenu.classList.toggle("open");
    battleBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });
}
for (const el of battleFeatureEls) el.addEventListener("change", updateBattleCount);

// ── "Inventory" collapsible group ──────────────────────────────────────────
// Same accordion pattern as the map/battle groups, for stat features on
// inventory/account pages.
const inventoryFeatureKeys = ["inventoryExportEnabled", "accountInventoryValueEnabled"];
const inventoryFeatureEls = inventoryFeatureKeys
  .map((key) => toggles.find((t) => t.key === key)?.el)
  .filter(Boolean);
const inventoryBtn = document.getElementById("inventory-features-btn");
const inventorySubmenu = document.getElementById("inventory-submenu");
const inventoryCountEl = document.getElementById("inventory-count");

function updateInventoryCount() {
  if (!inventoryCountEl) return;
  const n = inventoryFeatureEls.filter((el) => el.checked).length;
  inventoryCountEl.textContent = `${n} on`;
  inventoryCountEl.hidden = n === 0;
}

if (inventoryBtn && inventorySubmenu) {
  inventoryBtn.addEventListener("click", () => {
    const open = inventorySubmenu.classList.toggle("open");
    inventoryBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });
}
for (const el of inventoryFeatureEls) el.addEventListener("change", updateInventoryCount);

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
  not_whitelisted: "That Discord account isn't on the WarEra Ops whitelist. To request access, message RealMarijn on Discord or in-game.",
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
