// Feature: adds a few specific rankings.*/top-level stats to the country page's rankings grid,
// plus a small "(proxy of X)" badge next to the country's own name when it's currently flagged
// as a proxy/puppet country (see BACKEND_API.md's countries/proxy entry — same whitelist-gated
// backend the tax tiles below already use). Structurally the same tile-clone approach as
// rankings.js (user page) — kept as a separate file rather than a shared engine since the two
// pages differ in enough specifics (tooltip support, allowed keys, endpoint/params) that a shared
// abstraction wasn't worth the risk of touching the already-working user-page feature. If a third
// page type shows up, this is the point to extract a common engine.
(function () {
  const RANK_HREF_PREFIX = "/rankings/countries?rank=";
  const MARKER_ATTR = "data-warera-ops-country-tile";
  const PROXY_BADGE_ATTR = "data-warera-ops-proxy-badge";
  const PREFERRED_TEMPLATE_HREF = `${RANK_HREF_PREFIX}countryDamages`;
  const BADGE_BASE_CLASSES = ["chnava4", "chnavau"]; // shared by every tile's rank badge, unlike the tier-color class

  // Only these rankings.* keys get added, even though the API may expose more than the game
  // renders (e.g. countryWealth) — this page was asked for specific stats, not "everything missing".
  const ALLOWED_RANKING_KEYS = new Set(["countryRegionDiff", "countryBounty"]);

  // Simple "$" coin glyph, stroke-based like the rest of these icons — shared by
  // all three tax tiles, differentiated by label/tooltip only.
  const TAX_ICON = `<circle cx="12" cy="12" r="9"></circle><line x1="12" y1="7" x2="12" y2="17"></line><path d="M15 9.5c0-1.5-1.3-2.5-3-2.5s-3 1-3 2.2c0 1.1.9 1.6 2 1.9l2 .5c1.1.3 2 .8 2 1.9 0 1.2-1.3 2.2-3 2.2s-3-1-3-2.5"></path>`;

  const ICONS = {
    countryBounty: `<circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="5"></circle><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"></circle>`,
    countryRegionDiff: `<path d="M12 3l9 18H3z"></path>`,
    currentPopulation: `<path d="M12,5.5A3.5,3.5 0 0,1 15.5,9A3.5,3.5 0 0,1 12,12.5A3.5,3.5 0 0,1 8.5,9A3.5,3.5 0 0,1 12,5.5M5,8C5.56,8 6.08,8.15 6.53,8.42C6.38,9.85 6.8,11.27 7.66,12.38C7.16,13.34 6.16,14 5,14A3,3 0 0,1 2,11A3,3 0 0,1 5,8M19,8A3,3 0 0,1 22,11A3,3 0 0,1 19,14C17.84,14 16.84,13.34 16.34,12.38C17.2,11.27 17.62,9.85 17.47,8.42C17.92,8.15 18.44,8 19,8M5.5,18.25C5.5,16.18 8.41,14.5 12,14.5C15.59,14.5 18.5,16.18 18.5,18.25V20H5.5V18.25M0,20V18.5C0,17.11 1.89,15.94 4.45,15.6C3.86,16.28 3.5,17.22 3.5,18.25V20H0M24,20H20.5V18.25C20.5,17.22 20.14,16.28 19.55,15.6C22.11,15.94 24,17.11 24,18.5V20Z" fill="currentColor" stroke="none"></path>`,
    taxDaily: TAX_ICON,
    taxWeekly: TAX_ICON,
    taxMonthly: TAX_ICON,
  };
  const DEFAULT_ICON = `<circle cx="12" cy="12" r="9"></circle><path d="M12 7v6l4 2"></path>`;

  const LABELS = {
    countryBounty: "Country Bounty",
    countryRegionDiff: "Region Diff",
    currentPopulation: "Current Population",
    taxDaily: "Daily Tax",
    taxWeekly: "Weekly Tax",
    taxMonthly: "Monthly Tax",
  };

  // currentPopulation/tax tiles aren't real leaderboard categories — clicking shouldn't navigate.
  const NON_NAVIGABLE_KEYS = new Set(["currentPopulation", "taxDaily", "taxWeekly", "taxMonthly"]);

  // Tiles with no rank/tier of their own instead borrow the color of whichever
  // real, currently-visible tile is named here.
  const COLOR_SOURCE_KEY = {
    currentPopulation: "countryActivePopulation",
    taxDaily: "countryBounty",
    taxWeekly: "countryBounty",
    taxMonthly: "countryBounty",
  };

  // Backend-derived tax revenue (see BACKEND_API.md's countries/tax entry) —
  // proprietary data WarEra's own API doesn't expose, so unlike everything
  // else on this page it needs a whitelist-gated fetch through background.js
  // rather than a plain WARERA_OPS_FETCH. Windows are inclusive of today's
  // still-filling-in bucket, matching the Nigeria bot's /fabrieken command
  // this data also feeds.
  const TAX_WINDOW_DAYS = { taxDaily: 1, taxWeekly: 7, taxMonthly: 30 };
  const TAX_WINDOW_LABEL = { taxDaily: "today", taxWeekly: "over the last 7 days", taxMonthly: "over the last 30 days" };
  const TAX_FIELD = { taxDaily: "d", taxWeekly: "w", taxMonthly: "m" };

  function formatTrackedSince(iso) {
    try {
      return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    } catch (_) {
      return null;
    }
  }

  // Hover text for a tax tile — the "since when do you even store this"
  // context the user asked for, surfaced only where it actually matters
  // (a window not yet fully covered by however long tracking has been running).
  function taxTooltip(key) {
    const startedAt = state.tax?.startedAt;
    if (!startedAt) return null;
    const since = formatTrackedSince(startedAt);
    const windowDays = TAX_WINDOW_DAYS[key];
    const daysTracked = Math.floor((Date.now() - new Date(startedAt).getTime()) / 86_400_000) + 1;
    if (since && daysTracked < windowDays) {
      return `Tax collected ${TAX_WINDOW_LABEL[key]}. Only tracked since ${since} so far ` +
        `(${daysTracked} day${daysTracked === 1 ? "" : "s"} of data) — doesn't cover the full window yet.`;
    }
    return since ? `Tax collected ${TAX_WINDOW_LABEL[key]}. Tracked since ${since}.` : null;
  }

  // Extra stats pulled from top-level payload fields rather than `rankings.*` (no rank/tier data).
  const EXTRA_TILES = [
    { key: "currentPopulation", getValue: () => state.payload?.currentPopulation },
    {
      key: "taxDaily",
      getValue: () => roundOrUndefined(state.tax?.entry?.[TAX_FIELD.taxDaily]),
      getTooltip: () => taxTooltip("taxDaily"),
    },
    {
      key: "taxWeekly",
      getValue: () => roundOrUndefined(state.tax?.entry?.[TAX_FIELD.taxWeekly]),
      getTooltip: () => taxTooltip("taxWeekly"),
    },
    {
      key: "taxMonthly",
      getValue: () => roundOrUndefined(state.tax?.entry?.[TAX_FIELD.taxMonthly]),
      getTooltip: () => taxTooltip("taxMonthly"),
    },
  ];

  function roundOrUndefined(v) {
    return typeof v === "number" ? Math.round(v) : undefined;
  }

  const state = {
    countryId: null,
    rankings: undefined, // undefined = not fetched yet, null = fetched but absent/failed, object once loaded
    payload: null,
    fetching: false,
    // undefined = not fetched yet, null = fetched but no data for this country (or logged out/failed),
    // { startedAt, entry: { d, w, m } } once loaded.
    tax: undefined,
    // undefined = not fetched yet, null = fetched but this country isn't currently a proxy (or
    // logged out/failed), { originId, originName } once loaded — see fetchProxy.
    proxy: undefined,
  };

  let active = false;
  let observer = null;
  let pollInterval = null;
  let lastPath = null;
  let scheduled = false;

  function extractCountryId() {
    const match = location.pathname.match(/\/country\/([a-fA-F0-9]{24})/);
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

  // Same idea as the user page: read each tier's real color/icon straight off whichever real
  // tile currently has that tier, matched against the rankings we just fetched.
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
      if (stat?.tooltip) tile.title = stat.tooltip;
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
      console.error("[WarEra Ops] country tile structure did not match expectations", err);
    }

    return tile;
  }

  // Tax revenue — whitelist-gated backend call, kept separate from the public
  // rankings fetch below so a slow/failing/logged-out backend never blocks
  // the tiles that don't need it. "not_logged_in" (and any other failure) is
  // just treated as "no tax data" — the tiles simply don't appear, same as a
  // country with nothing collected, rather than showing an error.
  async function fetchTax(countryId) {
    try {
      const data = await browser.runtime.sendMessage({
        type: "WARERA_OPS_AUTHED_FETCH",
        path: "/api/ext/countries/tax",
        method: "GET",
      });
      const entry = data?.countries?.[countryId];
      state.tax = entry ? { startedAt: data.startedAt || null, entry } : null;
    } catch (err) {
      state.tax = null; // not logged in / not whitelisted / network failure — feature just doesn't show
    }
  }

  // Proxy/puppet-country detection — same whitelist-gated backend as fetchTax above (see
  // BACKEND_API.md's countries/proxy entry). The endpoint only returns the origin's country id,
  // not a display name, so a country actually flagged as a proxy needs one extra (public, not
  // gated) country.getCountryById call to resolve that id to a name for the badge.
  async function fetchProxy(countryId) {
    try {
      const data = await browser.runtime.sendMessage({
        type: "WARERA_OPS_AUTHED_FETCH",
        path: "/api/ext/countries/proxy",
        method: "GET",
      });
      const entry = data?.[countryId];
      if (!entry?.o) { state.proxy = null; return; }
      const originResult = await browser.runtime.sendMessage({
        type: "WARERA_OPS_FETCH",
        endpoint: "country.getCountryById",
        params: { countryId: entry.o },
      });
      const originPayload = originResult?.result?.data ?? originResult;
      state.proxy = { originId: entry.o, originName: originPayload?.name || null };
    } catch (err) {
      state.proxy = null; // not logged in / not whitelisted / network failure — badge just doesn't show
    }
  }

  async function ensureRankingsFetched(countryId) {
    if (state.countryId === countryId && state.rankings !== undefined) return;
    if (state.fetching) return;
    state.fetching = true;
    state.countryId = countryId;
    state.rankings = undefined;
    state.payload = null;
    state.tax = undefined;
    state.proxy = undefined;

    // WarEra's client-side router swaps the grid's real tiles but leaves our injected ones
    // alone (React doesn't know about them) — clear them now so stale numbers from the
    // previous country don't linger while the new country's data loads.
    document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((el) => el.remove());
    document.querySelectorAll(`[${PROXY_BADGE_ATTR}]`).forEach((el) => el.remove());

    try {
      const [rankingsResult] = await Promise.allSettled([
        browser.runtime.sendMessage({
          type: "WARERA_OPS_FETCH",
          endpoint: "country.getCountryById",
          params: { countryId },
        }),
        fetchTax(countryId), // sets state.tax itself; failure here shouldn't fail the rankings fetch
        fetchProxy(countryId), // sets state.proxy itself; same reasoning
      ]);
      if (rankingsResult.status === "fulfilled") {
        const payload = rankingsResult.value?.result?.data ?? rankingsResult.value;
        state.payload = payload ?? null;
        state.rankings = payload?.rankings ?? null;
      } else {
        throw rankingsResult.reason;
      }
    } catch (err) {
      console.error("[WarEra Ops] failed to fetch country data", err);
      state.rankings = null;
      state.payload = null;
    } finally {
      state.fetching = false;
      tryInject();
    }
  }

  // Anchored on the "Country" label text (a real English string) rather than a hashed/generic
  // class, same idiom battle-money-totals.js's findLeaderboardContainer() already established for
  // this exact kind of fragility. The label's own row isn't guaranteed to sit a fixed number of
  // levels above its sibling (WarEra can insert wrapper divs), so climb up through however many
  // ancestors have no next sibling of their own until reaching the one that does — that's the row
  // holding the actual name.
  function findCountryNameSpan() {
    const label = Array.from(document.querySelectorAll("span")).find(
      (s) => s.children.length === 0 && s.textContent.trim() === "Country"
    );
    if (!label) return null;
    let row = label.parentElement;
    while (row && row.parentElement && !row.nextElementSibling) row = row.parentElement;
    const nameRow = row && row.nextElementSibling;
    return nameRow ? nameRow.querySelector("span") : null;
  }

  function injectProxyBadge() {
    document.querySelectorAll(`[${PROXY_BADGE_ATTR}]`).forEach((el) => el.remove());
    if (!state.proxy) return; // not a proxy, not logged in, still loading, or failed

    const nameSpan = findCountryNameSpan();
    if (!nameSpan || !nameSpan.parentElement) return;

    const originName = state.proxy.originName || "?";
    const badge = document.createElement("a");
    badge.setAttribute(PROXY_BADGE_ATTR, "1");
    badge.href = `/country/${state.proxy.originId}`;
    badge.textContent = `(proxy of ${originName})`;
    badge.title = `${nameSpan.textContent.trim()} is currently a proxy of ${originName} — most of ` +
      "its recent citizens immigrated from there.";
    // Match the country name's actual rendered size exactly (read live) rather than an em
    // guess relative to some ancestor — the name's own class may set a font-size that doesn't
    // match what this element would otherwise inherit.
    const nameFontSize = getComputedStyle(nameSpan).fontSize;
    Object.assign(badge.style, {
      marginLeft: "10px", fontSize: nameFontSize, fontWeight: "500", opacity: "1.0",
      textDecoration: "none", verticalAlign: "middle", whiteSpace: "nowrap",
    });
    nameSpan.parentElement.appendChild(badge);
  }

  function tryInject() {
    if (!active || !window.WarEraOps.isEnabled()) return;

    const countryId = extractCountryId();
    if (!countryId) return;

    if (countryId !== state.countryId) {
      ensureRankingsFetched(countryId);
      return;
    }
    injectProxyBadge(); // independent of the rankings grid below — show/hide regardless of its state
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
      const tooltip = extra.getTooltip ? extra.getTooltip() : undefined;
      grid.appendChild(buildTile(reference, key, { value: extra.getValue(), tooltip }, palette));
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
    state.countryId = null;
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
        state.countryId = null;
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
    document.querySelectorAll(`[${PROXY_BADGE_ATTR}]`).forEach((el) => el.remove());
    state.countryId = null;
    state.rankings = undefined;
    state.payload = null;
    state.fetching = false;
  }

  window.WarEraOps.registerFeature({ name: "countryRankings", activate, deactivate });
})();
