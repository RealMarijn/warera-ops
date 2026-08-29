// Feature: on a country's or MU's account page, adds a "Total Value" entry in front of the
// money figure in the inventory row, equal to money + (each item's quantity × its current market
// price from itemTrading.getPrices) + open buy/sell market orders. Both page types render this
// row with identical markup, so one implementation covers both rather than duplicating it. The
// new entry is a clone of the money entry itself (so it inherits the game's real icon-row
// styling), with the coin icon swapped for a sigma glyph so it doesn't read as a duplicate of the
// adjacent money figure.
//
// Buy/sell orders matter here because money escrowed in a buy order, and items listed in a sell
// order, both disappear from the displayed money/inventory figures while the order is open — so
// ignoring them understates net worth. Buy orders are added at the game's own "Total:" face
// value (that's real money the country/MU has already committed, not manipulable). Sell orders
// are NOT trusted at face value: the listed total is quantity × the seller's own chosen price,
// which can be set arbitrarily high purely to inflate the displayed total. Instead each sell
// order's item + quantity is read off directly and revalued at the real market price, exactly
// like inventory items.
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

  // Anchored on the "Inventory" section title text rather than a hashed class. Returns the card
  // body containing the whole section (title + money + items) rather than a specific row: WarEra
  // has changed how money/items are grouped under here before — they used to be flat siblings
  // right after the title, then WarEra added a divider and moved items into their own grid div —
  // so hardcoding "the next sibling" silently stopped finding any items at all once that shipped.
  // Searching the whole card body and picking out entries by what they contain (an item icon, a
  // money icon) rather than by position survives that kind of layout change.
  function findInventoryCardBody() {
    const titleSpan = Array.from(document.querySelectorAll("span")).find(
      (s) => s.textContent.trim() === "Inventory"
    );
    const titleRow = titleSpan?.parentElement?.parentElement;
    return titleRow?.parentElement || null;
  }

  // Keeps only the innermost matches from a list of candidate elements — needed because a
  // candidate's own ancestor (e.g. a row or grid wrapping several entries) can also satisfy the
  // same "contains X and Y" check.
  function innermost(candidates) {
    return candidates.filter((el) => !candidates.some((other) => other !== el && el.contains(other)));
  }

  function findMoneyEntry(cardBody) {
    const candidates = Array.from(cardBody.querySelectorAll("*")).filter((el) => {
      if (el.hasAttribute(MARKER_ATTR)) return false; // skip our own injected entry
      if (el.querySelector("img[alt]")) return false; // item entries have an item image
      const path = el.querySelector("svg path");
      return (
        path &&
        isMoneyPath(path.getAttribute("d")) &&
        !!el.querySelector('div[style*="display: inline-block"]')
      );
    });
    return innermost(candidates)[0];
  }

  function findItemEntries(cardBody) {
    const candidates = Array.from(cardBody.querySelectorAll("*")).filter(
      (el) => el.querySelector("img[alt]") && el.querySelector('div[style*="display: inline-block"]')
    );
    return innermost(candidates);
  }

  function readQuantity(entry) {
    const el = entry.querySelector('div[style*="display: inline-block"]');
    return parseFormattedNumber(el?.textContent);
  }

  // Finds the money figure attached to a "Total:" header row (used for the Buy orders header,
  // which is always denominated in money) — the coin <svg><path> plus the value span right after
  // its icon wrapper.
  function readHeaderMoneyTotal(headerBlock) {
    for (const path of headerBlock.querySelectorAll("svg path")) {
      if (!isMoneyPath(path.getAttribute("d"))) continue;
      const iconDiv = path.closest("svg")?.parentElement;
      const value = parseFormattedNumber(iconDiv?.nextElementSibling?.textContent);
      if (typeof value === "number") return value;
    }
    return null;
  }

  // Anchored on the market widget's own "/market" link rather than a hashed class — its parent is
  // the card body holding the Buy orders / Sell orders columns.
  function findMarketCardBody() {
    return document.querySelector('a[href="/market"]')?.parentElement || null;
  }

  // Locates the "Buy orders" / "Sell orders" block within the market card: a title div (no
  // children, exact text match), whose grandparent header row sits alongside the individual
  // order-entry rows as siblings inside a shared container. Scoped to the market card (rather
  // than searching the whole document) so this can't accidentally match an unrelated element
  // elsewhere on the page that happens to contain the same text (e.g. a hidden dialog template) —
  // that's exactly what silently zeroed out Sell orders while Buy orders kept working.
  function findOrdersSection(title) {
    const marketCardBody = findMarketCardBody();
    if (!marketCardBody) return null;
    const titleEl = Array.from(marketCardBody.querySelectorAll("div")).find(
      (d) => d.children.length === 0 && d.textContent.trim() === title
    );
    const headerBlock = titleEl?.parentElement?.parentElement;
    const container = headerBlock?.parentElement;
    if (!headerBlock || !container) return null;
    const orderEntries = Array.from(container.children).filter((el) => el !== headerBlock);
    return { headerBlock, orderEntries };
  }

  function readOrderItemCode(entry) {
    // Order rows also contain a country flag <img> and a user avatar <img>, both carrying
    // width/height attributes (Next.js Image) — the item icon is the only alt-tagged <img>
    // without them.
    const img = entry.querySelector("img[alt]:not([width])");
    return img ? stripSkin(img.getAttribute("alt")) : null;
  }

  function computeBuyOrdersValue() {
    const section = findOrdersSection("Buy orders");
    if (!section) return 0;
    return readHeaderMoneyTotal(section.headerBlock) ?? 0;
  }

  // Sell-order rows, found the same content-based way as inventory items (rather than assuming
  // they're direct siblings of the "Sell orders" header — that assumption is exactly what left
  // this silently computing zero after WarEra's last layout change). Each row contains an item
  // icon, a quantity, and the word "sells" (vs. "wants" for buy rows) — filtering on that keyword
  // also excludes the header's own icon+quantity breakdown, which matches the icon/quantity shape
  // but not the keyword.
  function findSellOrderEntries() {
    const marketCardBody = findMarketCardBody();
    if (!marketCardBody) return [];
    const candidates = Array.from(marketCardBody.querySelectorAll("*")).filter(
      (el) =>
        el.querySelector("img[alt]") &&
        el.querySelector('div[style*="display: inline-block"]') &&
        el.textContent.includes("sells")
    );
    return innermost(candidates);
  }

  function computeSellOrdersValue(prices) {
    let value = 0;
    let unpriced = 0;
    for (const entry of findSellOrderEntries()) {
      const itemCode = readOrderItemCode(entry);
      const quantity = readQuantity(entry);
      if (!itemCode || typeof quantity !== "number") continue;
      const price = prices[itemCode];
      if (typeof price === "number") {
        value += quantity * price;
      } else {
        unpriced += 1;
      }
    }
    return { value, unpriced };
  }

  function computeTotalValue(cardBody, prices) {
    const moneyEntry = findMoneyEntry(cardBody);
    if (!moneyEntry) return null;
    const money = readQuantity(moneyEntry);
    if (typeof money !== "number") return null;

    let itemsValue = 0;
    let unpriced = 0;
    for (const entry of findItemEntries(cardBody)) {
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

    const buyOrdersValue = computeBuyOrdersValue();
    const sellOrders = computeSellOrdersValue(prices);
    unpriced += sellOrders.unpriced;

    return {
      total: money + itemsValue + buyOrdersValue + sellOrders.value,
      moneyEntry,
      unpriced,
    };
  }

  // Shared by the real entry and the loading placeholder below — both are a clone of the money
  // entry with its coin icon swapped for a sigma glyph (so it doesn't read as a duplicate of the
  // adjacent money figure) and its value text replaced.
  function applySigmaEntry(entry, text, title) {
    entry.title = title;
    const iconHolder = entry.querySelector(".a6izou0");
    if (iconHolder) {
      iconHolder.innerHTML = `
        <svg viewBox="0 0 24 24" style="width:1em;height:1em;font-size:120%;filter:drop-shadow(black 1px 1px 0px);" fill="currentColor">
          ${SIGMA_ICON}
        </svg>
      `;
    }
    const valueContainer = entry.querySelector('div[style*="display: inline-block"]');
    if (valueContainer) valueContainer.textContent = text;
  }

  function buildTotalEntry(moneyEntry, total, unpriced) {
    const entry = moneyEntry.cloneNode(true);
    entry.setAttribute(MARKER_ATTR, "true");

    const notes = [
      "Includes money reserved in open buy orders (at face value) and items listed in open sell orders (valued at the current market price, not the seller's own listed price).",
    ];
    if (unpriced > 0) {
      notes.push(`${unpriced} item type(s) (in the inventory and/or open sell orders) have no market price and aren't included.`);
    }
    applySigmaEntry(entry, `${formatNumber(total)} *`, notes.join(" "));
    return entry;
  }

  // Shown the instant the money entry exists, before item prices have come back — without this
  // the row silently shows nothing at all for however long the fetch takes, which reads as broken
  // rather than loading.
  function buildLoadingEntry(moneyEntry) {
    const entry = moneyEntry.cloneNode(true);
    entry.setAttribute(MARKER_ATTR, "true");
    applySigmaEntry(entry, "Loading…", "Fetching current item prices to compute the total value…");
    return entry;
  }

  // Prices used to be fetched once per page load and cached forever — fine for a quick visit, but
  // this content script (and its cached `prices`) stays alive for as long as the tab is open, and
  // item prices drift continuously as trades happen elsewhere. Someone who opened the account page
  // hours ago and someone who just opened it moments ago would end up computing the "same" total
  // from two very different price snapshots, with no indication either total was stale — which is
  // exactly what produced wildly different totals for the same country across different viewers.
  // Refetching periodically (and rebuilding the displayed entry when prices change) keeps a
  // long-lived tab from drifting away from the current market.
  const PRICE_REFRESH_MS = 2 * 60 * 1000;

  let prices = null;
  let pricesPromise = null;

  function ensurePrices() {
    if (pricesPromise) return;
    pricesPromise = fetchPrices().then((p) => {
      prices = p;
      scheduleSync();
    });
  }

  function refreshPrices() {
    fetchPrices().then((p) => {
      prices = p;
      scheduleSync();
    });
  }

  // Last {total, unpriced} we actually displayed — lets sync() tell "nothing changed" apart from
  // "something changed", so it can keep re-checking on every mutation without re-inserting the
  // entry (and re-triggering the very observer that called it) when the numbers are unchanged.
  let lastComputed = null;

  function sync() {
    if (!active || !window.WarEraOps.isEnabled()) return;
    // Per-feature toggle (popup "Total inventory value", under Inventory). Separate from the
    // global extra-stats switch — off means remove the entry and stop, same pattern as
    // battle-contracts.js's "Open contracts" toggle.
    if (!featureEnabled) {
      document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((el) => el.remove());
      lastComputed = null;
      return;
    }
    if (!isAccountPage()) {
      lastComputed = null;
      return;
    }

    const cardBody = findInventoryCardBody();
    if (!cardBody) return;

    if (!prices) {
      ensurePrices();
      if (!cardBody.querySelector(`[${MARKER_ATTR}]`)) {
        const moneyEntry = findMoneyEntry(cardBody);
        if (moneyEntry) moneyEntry.parentElement.insertBefore(buildLoadingEntry(moneyEntry), moneyEntry);
      }
      return;
    }

    // Deliberately recomputed on every call rather than skipped once an entry exists: the
    // Inventory box and the Buy orders/Sell orders widget are separate, independently-loading
    // parts of the page, so the first computation can easily land before the orders widget has
    // rendered — undercounting buy/sell orders permanently if we never looked again. Re-reading
    // findMoneyEntry() here still finds the real money entry even with our own entry already in
    // the DOM, since our clone's icon path no longer matches isMoneyPath.
    const result = computeTotalValue(cardBody, prices);
    if (!result) return;

    if (lastComputed && lastComputed.total === result.total && lastComputed.unpriced === result.unpriced) {
      return; // unchanged — leave the existing entry alone
    }
    lastComputed = { total: result.total, unpriced: result.unpriced };

    cardBody.querySelector(`[${MARKER_ATTR}]`)?.remove();
    // Insert as a sibling of the actual money entry, not of cardBody — cardBody is just the
    // broad search root now, and may not be the money entry's direct parent.
    result.moneyEntry.parentElement.insertBefore(
      buildTotalEntry(result.moneyEntry, result.total, result.unpriced),
      result.moneyEntry
    );
  }

  let active = false;
  let observer = null;
  let pollInterval = null;
  let priceRefreshTimer = null;
  let lastPath = null;
  let scheduled = false;
  let featureEnabled = true; // popup key "accountInventoryValueEnabled" (default on)
  let storageListener = null;

  const FEATURE_KEY = "accountInventoryValueEnabled";

  function scheduleSync() {
    if (!active || scheduled) return;
    scheduled = true;
    // setTimeout rather than requestAnimationFrame: rAF callbacks are paused/heavily throttled by
    // the browser while the tab isn't visible/focused, so a page loaded or updated in a background
    // tab would never actually run sync() — the entry only appeared once you switched to the tab
    // (e.g. by clicking the toolbar icon, which brings it into focus as a side effect).
    setTimeout(() => {
      scheduled = false;
      sync();
    }, 0);
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
        lastComputed = null; // different account page — don't compare its total against the old one
        scheduleSync();
      }
    }, 800);

    priceRefreshTimer = setInterval(refreshPrices, PRICE_REFRESH_MS);

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
    if (priceRefreshTimer) {
      clearInterval(priceRefreshTimer);
      priceRefreshTimer = null;
    }
    document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((el) => el.remove());
    prices = null;
    pricesPromise = null;
    lastComputed = null;
  }

  window.WarEraOps.registerFeature({ name: "accountInventoryValue", activate, deactivate });
})();
