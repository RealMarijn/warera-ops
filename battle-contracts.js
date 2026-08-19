// Feature: on a battle page, shows next to each side's "contracts" icon (top of the battle view)
// the sum of MONEY and DAMAGE still needed to complete that country's active mercenary contracts.
// One pair per side (defender left, attacker right), styled to look native.
//
// Data: mercenaryContract.getContracts({ countryId, battleId, status:"active", limit }) — one call
// per country. Each active contract carries minimumDamage / currentDamages / moneyPer1kDamages, so:
//   remaining damage = Σ max(0, minimumDamage - currentDamages)
//   remaining money  = Σ remainingDamage_i * moneyPer1kDamages_i / 1000   (the reward not yet earned)
// The country ids come from battle.getById (attacker.country / defender.country).
//
// NOTE on auth: unlike the other stat features, getContracts is NOT public — it 401s without the
// game's warera.io session cookie. So this feature can't go through background.js/callApi (which
// sends no cookies); it fetches directly from the content script with credentials:"include", which
// carries the .warera.io cookie (the extension has host_permissions for the api hosts). battle.getById
// is public, but we fetch it the same way for simplicity.
//
// Rendering trick (per the project's tile-cloning approach): we don't hardcode any styling — we
// clone the real contracts pill (icon + value) already on the page and just repoint its <path> at
// the money/damage glyph and its value span at our number, so it inherits the game's current theme.
(function () {
  const MARKER = "data-warera-ops-contract";
  const API_HOSTS = ["api2", "api3", "api4", "api5", "api6"];
  const REFRESH_MS = 45000; // contracts drain as damage is dealt — refresh periodically

  // Stable mdi glyphs read off the live battle view (all viewBox "0 0 24 24").
  const CONTRACT_GLYPH = "M19.7 12.9L14 18.6"; // the contracts pill's icon — our anchor
  const BOUNTY_GLYPH = "M12,8A4,4 0 0,1 16,12"; // bounty target; shares the header cluster (scoping)
  // Exact WarEra tints. Money has one consistent colour game-wide (#ddd79e, soft
  // gold). Damage has no single game colour (it's team/context-coloured), so we
  // use the game's salmon damage tint, the closest thing to a "damage red".
  const MONEY_COLOR = "#ddd79e";
  const DMG_COLOR = "#e29596";
  const MONEY_GLYPH =
    "M12 5C7.031 5 2 6.546 2 9.5S7.031 14 12 14c4.97 0 10-1.546 10-4.5S16.97 5 12 5zm-5 9.938v3c1.237.299 2.605.482 4 .541v-3a21.166 21.166 0 0 1-4-.541zm6 .54v3a20.994 20.994 0 0 0 4-.541v-3a20.994 20.994 0 0 1-4 .541zm6-1.181v3c1.801-.755 3-1.857 3-3.297v-3c0 1.44-1.199 2.542-3 3.297zm-14 3v-3C3.2 13.542 2 12.439 2 11v3c0 1.439 1.2 2.542 3 3.297z";
  const DMG_GLYPH =
    "M6.23316 8.59556C6.30214 8.03946 6.39735 6.92211 7.65403 5.34032C9.25423 3.32614 12.9443 1.00678 16.1654 1C8.5369 2.58693 13.5375 16.0826 18.3726 11.8508C19.221 11.0641 17.269 8.59556 17.269 8.59556C18.5037 9.19236 19.9038 9.62639 20.5798 10.7657C21.3109 12.5697 20.5867 15.0993 18.3726 18.3613C19.8004 17.7441 21.2143 17.1202 21.6834 16.1911C22.042 19.0259 22.3041 21.7996 19.4762 22.7016C18.952 22.8169 18.3519 22.9118 17.7036 23C18.2554 21.1215 15.4412 19.4328 16.7862 16.1911C15.8757 16.815 14.6618 16.7133 14.4894 19.0734C13.7858 16.8829 12.8133 14.7466 9.93707 12.9359C10.2613 15.2552 11.0545 18.3748 9.11628 19.4464C7.84716 20.1517 5.79862 18.3613 5.12958 17.6831C5.30891 19.8397 6.36421 21.5758 8.14375 22.7626C5.63998 22.2133 3.59835 21.1893 2.9224 19.4464C1.5912 17.188 1.81882 12.9359 4.02599 10.7657C6.23316 18.8089 7.75059 12.2713 6.23316 8.59556Z";

  function isBattlePage() {
    return /\/battle\/[a-fA-F0-9]{24}/.test(location.pathname);
  }
  function extractBattleId() {
    const m = location.pathname.match(/\/battle\/([a-fA-F0-9]{24})/);
    return m ? m[1] : null;
  }

  // ── data ────────────────────────────────────────────────────────────────
  async function wareraFetch(endpoint, params, credentialed) {
    let lastErr;
    for (const host of API_HOSTS) {
      try {
        const res = await fetch(`https://${host}.warera.io/trpc/${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: credentialed ? "include" : "omit",
          body: JSON.stringify(params),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`);
        const j = await res.json();
        return j?.result?.data ?? j;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error("all hosts failed");
  }

  async function fetchCountries(battleId) {
    const b = await wareraFetch("battle.getById", { battleId }, false);
    return { attacker: b?.attacker?.country || null, defender: b?.defender?.country || null };
  }

  async function fetchContracts(countryId, battleId) {
    if (!countryId) return [];
    const d = await wareraFetch(
      "mercenaryContract.getContracts",
      { countryId, battleId, status: "active", limit: 50 },
      true // credentialed — this endpoint needs the session cookie
    );
    return Array.isArray(d?.items) ? d.items : [];
  }

  function computeSums(items) {
    let money = 0;
    let damage = 0;
    let n = 0;
    for (const c of items) {
      if (c.status !== "active") continue;
      n++;
      const remD = Math.max(0, (c.minimumDamage || 0) - (c.currentDamages || 0));
      damage += remD;
      money += (remD * (c.moneyPer1kDamages || 0)) / 1000;
    }
    return { n, money, damage };
  }

  // battleId -> { status, fetchedAt, reloading, sums: { attacker, defender } }
  const cache = new Map();

  function getBattleData(battleId) {
    let e = cache.get(battleId);
    if (!e) {
      e = { status: "loading", fetchedAt: 0, reloading: false, sums: { attacker: null, defender: null } };
      cache.set(battleId, e);
      load(battleId, e);
    } else if (e.status !== "loading" && !e.reloading && Date.now() - e.fetchedAt > REFRESH_MS) {
      load(battleId, e); // stale — refresh in the background, keep showing current numbers
    }
    return e;
  }

  async function load(battleId, e) {
    e.reloading = true;
    try {
      const { attacker, defender } = await fetchCountries(battleId);
      const [ai, di] = await Promise.all([
        fetchContracts(attacker, battleId).catch(() => []),
        fetchContracts(defender, battleId).catch(() => []),
      ]);
      e.sums.attacker = computeSums(ai);
      e.sums.defender = computeSums(di);
      e.status = "done";
    } catch (err) {
      console.error("[WarEra Ops] contracts load failed", err);
      e.status = "error";
    } finally {
      e.fetchedAt = Date.now();
      e.reloading = false;
      scheduleSync();
    }
  }

  // ── formatting ───────────────────────────────────────────────────────────
  function formatCompact(value) {
    const abs = Math.abs(value);
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}M`;
    if (abs >= 1_000) return `${(value / 1_000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}K`;
    return `${Math.round(value)}`;
  }

  // ── DOM ──────────────────────────────────────────────────────────────────
  // The two header side-clusters, each holding a bounty pill + a contracts pill.
  function findContractClusters() {
    const found = [];
    const seen = new Set();
    const paths = Array.from(document.querySelectorAll("svg path")).filter((p) =>
      (p.getAttribute("d") || "").startsWith(CONTRACT_GLYPH)
    );
    for (const p of paths) {
      const holder = p.closest(".a6izou0");
      const pill = holder && holder.parentElement;
      if (!pill || !pill.querySelector("span.agd9b40")) continue; // header pill has a count span
      const wrapper = pill.parentElement;
      const cluster = wrapper && wrapper.parentElement;
      if (!cluster || seen.has(wrapper)) continue;
      // Scope to the header: the same cluster also holds the bounty (target) icon.
      const hasBounty = Array.from(cluster.querySelectorAll("svg path")).some((q) =>
        (q.getAttribute("d") || "").startsWith(BOUNTY_GLYPH)
      );
      if (!hasBounty) continue;
      seen.add(wrapper);
      found.push({ wrapper, cluster, x: pill.getBoundingClientRect().left });
    }
    found.sort((a, b) => a.x - b.x); // left = defender, right = attacker
    return found;
  }

  function setValueNode(cluster, wrapper, kind, glyph, color, text) {
    let node = cluster.querySelector(`[${MARKER}="${kind}"]`);
    if (!node) {
      node = wrapper.cloneNode(true); // inherit the contracts pill's exact styling
      node.setAttribute(MARKER, kind);
      node.querySelectorAll(`[${MARKER}]`).forEach((n) => n.removeAttribute(MARKER)); // clean nested markers
      const path = node.querySelector("svg path");
      if (path) {
        path.setAttribute("d", glyph);
        path.setAttribute("fill", color); // colour the icon (game-like: money yellow, damage red)
        path.removeAttribute("data-warera-ops-contract");
      }
      const span = node.querySelector("span.agd9b40");
      if (span) span.style.color = color; // and the value text, overriding the count class
    }
    const span = node.querySelector("span.agd9b40");
    if (span) span.textContent = text;
    return node;
  }

  function clearCluster(cluster) {
    cluster.querySelectorAll(`[${MARKER}]`).forEach((n) => n.remove());
  }

  function renderCluster(item, sums) {
    const { wrapper, cluster } = item;
    // No contracts on this side → show nothing (keep the header clean).
    if (sums && sums.n === 0) {
      clearCluster(cluster);
      return;
    }
    const moneyText = sums ? formatCompact(sums.money) : "…";
    const dmgText = sums ? formatCompact(sums.damage) : "…";
    const moneyNode = setValueNode(cluster, wrapper, "money", MONEY_GLYPH, MONEY_COLOR, moneyText);
    const dmgNode = setValueNode(cluster, wrapper, "dmg", DMG_GLYPH, DMG_COLOR, dmgText);
    // Order: [contracts] [money] [damage], to the right of the contracts icon.
    if (moneyNode.previousElementSibling !== wrapper) cluster.insertBefore(moneyNode, wrapper.nextSibling);
    if (dmgNode.previousElementSibling !== moneyNode) cluster.insertBefore(dmgNode, moneyNode.nextSibling);
  }

  function sync() {
    if (!active || !window.WarEraOps.isEnabled()) return;
    // Per-feature toggle (popup "Open contracts"). Separate from the global
    // extra-stats switch — off means remove everything and stop.
    if (!featureEnabled || !isBattlePage()) {
      document.querySelectorAll(`[${MARKER}]`).forEach((el) => el.remove());
      return;
    }
    const battleId = extractBattleId();
    if (!battleId) return;
    const clusters = findContractClusters();
    if (clusters.length === 0) return;

    const data = getBattleData(battleId);
    if (data.status === "error") {
      // Show a dash so a broken/permission-denied fetch is visible rather than silent.
      for (const item of clusters) renderCluster(item, { n: 1, money: NaN, damage: NaN });
      // formatCompact(NaN) -> "NaN"; replace with "—"
      document.querySelectorAll(`[${MARKER}] span.agd9b40`).forEach((s) => {
        if (s.textContent === "NaN") s.textContent = "—";
      });
      return;
    }

    // clusters[0] = defender (left), clusters[1] = attacker (right).
    const bySide = [
      { item: clusters[0], sums: data.status === "done" ? data.sums.defender : null },
      { item: clusters[1], sums: data.status === "done" ? data.sums.attacker : null },
    ];
    for (const { item, sums } of bySide) {
      if (item) renderCluster(item, sums);
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  let active = false;
  let observer = null;
  let pollInterval = null;
  let refreshInterval = null;
  let lastPath = null;
  let lastBattleId = null;
  let scheduled = false;
  let featureEnabled = true; // popup key "openContractsEnabled" (default on)
  let storageListener = null;

  const FEATURE_KEY = "openContractsEnabled";

  function scheduleSync() {
    if (!active || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      sync();
    });
  }

  function activate() {
    active = true;

    // Watch the per-feature toggle independently of the global extra-stats switch.
    storageListener = (changes, area) => {
      if (area !== "local" || !(FEATURE_KEY in changes)) return;
      featureEnabled = changes[FEATURE_KEY].newValue !== false;
      scheduleSync();
    };
    browser.storage.onChanged.addListener(storageListener);
    browser.storage.local.get(FEATURE_KEY).then((v) => {
      featureEnabled = v[FEATURE_KEY] !== false; // default on
      scheduleSync();
    });

    observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, { childList: true, subtree: true });

    lastPath = location.pathname;
    lastBattleId = extractBattleId();
    pollInterval = setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        const battleId = extractBattleId();
        if (battleId !== lastBattleId) {
          lastBattleId = battleId;
          cache.clear();
        }
        document.querySelectorAll(`[${MARKER}]`).forEach((el) => el.remove());
        scheduleSync();
      }
    }, 800);

    // Nudge a re-sync so stale battle data (see getBattleData) refreshes even when the
    // DOM is quiet and the observer isn't firing.
    refreshInterval = setInterval(scheduleSync, REFRESH_MS);

    scheduleSync();
  }

  function deactivate() {
    active = false;
    if (storageListener) browser.storage.onChanged.removeListener(storageListener);
    storageListener = null;
    if (observer) observer.disconnect();
    observer = null;
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = null;
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = null;
    document.querySelectorAll(`[${MARKER}]`).forEach((el) => el.remove());
  }

  window.WarEraOps.registerFeature({ name: "battleContracts", activate, deactivate });
})();
