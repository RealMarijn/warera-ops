// Chrome's service_worker field only accepts a single file (no array), unlike content_scripts —
// so this can't share browser-polyfill.js the way the content scripts do; inlined instead.
if (typeof browser === "undefined" && typeof chrome !== "undefined") {
  globalThis.browser = chrome;
}

// api2 is primary; the rest are fallbacks observed in WarEra's own bundle in case one host is down/rate-limited.
const API_HOSTS = ["api2", "api3", "api4", "api5", "api6"].map(
  (h) => `https://${h}.warera.io/trpc`
);

async function callApi(endpoint, params) {
  let lastError;
  for (const base of API_HOSTS) {
    try {
      const res = await fetch(`${base}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}`);
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("All API hosts failed");
}

// Generic passthrough so any feature can call any tRPC endpoint without background.js
// needing a dedicated function per endpoint.
browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "WARERA_OPS_FETCH") {
    return callApi(message.endpoint, message.params);
  }
  if (message?.type === "WARERA_OPS_AUTHED_FETCH") {
    return authedFetch(message.path, { method: message.method, body: message.body });
  }
  if (message?.type === "WARERA_OPS_AUTH_STATUS") {
    return getAuthStatus();
  }
  if (message?.type === "WARERA_OPS_AUTH_LOGIN") {
    return startLogin();
  }
  if (message?.type === "WARERA_OPS_AUTH_LOGOUT") {
    return logout().then(() => ({ ok: true }));
  }
  return undefined;
});

// ── Discord-login + token system (whitelist-gated access to our own backend) ──
//
// This background script owns the whole client-side auth lifecycle: pairing
// (see rijksoverheid_web/app/routers/extension_auth.py for the server side),
// token storage, and lazy refresh-on-demand. Content scripts and the popup
// never see a raw token — they go through the message types above.
//
// Storage keys (chrome.storage.local, so this is per-browser-profile — not
// synced — meaning each browser install needs its own one-time login, which
// is the point: sync would silently propagate a session to every device
// signed into the same account).
const BACKEND = "https://warera.realmarijn.nl";
const PAIR_POLL_INTERVAL_MS = 1500;
const PAIR_TIMEOUT_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000; // refresh this long before actual expiry

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getStoredAuth() {
  const v = await browser.storage.local.get([
    "wopsAccessToken", "wopsAccessExp", "wopsRefreshToken", "wopsUser",
  ]);
  return {
    accessToken: v.wopsAccessToken || null,
    accessExp: v.wopsAccessExp || 0,
    refreshToken: v.wopsRefreshToken || null,
    user: v.wopsUser || null,
  };
}

async function storeAuth({ access_token, access_expires_in, refresh_token, user }) {
  const current = await getStoredAuth();
  await browser.storage.local.set({
    wopsAccessToken: access_token,
    wopsAccessExp: Date.now() + access_expires_in * 1000,
    wopsRefreshToken: refresh_token,
    wopsUser: user || current.user || null,
  });
}

async function clearStoredAuth() {
  await browser.storage.local.remove([
    "wopsAccessToken", "wopsAccessExp", "wopsRefreshToken", "wopsUser",
  ]);
}

// Best-effort broadcast so an open popup can update live during/after login.
// Rejects with "Could not establish connection" when nothing is listening
// (e.g. popup closed) — that's expected, not an error.
function broadcastAuthChanged() {
  browser.runtime.sendMessage({ type: "WARERA_OPS_AUTH_CHANGED" }).catch(() => {});
}

// Serializes concurrent refresh attempts — see getValidAccessToken's comment below for why this
// exists. null whenever no refresh is currently in progress.
let refreshInFlight = null;

