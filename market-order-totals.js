// Feature: on the market page, adds per-item buy/sell order counts directly on each item tile —
// pulled from tradingOrder.getTopOrders (one call per item, up to 100 orders each side; no
// cursor on this endpoint, so 100/side is a real ceiling, not an arbitrary choice). The count
// rows are clones of the tile's own price row (same icon+value markup WarEra already uses), so
// they inherit the game's real font/color/border instead of custom styling. Hovering a tile shows
// the fuller breakdown (item quantity, total money) in a tooltip, since the tile itself is too
// small to fit six numbers.
(function () {
  const MARKER_ATTR = "data-warera-ops-market-row";

  // Exactly the item codes given for this feature — equipment/weapon codes (helmet1-6, sniper,
  // etc.) exist on this endpoint too but were out of scope for this request.
  const ITEM_CODES = [
    "cookedFish",
    "heavyAmmo",
    "steel",
    "bread",
    "grain",
    "limestone",
    "coca",
    "concrete",
    "oil",
    "case1",
    "lightAmmo",
    "steak",
    "livestock",
    "cocain",
    "lead",
    "fish",
    "petroleum",
    "ammo",
    "iron",
    "scraps",
    "case2",
    "wood",
    "paper",
  ];

  const BUY_ICON = `<circle cx="12" cy="12" r="9"></circle><path d="M8 13l4-4 4 4"></path>`;
  const SELL_ICON = `<circle cx="12" cy="12" r="9"></circle><path d="M8 11l4 4 4-4"></path>`;

  function isMarketPage() {
    return /^\/market\/?$/.test(location.pathname);
  }

  function formatNumber(value) {
    if (typeof value !== "number") return "—";
    const abs = Math.abs(value);
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/0$/, "").replace(/\.$/, "")}M`;
    if (abs >= 1_000) return `${(value / 1_000).toFixed(2).replace(/0$/, "").replace(/\.$/, "")}K`;
    return `${Math.round(value * 100) / 100}`;
  }

  async function fetchItemOrders(itemCode) {
    try {
      const raw = await browser.runtime.sendMessage({
        type: "WARERA_OPS_FETCH",
        endpoint: "tradingOrder.getTopOrders",
        params: { itemCode, limit: 100 },
      });
      const payload = raw?.result?.data ?? raw;
      return {
        buyOrders: payload?.buyOrders ?? [],
        sellOrders: payload?.sellOrders ?? [],
      };
    } catch (err) {
      console.error(`[WarEra Ops] failed to fetch market orders for ${itemCode}`, err);
      return { buyOrders: [], sellOrders: [] };
    }
  }

  async function fetchMarketPrices() {
    try {
      const raw = await browser.runtime.sendMessage({
        type: "WARERA_OPS_FETCH",
        endpoint: "itemTrading.getPrices",
        params: {},
      });
      return raw?.result?.data ?? raw ?? {};
    } catch (err) {
      console.error("[WarEra Ops] failed to fetch reference market prices", err);
      return {};
    }
  }

  // Some players post orders as jokes/trolls — buy orders at a fraction of a cent, sell orders
  // at absurd markups — which dominate a plain sum. Filter against the game's own current price
  // rather than deriving "normal" from the order book itself, since a thin book could be mostly
  // junk. Orders outside 10%-1000% of the reference price are excluded from the totals entirely.
  const OUTLIER_MIN_RATIO = 0.1;
  const OUTLIER_MAX_RATIO = 10;

  function filterOutliers(orders, marketPrice) {
    if (typeof marketPrice !== "number" || marketPrice <= 0) return orders; // no reference — don't filter
    const min = marketPrice * OUTLIER_MIN_RATIO;
    const max = marketPrice * OUTLIER_MAX_RATIO;
    return orders.filter((o) => typeof o.price === "number" && o.price >= min && o.price <= max);
  }

  // The endpoint has no cursor and caps at 100 (confirmed against the live game — its own
  // order-book popup doesn't show more than 100 either), so hitting exactly 100 means there may
  // well be more we can't see, not that 100 is the true count.
  function summarize(rawOrders, marketPrice) {
    const filtered = filterOutliers(rawOrders, marketPrice);
    let count = 0;
    let items = 0;
    let money = 0;
    for (const order of filtered) {
      count += 1;
      const quantity = typeof order.quantity === "number" ? order.quantity : 0;
      const price = typeof order.price === "number" ? order.price : 0;
      items += quantity;
      money += quantity * price;
    }
    return { count, items, money, capped: rawOrders.length >= 100, excluded: rawOrders.length - filtered.length };
  }

  function formatCount(t) {
    return t.capped ? "100+" : String(t.count);
  }

  const itemTotals = new Map(); // itemCode -> { buy: {count,items,money}, sell: {...} } | "loading"

  async function fetchAllItemTotals() {
    const prices = await fetchMarketPrices();
    await Promise.all(
      ITEM_CODES.map(async (itemCode) => {
        itemTotals.set(itemCode, "loading");
        const { buyOrders, sellOrders } = await fetchItemOrders(itemCode);
        const marketPrice = prices[itemCode];
        itemTotals.set(itemCode, {
          buy: summarize(buyOrders, marketPrice),
          sell: summarize(sellOrders, marketPrice),
        });
        scheduleSync();
      })
    );
  }

  function findTile(itemCode) {
    return document.getElementById(`item-code-selector-${itemCode}`);
  }

  function findInfoColumn(tile) {
    // The tile's children are [image wrapper, info column]; the info column's first child is
    // the price row (icon + value) — the template we clone for our own count rows.
    return tile.children[1] || null;
  }

  function buildCountRow(priceRow, iconSvg, value) {
    const row = priceRow.cloneNode(true);
    row.setAttribute(MARKER_ATTR, "true");
    const iconHolder = row.querySelector(".a6izou0") || row.children[0];
    if (iconHolder) {
      iconHolder.innerHTML = `
        <svg viewBox="0 0 24 24" style="width:1em;height:1em;font-size:120%;filter:drop-shadow(black 1px 1px 0px);" fill="none" stroke="currentColor" stroke-width="2">
          ${iconSvg}
        </svg>
      `;
    }
    const valueSpan = row.querySelector("span.agd9b40");
    if (valueSpan) valueSpan.textContent = String(value);
    return row;
  }

  function injectTileRows(itemCode, totals) {
    const tile = findTile(itemCode);
    if (!tile) return;
    const infoColumn = findInfoColumn(tile);
    const priceRow = infoColumn?.children[0];
    if (!infoColumn || !priceRow) return;

    if (infoColumn.querySelector(`[${MARKER_ATTR}]`)) return; // already injected for this tile

    infoColumn.appendChild(buildCountRow(priceRow, BUY_ICON, formatCount(totals.buy)));
    infoColumn.appendChild(buildCountRow(priceRow, SELL_ICON, formatCount(totals.sell)));

    tile.addEventListener("mouseenter", () => showTooltip(tile, itemCode));
    tile.addEventListener("mouseleave", hideTooltip);
    tile.addEventListener("focus", () => showTooltip(tile, itemCode));
    tile.addEventListener("blur", hideTooltip);
  }

  // --- Tooltip (WarEra Ops's own styling — the inline rows above use the game's real markup,
  // but there's no existing game element for "extra breakdown on hover" to clone instead) ---
  let tooltipEl = null;

  function createTooltip() {
    if (tooltipEl) return;
    const style = document.createElement("style");
    style.id = "warera-ops-market-tooltip-style";
    // Styling mirrors WarEra's own elevated surfaces (Saira font, dark slate panel bg, the game's
    // signature layered near-black ring + soft shadow) so it sits in line with the game UI —
    // matches the tooltip in rankings.js.
    style.textContent = `
      #warera-ops-market-tooltip {
        position: fixed;
        z-index: 2147483647;
        display: none;
        min-width: 180px;
        padding: 10px 12px;
        background: rgba(21, 26, 30, 0.96);
        border-radius: 9px;
        box-shadow: 0 0 0 1px #0b0d0f, 0 1px 0 1px #0b0d0f, 2px 2px 14px rgba(0, 0, 0, 0.55);
        font-family: "Saira", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #d2dadf;
        pointer-events: none;
      }
      #warera-ops-market-tooltip .wi-mtt-title {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #a0a7b4;
        margin-bottom: 6px;
        padding-bottom: 6px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }
      #warera-ops-market-tooltip .wi-mtt-col-label {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        opacity: 0.75;
        margin-top: 6px;
      }
      #warera-ops-market-tooltip .wi-mtt-row {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        font-size: 13px;
        padding: 1px 0;
      }
      #warera-ops-market-tooltip .wi-mtt-value {
        font-weight: 700;
        color: #f2d9a1;
      }
      #warera-ops-market-tooltip .wi-mtt-note {
        font-size: 11px;
        font-style: italic;
        opacity: 0.75;
        margin-top: 2px;
      }
    `;
    document.head.appendChild(style);

    tooltipEl = document.createElement("div");
    tooltipEl.id = "warera-ops-market-tooltip";
    document.body.appendChild(tooltipEl);
  }

  function destroyTooltip() {
    document.getElementById("warera-ops-market-tooltip-style")?.remove();
    tooltipEl?.remove();
    tooltipEl = null;
  }

  function tooltipHTML(itemCode, totals) {
    const side = (label, t) => `
      <div class="wi-mtt-col-label">${label}</div>
      <div class="wi-mtt-row"><span>Orders</span><span class="wi-mtt-value">${formatCount(t)}</span></div>
      <div class="wi-mtt-row"><span>Items</span><span class="wi-mtt-value">${formatNumber(t.items)}${t.capped ? "+" : ""}</span></div>
      <div class="wi-mtt-row"><span>Money</span><span class="wi-mtt-value">${formatNumber(t.money)}${t.capped ? "+" : ""}</span></div>
      ${t.capped ? `<div class="wi-mtt-note">Capped at 100 orders — actual totals are likely higher</div>` : ""}
      ${t.excluded > 0 ? `<div class="wi-mtt-note">${t.excluded} extreme-priced order${t.excluded === 1 ? "" : "s"} excluded</div>` : ""}
    `;
    return `
      <div class="wi-mtt-title">${itemCode}</div>
      ${side("Buy", totals.buy)}
      ${side("Sell", totals.sell)}
    `;
  }

  function showTooltip(tile, itemCode) {
    const totals = itemTotals.get(itemCode);
    if (!tooltipEl || !totals || totals === "loading") return;
    tooltipEl.innerHTML = tooltipHTML(itemCode, totals);
    tooltipEl.style.visibility = "hidden";
    tooltipEl.style.display = "block";

    const tileRect = tile.getBoundingClientRect();
    const ttRect = tooltipEl.getBoundingClientRect();
    let top = tileRect.bottom + 8;
    let left = tileRect.left;
    if (top + ttRect.height > window.innerHeight - 8) top = tileRect.top - ttRect.height - 8;
    if (left + ttRect.width > window.innerWidth - 8) left = window.innerWidth - ttRect.width - 8;
    if (left < 8) left = 8;
    if (top < 8) top = 8;

    tooltipEl.style.top = `${top}px`;
    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.visibility = "visible";
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = "none";
  }

  function sync() {
    if (!active || !window.WarEraOps.isEnabled()) return;

    if (!isMarketPage()) {
      // Navigating away can unmount the hovered tile without the pointer ever moving, so
      // "mouseleave" never fires on it — this is the safety net for that case.
      hideTooltip();
      return;
    }

    if (!fetchStarted) {
      fetchStarted = true;
      fetchAllItemTotals();
    }

    for (const [itemCode, totals] of itemTotals) {
      if (totals === "loading") continue;
      injectTileRows(itemCode, totals);
    }
  }

  let active = false;
  let observer = null;
  let pollInterval = null;
  let lastPath = null;
  let scheduled = false;
  let fetchStarted = false;

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
    createTooltip();

    observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, { childList: true, subtree: true });

    // Back/forward navigation (via mouse button, keyboard, or the browser UI) fires this
    // regardless of how it was triggered — hide immediately rather than waiting on the poll.
    window.addEventListener("popstate", hideTooltip);

    lastPath = location.pathname;
    pollInterval = setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        if (!isMarketPage()) {
          fetchStarted = false;
          itemTotals.clear();
        }
        scheduleSync();
      }
    }, 800);

    scheduleSync();
  }

  function deactivate() {
    active = false;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    window.removeEventListener("popstate", hideTooltip);
    destroyTooltip();
    document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((el) => el.remove());
    fetchStarted = false;
    itemTotals.clear();
  }

  window.WarEraOps.registerFeature({ name: "marketOrderTotals", activate, deactivate });
})();
