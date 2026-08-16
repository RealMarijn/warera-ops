// Feature: on a battle page, when the leaderboard is showing money, adds a "Total" tile above
// each side's list with the true total money earned — pulled from battleRanking.getRanking
// (dataType: "money") rather than summing the DOM, since the page only ever renders whatever's
// been loaded via "Show more" and a DOM sum would silently be partial. The battle-wide total is
// used regardless of which round tab is selected (battleId only, no roundId).
(function () {
  const MARKER_ATTR = "data-warera-ops-battle-total";
  const MAX_PAGES = 200; // safety cap in case pagination never terminates
  const MONEY_PATH_PREFIX = "M12 5C7.031 5 2 6.546 2 9.5S7.031 14"; // WarEra's "money" coin glyph

  function isBattlePage() {
    return /\/battle\/[a-fA-F0-9]{24}/.test(location.pathname);
  }

  function extractBattleId() {
    const match = location.pathname.match(/\/battle\/([a-fA-F0-9]{24})/);
    return match ? match[1] : null;
  }

  function isMoneyPath(d) {
    return !!d && d.startsWith(MONEY_PATH_PREFIX);
  }

  // Anchored on the "By side"/"Overall" button text (real English strings) rather than a
  // hashed/generic class, so this can't accidentally match unrelated widgets elsewhere on the
  // page (e.g. the bottom-left "world battles" ticker, which shows the same coin icon).
  function findLeaderboardContainer() {
    const tabButton = Array.from(document.querySelectorAll("button")).find((b) => {
      const text = b.textContent.trim();
      return text === "By side" || text === "Overall";
    });
    return tabButton?.parentElement?.nextElementSibling || null;
  }

  function findColumns(leaderboardContainer) {
    const gridWrapper = leaderboardContainer.firstElementChild;
    const divs = gridWrapper
      ? Array.from(gridWrapper.children).filter((el) => el.tagName === "DIV")
      : [];
    if (divs.length > 0) return divs;
    return Array.from(leaderboardContainer.querySelectorAll('div[style*="width: 100%"]'));
  }

  // In 2-column "By side" mode, the grid's <span> headers ("Defenders"/"Attackers") and <div>
  // columns share the same order — first header pairs with first column, etc.
  function findHeaderLabels(leaderboardContainer) {
    const gridWrapper = leaderboardContainer.firstElementChild;
    if (!gridWrapper) return [];
    return Array.from(gridWrapper.children)
      .filter((el) => el.tagName === "SPAN")
      .map((el) => el.textContent.trim());
  }

  function columnShowsMoney(columnEl) {
    return Array.from(columnEl.querySelectorAll("div.a6izou0 svg path")).some((p) =>
      isMoneyPath(p.getAttribute("d"))
    );
  }

  // Which profile type (user/country/mu) the leaderboard is currently showing — read from the
  // rows' own links rather than guessed from a selected-tab class.
  function detectType(columnEl) {
    const link = columnEl.querySelector('a[href^="/user/"], a[href^="/country/"], a[href^="/mu/"]');
    const href = link?.getAttribute("href") || "";
    if (href.startsWith("/user/")) return "user";
    if (href.startsWith("/country/")) return "country";
    if (href.startsWith("/mu/")) return "mu";
    return null;
  }

  function isMoneyRow(el) {
    if (el.hasAttribute(MARKER_ATTR)) return false;
    const hasMoney = Array.from(el.querySelectorAll("div.a6izou0 svg path")).some((p) =>
      isMoneyPath(p.getAttribute("d"))
    );
    const hasProfile = el.querySelector('a[href^="/user/"], a[href^="/country/"], a[href^="/mu/"]');
    return hasMoney && !!hasProfile;
  }

  // The `width: 100%` column div isn't itself the row list — it wraps a single inner div whose
  // *direct children* are the actual rows. isMoneyRow() can't tell "is one row" from "contains
  // many rows" (querySelectorAll searches the whole subtree either way), so that signal is no
  // good for finding this boundary. What does distinguish them structurally: a pure pass-through
  // wrapper has exactly one child, while the real row list has many (every row plus "Show more")
  // — so just descend through single-child levels until hitting one that doesn't.
  function findRowContainer(columnEl) {
    let node = columnEl;
    while (node && node.children.length === 1) {
      node = node.firstElementChild;
    }
    return node || columnEl;
  }

  function findSampleMoneyRow(rowContainer) {
    return Array.from(rowContainer.children).find(isMoneyRow) || null;
  }

  function formatMoney(value) {
    const abs = Math.abs(value);
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/0$/, "").replace(/\.$/, "")}M`;
    if (abs >= 1_000) return `${(value / 1_000).toFixed(2).replace(/0$/, "").replace(/\.$/, "")}K`;
    return `${Math.round(value * 1000) / 1000}`;
  }

  // Sums `value` across every page of the ranking. If pagination stops working partway through
  // (the endpoint's documented schema doesn't actually list "cursor" as an accepted param, so
  // this is unverified against the live API), whatever was summed so far is kept and logged
  // rather than treated as a hard failure.
  async function fetchSideTotal(battleId, type, side) {
    let cursor;
    let total = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      let payload;
      try {
        const params = { battleId, dataType: "money", type, side };
        if (cursor) params.cursor = cursor;
        const raw = await browser.runtime.sendMessage({
          type: "WARERA_OPS_FETCH",
          endpoint: "battleRanking.getRanking",
          params,
        });
        payload = raw?.result?.data ?? raw;
      } catch (err) {
        console.error(
          `[WarEra Ops] battleRanking.getRanking paging stopped early (battle ${battleId}, ${type}/${side}); total may be partial`,
          err
        );
        break;
      }

      const items = payload?.items ?? [];
      for (const item of items) {
        if (typeof item.value === "number") total += item.value;
      }
      if (!payload?.nextCursor || items.length === 0) break;
      cursor = payload.nextCursor;
    }
    return total;
  }

  const cache = new Map(); // `${battleId}|${type}|${side}` -> { status, total }

  function getSideTotal(battleId, type, side) {
    const key = `${battleId}|${type}|${side}`;
    let entry = cache.get(key);
    if (!entry) {
      entry = { status: "loading", total: null };
      cache.set(key, entry);
      fetchSideTotal(battleId, type, side)
        .then((total) => {
          entry.status = "done";
          entry.total = total;
          scheduleSync();
        })
        .catch((err) => {
          console.error("[WarEra Ops] failed to fetch battle money ranking", err);
          entry.status = "error";
          scheduleSync();
        });
    }
    return entry;
  }

  function findMoneyValueSpan(scope) {
    const holder = Array.from(scope.querySelectorAll("div.a6izou0")).find((h) => {
      const path = h.querySelector("svg path");
      return path && isMoneyPath(path.getAttribute("d"));
    });
    return holder?.parentElement?.querySelector("span.agd9b40") || null;
  }

  function renderTileValue(tile, total, isError) {
    const valueSpan = findMoneyValueSpan(tile);
    if (!valueSpan) return;
    if (isError) valueSpan.textContent = "Error";
    else if (total == null) valueSpan.textContent = "…";
    else valueSpan.textContent = formatMoney(total);
  }

  function buildTotalTile(sampleRow, total, isError) {
    const tile = sampleRow.cloneNode(true);
    tile.setAttribute(MARKER_ATTR, "true");

    const rankDiv = Array.from(tile.querySelectorAll("div")).find(
      (d) => d.children.length === 0 && /^\d+$/.test(d.textContent.trim())
    );
    if (rankDiv) rankDiv.textContent = "Σ";

    const avatarImg = tile.querySelector("img[alt]");
    avatarImg?.closest("a")?.parentElement?.remove();

    const nameLink = tile.querySelector('a[href^="/country/"], a[href^="/user/"], a[href^="/mu/"]');
    if (nameLink) {
      nameLink.removeAttribute("href");
      const nameSpan = nameLink.querySelector("span");
      if (nameSpan) nameSpan.textContent = "Total";

      // Status badges (president/congress/etc.) sit as siblings of the name link's own wrapper,
      // inside a shared parent — strip whatever's there rather than special-casing each badge.
      const nameWrapper = nameLink.closest('[aria-haspopup="dialog"]');
      const badgesParent = nameWrapper?.parentElement;
      if (badgesParent) {
        Array.from(badgesParent.children).forEach((child) => {
          if (child !== nameWrapper) child.remove();
        });
      }
    }

    renderTileValue(tile, total, isError);
    return tile;
  }

  function syncColumn(columnEl, battleId, sides) {
    const rowContainer = findRowContainer(columnEl);
    const existing = Array.from(rowContainer.children).find((c) => c.hasAttribute(MARKER_ATTR));

    if (!sides || !columnShowsMoney(columnEl)) {
      existing?.remove(); // not viewing money right now — don't leave a stale total
      return;
    }

    const type = detectType(columnEl);
    if (!type) return;

    const entries = sides.map((side) => getSideTotal(battleId, type, side));
    const anyError = entries.some((e) => e.status === "error");
    const allDone = entries.every((e) => e.status === "done");
    const total = allDone ? entries.reduce((sum, e) => sum + e.total, 0) : null;

    const displayKey = `${type}|${sides.join(",")}|${anyError ? "error" : total}`;
    if (existing) {
      if (existing.dataset.wiKey !== displayKey) {
        renderTileValue(existing, total, anyError);
        existing.dataset.wiKey = displayKey;
      }
      return;
    }

    const sampleRow = findSampleMoneyRow(rowContainer);
    if (!sampleRow) return;
    const tile = buildTotalTile(sampleRow, total, anyError);
    tile.dataset.wiKey = displayKey;
    rowContainer.insertBefore(tile, rowContainer.firstElementChild);
  }

  function sync() {
    if (!active || !window.WarEraOps.isEnabled()) return;

    if (!isBattlePage()) {
      document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((el) => el.remove());
      return;
    }

    const battleId = extractBattleId();
    const leaderboard = findLeaderboardContainer();
    if (!battleId || !leaderboard) return;

    const columns = findColumns(leaderboard);
    const headers = findHeaderLabels(leaderboard);

    if (columns.length >= 2) {
      columns.forEach((column, i) => {
        const label = headers[i];
        const side = label === "Attackers" ? "attacker" : label === "Defenders" ? "defender" : null;
        syncColumn(column, battleId, side ? [side] : null);
      });
    } else if (columns.length === 1) {
      syncColumn(columns[0], battleId, ["attacker", "defender"]);
    }
  }

  let active = false;
  let observer = null;
  let pollInterval = null;
  let lastPath = null;
  let lastBattleId = null;
  let scheduled = false;

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

    // Round/type/side switches don't change the URL, only the rendered list — the observer is
    // the real trigger here, the path check is just a safety net for navigating between battles.
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
        document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((el) => el.remove());
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
    document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((el) => el.remove());
  }

  window.WarEraOps.registerFeature({ name: "battleMoneyTotals", activate, deactivate });
})();
