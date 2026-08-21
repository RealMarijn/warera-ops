// Feature: on a country's or MU's account page, adds a "Total Value" entry in front of the
// money figure in the inventory row, equal to money + (each item's quantity × its current market
// price from itemTrading.getPrices). Both page types render this row with identical markup, so
// one implementation covers both rather than duplicating it. The new entry is a clone of the
// money entry itself (so it inherits the game's real icon-row styling), with the coin icon
// swapped for a sigma glyph so it doesn't read as a duplicate of the adjacent money figure.
(function () {
  const MARKER_ATTR = "data-warera-ops-total-value";
  const MONEY_PATH_PREFIX = "M12 5C7.031 5 2 6.546 2 9.5S7.031 14"; // WarEra's "money" coin glyph
  const NUMBER_SUFFIX = { K: 1e3, M: 1e6, B: 1e9 };
  const SIGMA_ICON = `<path d="M17,3H4V5L11,12L4,19V21H17V19H7L14,12L7,5H17V3Z"></path>`;

  // Skinned item codes are "<skinName><BaseType>" (e.g. "grimdarkAmmo", "grimdarkLightAmmo") —
  // itemTrading.getPrices is keyed by the base type, so strip the skin prefix before lookup.
  // Longest names first so "LightAmmo"/"HeavyAmmo" match before the shorter "Ammo" they both end with.
  const SKIN_SUFFIXES = [
    "LightAmmo",
    "HeavyAmmo",
    "Ammo",
    "Jet",
    "Tank",
    "Sniper",
    "Rifle",
    "Gun",
    "Knife",
    "Helmet",
    "Gloves",
    "Pants",
    "Chest",
    "Boots",
  ];

  function stripSkin(code) {
    if (!code) return code;
    const suffix = SKIN_SUFFIXES.find((s) => code.endsWith(s));
    if (!suffix) return code;
    // The suffix is PascalCase as it appears inside the compound skin name (e.g. the "Ammo" in
    // "grimdarkAmmo"), but the unskinned base code — and itemTrading.getPrices' keys — start
    // lowercase ("ammo"). Lowercase just the first letter to match.
    return suffix.charAt(0).toLowerCase() + suffix.slice(1);
  }

  function isAccountPage() {
    return /\/(country|mu)\/[a-fA-F0-9]{24}\/account/.test(location.pathname);
  }

  function isMoneyPath(d) {
    return !!d && d.startsWith(MONEY_PATH_PREFIX);
  }

  function parseFormattedNumber(text) {
    if (!text) return null;
    const match = text.trim().match(/^([\d.]+)\s*([KMB])?$/i);
    if (!match) return null;
    const num = parseFloat(match[1]);
    if (Number.isNaN(num)) return null;
    const mult = match[2] ? NUMBER_SUFFIX[match[2].toUpperCase()] : 1;
    return num * mult;
  }

  function formatNumber(value) {
    if (typeof value !== "number") return "—";
    const abs = Math.abs(value);
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/0$/, "").replace(/\.$/, "")}M`;
    if (abs >= 1_000) return `${(value / 1_000).toFixed(2).replace(/0$/, "").replace(/\.$/, "")}K`;
    return `${Math.round(value * 100) / 100}`;
  }

  async function fetchPrices() {
    try {
      const raw = await browser.runtime.sendMessage({
        type: "WARERA_OPS_FETCH",
        endpoint: "itemTrading.getPrices",
        params: {},
      });
      return raw?.result?.data ?? raw ?? {};
    } catch (err) {
      console.error("[WarEra Ops] failed to fetch item prices", err);
      return {};
    }
  }

  // Anchored on the "Inventory" section title text rather than a hashed class — the row of
  // money + item entries is its next sibling.
  function findInventoryContainer() {
    const titleSpan = Array.from(document.querySelectorAll("span")).find(
      (s) => s.textContent.trim() === "Inventory"
    );
    const titleRow = titleSpan?.parentElement?.parentElement;
    return titleRow?.nextElementSibling || null;
  }

  function findMoneyEntry(container) {
    return Array.from(container.children).find((entry) => {
      if (entry.querySelector("img[alt]")) return false; // item entries have an item image
      const path = entry.querySelector("svg path");
      return path && isMoneyPath(path.getAttribute("d"));
    });
  }

  function findItemEntries(container) {
    return Array.from(container.children).filter((entry) => entry.querySelector("img[alt]"));
  }

  function readQuantity(entry) {
    const el = entry.querySelector('div[style*="display: inline-block"]');
    return parseFormattedNumber(el?.textContent);
  }

  function computeTotalValue(container, prices) {
    const moneyEntry = findMoneyEntry(container);
    if (!moneyEntry) return null;
    const money = readQuantity(moneyEntry);
    if (typeof money !== "number") return null;

    let itemsValue = 0;
    let unpriced = 0;
    for (const entry of findItemEntries(container)) {
      const img = entry.querySelector("img[alt]");
      const itemCode = stripSkin(img.getAttribute("alt"));
      const quantity = readQuantity(entry);
      const price = prices[itemCode];
      if (typeof quantity !== "number") continue;
      if (typeof price === "number") {
        itemsValue += quantity * price;
      } else {
        unpriced += 1; // e.g. equipment pieces — itemTrading.getPrices only covers base materials
      }
    }

    return { total: money + itemsValue, moneyEntry, unpriced };
  }

  function buildTotalEntry(moneyEntry, total, unpriced) {
    const entry = moneyEntry.cloneNode(true);
    entry.setAttribute(MARKER_ATTR, "true");

    // Always shown: a country's/MU's displayed money/item quantities don't reflect what's tied
    // up in its own pending buy orders (money reserved) or sell orders (items listed), so this
    // total can be off in either direction even when every item type has a known price.
    const notes = [
      "This total may be inaccurate: pending buy/sell market orders can reserve money or items that aren't reflected in the displayed balance.",
    ];
    if (unpriced > 0) {
      notes.push(`${unpriced} item type(s) in this inventory have no market price and aren't included.`);
    }
    entry.title = notes.join(" ");

    const iconHolder = entry.querySelector(".a6izou0");
    if (iconHolder) {
      iconHolder.innerHTML = `
        <svg viewBox="0 0 24 24" style="width:1em;height:1em;font-size:120%;filter:drop-shadow(black 1px 1px 0px);" fill="currentColor">
          ${SIGMA_ICON}
        </svg>
      `;
    }
    const valueContainer = entry.querySelector('div[style*="display: inline-block"]');
    if (valueContainer) valueContainer.textContent = `${formatNumber(total)} *`;

    return entry;
  }

  let prices = null;
  let pricesPromise = null;

  function ensurePrices() {
    if (pricesPromise) return;
    pricesPromise = fetchPrices().then((p) => {
      prices = p;
      scheduleSync();
    });
  }

  function sync() {
    if (!active || !window.WarEraOps.isEnabled()) return;
    // Per-feature toggle (popup "Total inventory value", under Inventory). Separate from the
    // global extra-stats switch — off means remove the entry and stop, same pattern as
    // battle-contracts.js's "Open contracts" toggle.
    if (!featureEnabled) {
      document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((el) => el.remove());
      return;
    }
    if (!isAccountPage()) return;

    const container = findInventoryContainer();
    if (!container) return;
    if (container.querySelector(`[${MARKER_ATTR}]`)) return; // already injected for this container

    if (!prices) {
      ensurePrices();
      return;
    }

    const result = computeTotalValue(container, prices);
    if (!result) return;

    container.insertBefore(buildTotalEntry(result.moneyEntry, result.total, result.unpriced), result.moneyEntry);
  }

  let active = false;
  let observer = null;
  let pollInterval = null;
  let lastPath = null;
  let scheduled = false;
  let featureEnabled = true; // popup key "accountInventoryValueEnabled" (default on)
  let storageListener = null;

  const FEATURE_KEY = "accountInventoryValueEnabled";

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

    // WarEra re-renders this row client-side (route changes), which can wipe our injected entry
    // since React doesn't know about it — watch and re-add.
    observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, { childList: true, subtree: true });

    lastPath = location.pathname;
    pollInterval = setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        scheduleSync();
      }
    }, 800);

    scheduleSync();
  }

  function deactivate() {
    active = false;
    if (storageListener) {
      browser.storage.onChanged.removeListener(storageListener);
      storageListener = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((el) => el.remove());
    prices = null;
    pricesPromise = null;
  }

  window.WarEraOps.registerFeature({ name: "accountInventoryValue", activate, deactivate });
})();
