// Feature: fills in rankings.* stat tiles on /user/:id that WarEra's own UI doesn't render.
(function () {
  const RANK_HREF_PREFIX = "/rankings?rank=";
  const MARKER_ATTR = "data-warera-ops-tile";
  const PREFERRED_TEMPLATE_HREF = `${RANK_HREF_PREFIX}userWealth`;
  const BADGE_BASE_CLASSES = ["chnava4", "chnavau"]; // shared by every tile's rank badge, unlike the tier-color class

  const ICONS = {
    userBounty: `<circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="5"></circle><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"></circle>`,
    userCasesOpened: `<path d="M3 7l9-4 9 4-9 4-9-4z"></path><path d="M3 7v10l9 4 9-4V7"></path><path d="M12 11v10"></path>`,
    userGemsPurchased: `<path d="M6 3h12l4 6-10 12L2 9z"></path><path d="M2 9h20M9 3l-3 6 6 12 6-12-3-6"></path>`,
    userEliteCasesOpened: `<path d="M3 7l9-4 9 4-9 4-9-4z"></path><path d="M3 7v10l9 4 9-4V7"></path><path d="M12 11v10"></path><path d="M12 2.5l1.2 2.4 2.6.4-1.9 1.9.5 2.6-2.4-1.3-2.4 1.3.5-2.6-1.9-1.9 2.6-.4z" fill="currentColor" stroke="none"></path>`,
  };
  const DEFAULT_ICON = `<circle cx="12" cy="12" r="9"></circle><path d="M12 7v6l4 2"></path>`;

  // Full standalone icons (own viewBox + fill) rather than paths for the shared stroke-based
  // template above — these came from the user's own SVG files, colors included.
  const FULL_ICONS = {
    userHealth: `<svg viewBox="2 3 20 18.35" style="width:1em;height:1em;font-size:100%;filter:drop-shadow(black 1px 1px 0px);"><path d="M12,21.35L10.55,20.03C5.4,15.36 2,12.27 2,8.5C2,5.41 4.42,3 7.5,3C9.24,3 10.91,3.81 12,5.08C13.09,3.81 14.76,3 16.5,3C19.58,3 22,5.41 22,8.5C22,12.27 18.6,15.36 13.45,20.03L12,21.35Z" fill="currentColor"></path></svg>`,
    userHunger: `<svg viewBox="3 2 18 20" style="width:1em;height:1em;font-size:100%;filter:drop-shadow(black 1px 1px 0px);"><path d="M11,9H9V2H7V9H5V2H3V9C3,11.12 4.66,12.84 6.75,12.97V22H9.25V12.97C11.34,12.84 13,11.12 13,9V2H11V9M16,6V14H18.5V22H21V2C18.24,2 16,4.24 16,6Z" fill="currentColor"></path></svg>`,
  };

  const LABELS = {
    userBounty: "Bounty",
    userCasesOpened: "Cases opened",
    userGemsPurchased: "Gems purchased",
    userEliteCasesOpened: "Elite cases opened",
    userHealth: "Health",
    userHunger: "Hunger",
  };

  // Ranking categories that don't correspond to a real WarEra leaderboard — clicking them
  // shouldn't navigate anywhere.
  const NON_NAVIGABLE_KEYS = new Set(["userEliteCasesOpened", "userHealth", "userHunger"]);

  // `skills.health`/`skills.hunger` are bars, not a single number — show currentBarValue/value.
  function statFromBar(bar) {
    if (!bar || typeof bar.currentBarValue !== "number" || typeof bar.value !== "number") return undefined;
    const current = bar.currentBarValue.toFixed(1);
    return { value: bar.currentBarValue, display: `${current} / ${bar.value.toLocaleString("en-US")}` };
  }

  // Extra stats pulled from `stats.*`/`skills.*` rather than `rankings.*` (no rank/tier data available).
  const EXTRA_TILES = [
    {
      key: "userEliteCasesOpened",
      getStat: () => {
        const value = state.stats?.case2?.openedCount;
        return value === undefined ? undefined : { value };
      },
    },
    { key: "userHealth", getStat: () => statFromBar(state.skills?.health) },
    { key: "userHunger", getStat: () => statFromBar(state.skills?.hunger) },
  ];

  // Loot breakdown shown on hover for tiles backed by a `case*` stats block.
  const LOOT_SOURCE = {
    userCasesOpened: { title: "Case Loot", getData: () => state.stats?.case1?.byRarity },
    userEliteCasesOpened: { title: "Elite Case Loot", getData: () => state.stats?.case2?.byRarity },
  };
  const RARITY_ORDER = ["common", "uncommon", "rare", "epic", "legendary", "mythic"];
  // Pulled from colors WarEra's own UI already uses elsewhere, ordered common -> rarest.
  const RARITY_COLORS = {
    common: "rgb(208, 202, 200)",
    uncommon: "rgb(129, 206, 157)",
    rare: "rgb(166, 209, 242)",
    epic: "rgb(200, 183, 225)",
    legendary: "rgb(231, 185, 165)",
    mythic: "rgb(226, 149, 150)",
  };

  function humanizeKey(key) {
    return key
      .replace(/^user/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .trim();
  }

  const state = {
    userId: null,
    rankings: undefined, // undefined = not fetched yet, null = fetched but absent/failed, object once loaded
    stats: null,
    skills: null,
    fetching: false,
  };

  let active = false;
  let observer = null;
  let pollInterval = null;
  let lastPath = null;
  let scheduled = false;
  let tooltipEl = null;

  function createTooltip() {
    if (tooltipEl) return;

    const style = document.createElement("style");
    style.id = "warera-ops-tooltip-style";
    style.textContent = `
      #warera-ops-tooltip {
        position: fixed;
        z-index: 2147483647;
        display: none;
        min-width: 170px;
        padding: 10px 12px;
        background: linear-gradient(180deg, #29323c 0%, #1c232b 100%);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 8px;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
        font-family: "Texturina", Georgia, serif;
        color: #e5e9ee;
        pointer-events: none;
      }
      #warera-ops-tooltip .wi-tt-title {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        opacity: 0.7;
        margin-bottom: 6px;
        padding-bottom: 6px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      }
      #warera-ops-tooltip .wi-tt-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        font-size: 13px;
        padding: 2px 0;
      }
      #warera-ops-tooltip .wi-tt-rarity {
        display: flex;
        align-items: center;
        gap: 6px;
        font-weight: 600;
        text-transform: capitalize;
      }
      #warera-ops-tooltip .wi-tt-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex: none;
      }
      #warera-ops-tooltip .wi-tt-count {
        font-weight: 700;
        color: #f2d9a1;
      }
    `;
    document.head.appendChild(style);

    tooltipEl = document.createElement("div");
    tooltipEl.id = "warera-ops-tooltip";
    document.body.appendChild(tooltipEl);
  }

  function destroyTooltip() {
    document.getElementById("warera-ops-tooltip-style")?.remove();
    tooltipEl?.remove();
    tooltipEl = null;
  }

  function buildTooltipHTML(byRarity, title) {
    const rows = RARITY_ORDER.filter((r) => byRarity[r] != null)
      .map(
        (r) => `
          <div class="wi-tt-row">
            <span class="wi-tt-rarity">
              <span class="wi-tt-dot" style="background:${RARITY_COLORS[r]}"></span>${r}
            </span>
            <span class="wi-tt-count">${byRarity[r].toLocaleString("en-US")}</span>
          </div>
        `
      )
      .join("");
    return `<div class="wi-tt-title">${title}</div>${rows || '<div class="wi-tt-row">No data yet</div>'}`;
  }

  function showTooltip(tile, byRarity, title) {
    if (!tooltipEl || !byRarity) return;
    tooltipEl.innerHTML = buildTooltipHTML(byRarity, title);
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

  function extractUserId() {
    const match = location.pathname.match(/\/user\/([a-fA-F0-9]{24})/);
    return match ? match[1] : null;
  }

  function formatNumber(value) {
    if (typeof value !== "number") return "—";
    const abs = Math.abs(value);
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
    if (abs >= 1_000) return `${(value / 1_000).toFixed(2).replace(/0$/, "").replace(/\.$/, "")}K`;
    return value.toLocaleString("en-US");
  }

  // Classes shared by every element in `elements` (their common styling), so that whatever's
  // left per-element is just its accent-color classes.
  function commonClasses(elements) {
    if (elements.length === 0) return new Set();
    let base = new Set(elements[0].classList);
    for (let i = 1; i < elements.length; i++) {
      const cur = elements[i].classList;
      base = new Set([...base].filter((c) => cur.contains(c)));
    }
    return base;
  }

  function variantClasses(el, base) {
    return Array.from(el.classList).filter((c) => !base.has(c));
  }

  function swapVariant(el, base, nextVariant) {
    for (const c of variantClasses(el, base)) el.classList.remove(c);
    for (const c of nextVariant) el.classList.add(c);
  }

  // WarEra colors (and icons, for the rank badge) every tile purely by its tier — diamond,
  // platinum, gold, etc. Read that mapping straight off whichever real tiles are on the page
  // right now, matched against the rankings we just fetched for the SAME page load, so the two
  // can't drift out of sync with each other.
  function buildTierPalette(tiles, rankings) {
    const outerBase = commonClasses(tiles);
    const labelEls = tiles.map((t) => t.children[0]?.children[0]).filter(Boolean);
    const labelBase = commonClasses(labelEls);
    const valueEls = tiles.map((t) => t.children[0]?.children[1]?.children[0]).filter(Boolean);
    const valueBase = commonClasses(valueEls);

    const byTier = {};
    tiles.forEach((tile, i) => {
      const href = tile.getAttribute("href") || "";
      const key = href.slice(RANK_HREF_PREFIX.length);
      const tier = rankings?.[key]?.tier;
      if (!tier || byTier[tier]) return; // first real tile of this tier wins

      const labelEl = labelEls[i];
      const valueEl = valueEls[i];
      const badgeOuter = tile.children[1];
      const badgeInner = badgeOuter?.querySelector('[class*="chnava"]');
      const badgeIconHolder = badgeInner?.children[0];
      const badgeVariant = badgeInner
        ? Array.from(badgeInner.classList).find(
            (c) => c.startsWith("chnava") && !BADGE_BASE_CLASSES.includes(c)
          )
        : null;

      byTier[tier] = {
        outer: variantClasses(tile, outerBase),
        label: labelEl ? variantClasses(labelEl, labelBase) : [],
        value: valueEl ? variantClasses(valueEl, valueBase) : [],
        badgeVariant: badgeVariant || null,
        badgeIconHTML: badgeIconHolder ? badgeIconHolder.innerHTML : null,
      };
    });

    return { outerBase, labelBase, valueBase, byTier };
  }

  // Clones a real rank tile (so it automatically inherits WarEra's current styling)
  // and repoints its label/icon/value/badge/colors at the given ranking category instead of
  // hardcoding CSS.
  function buildTile(referenceTile, key, stat, palette) {
    const tile = referenceTile.cloneNode(true);
    tile.setAttribute(MARKER_ATTR, key);
    tile.setAttribute("href", `${RANK_HREF_PREFIX}${key}`);

    try {
      const contentDiv = tile.children[0]; // label + value wrapper
      const labelSpan = contentDiv.children[0];
      const valueWrapperDiv = contentDiv.children[1];
      const valueSpan = valueWrapperDiv.children[0];
      const iconDiv = valueSpan.children[0];
      const numberSpan = valueSpan.children[1];

      labelSpan.textContent = LABELS[key] || humanizeKey(key);
      numberSpan.textContent = stat?.display ?? formatNumber(stat?.value ?? null);
      iconDiv.innerHTML =
        FULL_ICONS[key] ||
        `
        <svg viewBox="0 0 24 24" style="width:1em;height:1em;font-size:120%;filter:drop-shadow(black 1px 1px 0px);" fill="none" stroke="currentColor" stroke-width="2">
          ${ICONS[key] || DEFAULT_ICON}
        </svg>
      `;

      const tierInfo = stat?.tier ? palette?.byTier[stat.tier] : null;
      if (tierInfo) {
        swapVariant(tile, palette.outerBase, tierInfo.outer);
        swapVariant(labelSpan, palette.labelBase, tierInfo.label);
        swapVariant(valueSpan, palette.valueBase, tierInfo.value);
      }

      const badgeOuter = tile.children[1];
      const badgeInner = badgeOuter?.querySelector('[class*="chnava"]');
      const badgeNumber = badgeInner?.querySelector("span");
      if (stat?.rank != null && badgeInner && badgeNumber) {
        badgeNumber.textContent = String(stat.rank);
        if (tierInfo?.badgeVariant) {
          const currentVariant = Array.from(badgeInner.classList).find(
            (c) => c.startsWith("chnava") && !BADGE_BASE_CLASSES.includes(c)
          );
          if (currentVariant && currentVariant !== tierInfo.badgeVariant) {
            badgeInner.classList.remove(currentVariant);
            badgeInner.classList.add(tierInfo.badgeVariant);
          }
        }
        if (tierInfo?.badgeIconHTML) {
          const iconHolder = badgeInner.children[0];
          if (iconHolder) iconHolder.innerHTML = tierInfo.badgeIconHTML;
        }
      } else if (badgeOuter) {
        badgeOuter.remove(); // no rank/tier data available; don't show a fabricated badge
      }

      if (NON_NAVIGABLE_KEYS.has(key)) {
        tile.addEventListener("click", (e) => e.preventDefault());
      }

      const loot = LOOT_SOURCE[key];
      if (loot) {
        tile.addEventListener("mouseenter", () => showTooltip(tile, loot.getData(), loot.title));
        tile.addEventListener("mouseleave", hideTooltip);
        tile.addEventListener("focus", () => showTooltip(tile, loot.getData(), loot.title));
        tile.addEventListener("blur", hideTooltip);
      }
    } catch (err) {
      console.error("[WarEra Ops] tile structure did not match expectations", err);
    }

    return tile;
  }

  async function ensureRankingsFetched(userId) {
    if (state.userId === userId && state.rankings !== undefined) return;
    if (state.fetching) return;
    state.fetching = true;
    state.userId = userId;
    state.rankings = undefined;
    state.stats = null;
    state.skills = null;

    // WarEra's client-side router swaps the grid's real tiles but leaves our injected ones
    // alone (React doesn't know about them) — clear them now so stale numbers from the
    // previous profile don't linger while the new profile's data loads.
    document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((el) => el.remove());
    hideTooltip();

    try {
      const raw = await browser.runtime.sendMessage({
        type: "WARERA_OPS_FETCH",
        endpoint: "user.getUserById",
        params: { userId },
      });
      // tRPC endpoints normally wrap the payload as { result: { data: ... } };
      // fall back to the raw object in case this API returns it unwrapped.
      const payload = raw?.result?.data ?? raw;
      state.rankings = payload?.rankings ?? null;
      state.stats = payload?.stats ?? null;
      state.skills = payload?.skills ?? null;
    } catch (err) {
      console.error("[WarEra Ops] failed to fetch user data", err);
      state.rankings = null;
      state.stats = null;
      state.skills = null;
    } finally {
      state.fetching = false;
      tryInject();
    }
  }

  function tryInject() {
    if (!active || !window.WarEraOps.isEnabled()) return;

    const userId = extractUserId();
    if (!userId) return;

    if (userId !== state.userId) {
      ensureRankingsFetched(userId);
      return;
    }
    if (!state.rankings) return; // still loading, or fetch failed/empty

    const originalTiles = Array.from(
      document.querySelectorAll(`a[href^="${RANK_HREF_PREFIX}"]`)
    ).filter((el) => !el.hasAttribute(MARKER_ATTR));
    if (originalTiles.length === 0) return;

    const grid = originalTiles[0].parentElement;
    if (!grid) return;

    const existingKeys = new Set(
      Array.from(grid.querySelectorAll(`a[href^="${RANK_HREF_PREFIX}"]`)).map((el) =>
        (el.getAttribute("href") || "").slice(RANK_HREF_PREFIX.length)
      )
    );

    const missingRankingKeys = Object.keys(state.rankings).filter((key) => !existingKeys.has(key));
    const missingExtraKeys = EXTRA_TILES.filter(
      (extra) => extra.getStat() !== undefined && !existingKeys.has(extra.key)
    ).map((extra) => extra.key);
    if (missingRankingKeys.length === 0 && missingExtraKeys.length === 0) return;

    const reference =
      originalTiles.find((el) => el.getAttribute("href") === PREFERRED_TEMPLATE_HREF) ||
      originalTiles[originalTiles.length - 1];
    const palette = buildTierPalette(originalTiles, state.rankings);

    for (const key of missingRankingKeys) {
      grid.appendChild(buildTile(reference, key, state.rankings[key], palette));
    }
    for (const key of missingExtraKeys) {
      const extra = EXTRA_TILES.find((e) => e.key === key);
      grid.appendChild(buildTile(reference, key, extra.getStat(), palette));
    }
  }

  function scheduleInject() {
    if (!active || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      tryInject();
    });
  }

  function activate() {
    active = true;
    state.userId = null;
    state.rankings = undefined;
    state.stats = null;
    state.skills = null;
    state.fetching = false;

    createTooltip();
    window.addEventListener("scroll", hideTooltip, true);

    // WarEra re-renders this grid client-side (route changes, live data refreshes),
    // which can wipe our injected nodes since React doesn't know about them — watch and re-add.
    observer = new MutationObserver(scheduleInject);
    observer.observe(document.body, { childList: true, subtree: true });

    lastPath = location.pathname;
    pollInterval = setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        state.userId = null;
        state.rankings = undefined;
        state.stats = null;
        state.skills = null;
        scheduleInject();
      }
    }, 800);

    scheduleInject();
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
    window.removeEventListener("scroll", hideTooltip, true);
    destroyTooltip();
    document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((el) => el.remove());
    state.userId = null;
    state.rankings = undefined;
    state.stats = null;
    state.skills = null;
    state.fetching = false;
  }

  window.WarEraOps.registerFeature({ name: "rankings", activate, deactivate });
})();
