// Feature: adds a few specific rankings.*/computed stats to the military unit (mu) page's
// rankings grid. Same tile-clone approach as rankings.js/country-rankings.js — kept as its own
// file for the same reason: each page type differs enough in specifics (allowed keys,
// endpoint/params, computed stats) that a shared engine isn't worth the risk yet. If a fourth
// page type shows up, this is the point to extract a common engine from these three.
(function () {
  const RANK_HREF_PREFIX = "/rankings/mus?rank=";
  const MARKER_ATTR = "data-warera-ops-mu-tile";
  const PREFERRED_TEMPLATE_HREF = `${RANK_HREF_PREFIX}muDamages`;
  const BADGE_BASE_CLASSES = ["chnava4", "chnavau"]; // shared by every tile's rank badge, unlike the tier-color class

  // Only these rankings.* keys get added — this page was asked for a specific stat, not
  // "everything missing".
  const ALLOWED_RANKING_KEYS = new Set(["muBounty"]);

  const ICONS = {
    muBounty: `<circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="5"></circle><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"></circle>`,
    // Same coin-stack glyph WarEra's own muWealth tile uses.
    investedMoney: `<path d="M12 5C7.031 5 2 6.546 2 9.5S7.031 14 12 14c4.97 0 10-1.546 10-4.5S16.97 5 12 5zm-5 9.938v3c1.237.299 2.605.482 4 .541v-3a21.166 21.166 0 0 1-4-.541zm6 .54v3a20.994 20.994 0 0 0 4-.541v-3a20.994 20.994 0 0 1-4 .541zm6-1.181v3c1.801-.755 3-1.857 3-3.297v-3c0 1.44-1.199 2.542-3 3.297zm-14 3v-3C3.2 13.542 2 12.439 2 11v3c0 1.439 1.2 2.542 3 3.297z" fill="currentColor" stroke="none"></path>`,
  };
  const DEFAULT_ICON = `<circle cx="12" cy="12" r="9"></circle><path d="M12 7v6l4 2"></path>`;

  const LABELS = {
    muBounty: "Bounty",
    investedMoney: "Invested Money",
  };

  // investedMoney isn't a real leaderboard category — clicking it shouldn't navigate.
  const NON_NAVIGABLE_KEYS = new Set(["investedMoney"]);

  // Tiles with no rank/tier of their own instead borrow the color of whichever real,
  // currently-visible tile is named here.
  const COLOR_SOURCE_KEY = { investedMoney: "muWealth" };

  function sumInvestedMoney(payload) {
    const map = payload?.investedMoneyByUsers;
    if (!map || typeof map !== "object") return undefined;
    return Object.values(map).reduce((total, v) => total + (typeof v === "number" ? v : 0), 0);
  }

  // Extra stats computed from top-level payload fields rather than `rankings.*` (no rank/tier data).
  const EXTRA_TILES = [{ key: "investedMoney", getValue: () => sumInvestedMoney(state.payload) }];

  const state = {
    muId: null,
    rankings: undefined, // undefined = not fetched yet, null = fetched but absent/failed, object once loaded
    payload: null,
    fetching: false,
  };

  let active = false;
  let observer = null;
  let pollInterval = null;
  let lastPath = null;
  let scheduled = false;

  function extractMuId() {
    const match = location.pathname.match(/\/mu\/([a-fA-F0-9]{24})/);
    return match ? match[1] : null;
  }

  function formatNumber(value) {
    if (typeof value !== "number") return "—";
    const abs = Math.abs(value);
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
    if (abs >= 1_000) return `${(value / 1_000).toFixed(2).replace(/0$/, "").replace(/\.$/, "")}K`;
    return value.toLocaleString("en-US");
  }

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

  // Same idea as the other pages: read each tier's real color/icon straight off whichever real
  // tile currently has that tier, matched against the rankings we just fetched, and also index
  // by ranking key for tiles that need to borrow a specific tile's color instead of a tier's.
  function buildTierPalette(tiles, rankings) {
    const outerBase = commonClasses(tiles);
    const labelEls = tiles.map((t) => t.children[0]?.children[0]).filter(Boolean);
    const labelBase = commonClasses(labelEls);
    const valueEls = tiles.map((t) => t.children[0]?.children[1]?.children[0]).filter(Boolean);
    const valueBase = commonClasses(valueEls);

    const byTier = {};
    const byKey = {};
    tiles.forEach((tile, i) => {
      const href = tile.getAttribute("href") || "";
      const key = href.slice(RANK_HREF_PREFIX.length);

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

      const info = {
        outer: variantClasses(tile, outerBase),
        label: labelEl ? variantClasses(labelEl, labelBase) : [],
        value: valueEl ? variantClasses(valueEl, valueBase) : [],
        badgeVariant: badgeVariant || null,
        badgeIconHTML: badgeIconHolder ? badgeIconHolder.innerHTML : null,
      };

      byKey[key] = info;

      const tier = rankings?.[key]?.tier;
      if (tier && !byTier[tier]) byTier[tier] = info; // first real tile of this tier wins
    });

    return { outerBase, labelBase, valueBase, byTier, byKey };
  }

  function buildTile(referenceTile, key, stat, palette) {
    const tile = referenceTile.cloneNode(true);
    tile.setAttribute(MARKER_ATTR, key);
    tile.setAttribute("href", `${RANK_HREF_PREFIX}${key}`);

    try {
      const contentDiv = tile.children[0];
      const labelSpan = contentDiv.children[0];
      const valueWrapperDiv = contentDiv.children[1];
      const valueSpan = valueWrapperDiv.children[0];
      const iconDiv = valueSpan.children[0];
      const numberSpan = valueSpan.children[1];

      labelSpan.textContent = LABELS[key] || key;
      numberSpan.textContent = formatNumber(stat?.value ?? null);
      iconDiv.innerHTML = `
        <svg viewBox="0 0 24 24" style="width:1em;height:1em;font-size:120%;filter:drop-shadow(black 1px 1px 0px);" fill="none" stroke="currentColor" stroke-width="2">
          ${ICONS[key] || DEFAULT_ICON}
        </svg>
      `;

      const tierInfo = stat?.tier
        ? palette?.byTier[stat.tier]
        : palette?.byKey[COLOR_SOURCE_KEY[key]];
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
    } catch (err) {
      console.error("[WarEra Ops] mu tile structure did not match expectations", err);
    }

    return tile;
  }

  async function ensureRankingsFetched(muId) {
    if (state.muId === muId && state.rankings !== undefined) return;
    if (state.fetching) return;
    state.fetching = true;
    state.muId = muId;
    state.rankings = undefined;
    state.payload = null;

    // WarEra's client-side router swaps the grid's real tiles but leaves our injected ones
    // alone (React doesn't know about them) — clear them now so stale numbers from the
    // previous mu don't linger while the new mu's data loads.
    document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((el) => el.remove());

    try {
      const raw = await browser.runtime.sendMessage({
        type: "WARERA_INTEL_FETCH",
        endpoint: "mu.getById",
        params: { muId },
      });
      const payload = raw?.result?.data ?? raw;
      state.payload = payload ?? null;
      state.rankings = payload?.rankings ?? null;
    } catch (err) {
      console.error("[WarEra Ops] failed to fetch mu data", err);
      state.rankings = null;
      state.payload = null;
    } finally {
      state.fetching = false;
      tryInject();
    }
  }

  function tryInject() {
    if (!active || !window.WarEraOps.isEnabled()) return;

    const muId = extractMuId();
    if (!muId) return;

    if (muId !== state.muId) {
      ensureRankingsFetched(muId);
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

    const missingRankingKeys = Object.keys(state.rankings).filter(
      (key) => ALLOWED_RANKING_KEYS.has(key) && !existingKeys.has(key)
    );
    const missingExtraKeys = EXTRA_TILES.filter(
      (extra) => extra.getValue() !== undefined && !existingKeys.has(extra.key)
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
      grid.appendChild(buildTile(reference, key, { value: extra.getValue() }, palette));
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
    state.muId = null;
    state.rankings = undefined;
    state.payload = null;
    state.fetching = false;

    // WarEra re-renders this grid client-side (route changes, live data refreshes),
    // which can wipe our injected nodes since React doesn't know about them — watch and re-add.
    observer = new MutationObserver(scheduleInject);
    observer.observe(document.body, { childList: true, subtree: true });

    lastPath = location.pathname;
    pollInterval = setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        state.muId = null;
        state.rankings = undefined;
        state.payload = null;
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
    document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((el) => el.remove());
    state.muId = null;
    state.rankings = undefined;
    state.payload = null;
    state.fetching = false;
  }

  window.WarEraOps.registerFeature({ name: "muRankings", activate, deactivate });
})();
