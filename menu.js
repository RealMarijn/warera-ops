// Popup toggles. Each drives one storage key that a content-script subsystem watches:
//   warera-ops-enabled -> the extra-stats features (common.js framework)
//   wdlEnabled         -> the damage-lines overlay (tools/dmg-lines)
const toggles = [
  { el: document.getElementById("toggle-stats"), key: "warera-ops-enabled" },
  { el: document.getElementById("toggle-dmg"), key: "wdlEnabled" },
];

const keys = toggles.map((t) => t.key);
browser.storage.local.get(keys).then((v) => {
  for (const t of toggles) t.el.checked = v[t.key] !== false; // default on
});

for (const t of toggles) {
  t.el.addEventListener("change", () => {
    browser.storage.local.set({ [t.key]: t.el.checked });
  });
}

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
}

function setNote(text, isError) {
  authNoteEl.textContent = text || "";
  authNoteEl.classList.toggle("error", !!isError);
}

async function refreshAuthUI() {
  const status = await browser.runtime.sendMessage({ type: "WARERA_OPS_AUTH_STATUS" });
  renderAuth(status || { loggedIn: false });
}

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