// Returns a live access token, refreshing it first if it's missing/near-expiry.
// Refresh tokens rotate on every use (see extension_tokens.py) — a session that
// was revoked server-side (logged out elsewhere, de-whitelisted, or a shared
// token got caught by reuse detection) surfaces here as a failed refresh, which
// clears local state so the UI falls back to "logged out" instead of retrying
// forever with a dead token.
//
// This is routinely called from several content scripts/pollers around the same
// moment (proxy poll, bases/bunkers poll, the popup's connection check, ...).
// Without de-duplication, each would independently fire its own
// /api/ext/auth/refresh using the SAME (not-yet-rotated) refresh token —
// extension_auth.py's rotate_extension_session only lets the FIRST of those
// succeed, and by design (reuse detection) treats every other concurrent use of
// that same token as a red flag. The losing caller's request would then fail
// here and wipe out the auth the winning caller had just stored moments earlier
// — an entirely self-inflicted logout that reportedly happened roughly daily
// (enough pollers, run for long enough, eventually collide). Funneling every
// call through one shared in-flight promise means only one refresh HTTP
// request is ever made per service-worker lifetime, so this race can no longer
// happen client-side — legitimate server-side reuse detection (e.g. a token
// actually shared across two separate browser profiles) is unaffected.
async function getValidAccessToken() {
  const auth = await getStoredAuth();
  if (!auth.refreshToken) return null;
  if (auth.accessToken && auth.accessExp - ACCESS_TOKEN_REFRESH_SKEW_MS > Date.now()) {
    return auth.accessToken;
  }
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${BACKEND}/api/ext/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: auth.refreshToken }),
      });
      if (!res.ok) throw new Error(`refresh failed: HTTP ${res.status}`);
      const data = await res.json();
      await storeAuth({ ...data, user: auth.user });
      broadcastAuthChanged();
      return data.access_token;
    } catch (err) {
      console.warn("[WarEra Ops] token refresh failed, logging out locally:", err);
      await clearStoredAuth();
      broadcastAuthChanged();
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function getAuthStatus() {
  const token = await getValidAccessToken();
  if (!token) return { loggedIn: false };
  const auth = await getStoredAuth();
  return { loggedIn: true, username: auth.user?.username || null };
}

// Protected-backend passthrough for content scripts/popup, mirroring callApi()'s
// role for the public WarEra API above — but authenticated and whitelist-gated.
async function authedFetch(path, { method = "GET", body } = {}) {
  const token = await getValidAccessToken();
  if (!token) {
    const err = new Error("not_logged_in");
    err.code = "not_logged_in";
    throw err;
  }
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
  return res.json();
}

// Kicks off the pairing handshake: opens a real Discord-login tab, then polls
// our backend until that tab's login completes (approved/denied) or times out.
// See extension_pairing.py for why this is poll-based rather than push-based —
// it's the one approach that needs no browser-specific identity API and no
// extension-ID coupling, so it behaves identically on Chrome and Firefox.
async function startLogin() {
  // Everything in here used to be able to throw (a bad tabs.create call, a
  // network error on the initial fetch, ...) with nothing catching it — that
  // rejects the message-response promise, which the popup's `await
  // sendMessage(...)` doesn't catch either, so the UI was left stuck showing
  // "waiting for the tab" forever with no tab and no error. Catch everything
  // here and always resolve to a {ok, reason} the popup can actually render.
  try {
    const startRes = await fetch(`${BACKEND}/api/ext/pair/start`, { method: "POST" });
    if (!startRes.ok) return { ok: false, reason: "start_failed" };
    const { pairing_code: code, login_url } = await startRes.json();

    try {
      await browser.tabs.create({ url: login_url });
    } catch (err) {
      console.error("[WarEra Ops] tabs.create failed:", err);
      return { ok: false, reason: "tab_open_failed" };
    }

    return await pollAfterTabOpen(code);
  } catch (err) {
    console.error("[WarEra Ops] startLogin failed:", err);
    return { ok: false, reason: "error" };
  }
}

async function pollAfterTabOpen(code) {
  const deadline = Date.now() + PAIR_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(PAIR_POLL_INTERVAL_MS);
    let data;
    try {
      const r = await fetch(`${BACKEND}/api/ext/pair/poll?code=${encodeURIComponent(code)}`);
      data = await r.json();
    } catch (_) {
      continue; // transient network hiccup — keep polling until the deadline
    }
    if (data.status === "approved") {
      await storeAuth({
        access_token: data.access_token,
        access_expires_in: data.access_expires_in,
        refresh_token: data.refresh_token,
        user: data.user,
      });
      broadcastAuthChanged();
      return { ok: true, user: data.user };
    }
    if (data.status === "denied") return { ok: false, reason: data.reason || "denied" };
    if (data.status === "expired") return { ok: false, reason: "expired" };
    // "pending" / "claimed" (stray duplicate) -> keep polling
  }
  return { ok: false, reason: "timeout" };
}

async function logout() {
  const auth = await getStoredAuth();
  if (auth.refreshToken) {
    try {
      await fetch(`${BACKEND}/api/ext/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: auth.refreshToken }),
      });
    } catch (_) {
      // best-effort server-side revoke; clearing local state below still logs us out here
    }
  }
  await clearStoredAuth();
  broadcastAuthChanged();
}
