// Feature: on a battle page, when the leaderboard is showing money, adds a "Total" tile above
// each side's list with the true total money earned — pulled from battleRanking.getRanking
// (dataType: "money") rather than summing the DOM, since the page only ever renders whatever's
// been loaded via "Show more" and a DOM sum would silently be partial.
//
// The tile follows whichever Round #N / Battle tab is currently selected — confirmed against
// WarEra's own network traffic that a round-scoped query is `{side, roundId, type, dataType}`
// with NO battleId, while the battle-wide query is `{battleId, dataType, type, side}` with no
// roundId; sending both together returns zero results (round-scoped ranking records apparently
// aren't also tagged with their battle). Round IDs themselves aren't in the DOM anywhere — they
// come from battle.getById's `rounds` array, matched to "Round #N" by position (rounds[0] = #1).
(function () {
  const MARKER_ATTR = "data-warera-ops-battle-total";
  const MAX_PAGES = 200; // safety cap in case pagination never terminates
  const REQUEST_SPACING_MS = 600;

  // Which (battleId, roundId) the user is actually looking at right now — set at the top of
  // sync() on every pass. A pagination sweep for a tab the user has since switched away from
  // checks this and bails instead of continuing to burn through the rate limit for a total that's
  // no longer even going to be shown.
  let activeSelectionKey = null;
  const ABORTED = Symbol("aborted-stale-selection");

  // Summing a big battle's round can take dozens of paginated requests (see fetchSideTotal), and
  // both sides get summed at once — fired with no pacing, that reliably bursts past whatever
  // rate limit WarEra enforces (confirmed live: a 429 hit all five api*.warera.io hosts at once,
  // including an unrelated feature's request). Routing every call through this queue keeps our
  // own requests serialized with a floor between them, regardless of how many totals are being
  // computed at once.
  //
  // On top of that fixed floor, a 429 also opens a backoff window that EVERY future call (not
  // just the one that got rate-limited) waits out before sending anything — pacing alone still
  // retries into the same limit if the server wants a longer break than REQUEST_SPACING_MS gives
  // it. The window doubles on each consecutive 429 (capped) and resets once a request succeeds.
  const BASE_BACKOFF_MS = 15_000;
  const MAX_BACKOFF_MS = 120_000;
  let backoffMs = BASE_BACKOFF_MS;
  let rateLimitedUntil = 0;

  function isRateLimited() {
    return Date.now() < rateLimitedUntil;
  }

  function rateLimitSecondsLeft() {
    return Math.max(0, Math.ceil((rateLimitedUntil - Date.now()) / 1000));
  }

  function isRateLimitError(err) {
    return typeof err?.message === "string" && /\b429\b/.test(err.message);
  }

  let requestQueue = Promise.resolve();
  function queuedApiCall(endpoint, params) {
    const run = async () => {
      const wait = rateLimitedUntil - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      try {
        const result = await browser.runtime.sendMessage({ type: "WARERA_OPS_FETCH", endpoint, params });
        backoffMs = BASE_BACKOFF_MS; // healthy again — forget any prior escalation
        return result;
      } catch (err) {
        if (isRateLimitError(err)) {
          rateLimitedUntil = Date.now() + backoffMs;
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
          scheduleSync(); // let the tile show the rate-limited message right away
        }
        throw err;
      }
    };
    const result = requestQueue.then(run, run);
    requestQueue = result
      .catch(() => {})
      .then(() => new Promise((resolve) => setTimeout(resolve, REQUEST_SPACING_MS)));
    return result;
  }
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
  //
  // The leaderboard itself isn't a fixed number of levels above the button — WarEra now groups
  // the By-side/Overall toggle together with a couple of icon-filter rows inside a shared toolbar
  // block, so the wrapper immediately around the toggle no longer sits right next to the
  // leaderboard. Climb up through however many ancestors have no next sibling of their own (i.e.
  // are the last thing in whatever they're grouped with) until reaching the one that does — that's
  // the leaderboard, right after the whole toolbar block ends.
  function findLeaderboardContainer() {
    const tabButton = Array.from(document.querySelectorAll("button")).find((b) => {
      const text = b.textContent.trim();
      return text === "By side" || text === "Overall";
    });
    if (!tabButton) return null;
    let node = tabButton.parentElement;
    while (node && node.parentElement && !node.nextElementSibling) {
      node = node.parentElement;
    }
    return node?.nextElementSibling || null;
  }

  // Which of the "Round #N" / "Battle" tabs is currently selected. There's no aria-selected (or
  // any other state attribute) on these buttons — WarEra styles the active one with a distinct
  // class combination from the others, who all share one identical classList with each other. So
  // the active tab is whichever button's classList doesn't match any other button's; if that's
  // not unambiguous (0 or 2+ candidates), don't guess — treat it as "no round selected".
  function findActiveRoundTab() {
    const buttons = Array.from(document.querySelectorAll("button")).filter((b) => {
      const t = b.textContent.trim();
      return /^Round #\d+$/.test(t) || t === "Battle";
    });
    if (buttons.length < 2) return null; // 1-round battles may show no tab bar at all

    const classKey = (b) => Array.from(b.classList).sort().join(" ");
    const keys = buttons.map(classKey);
    const unique = buttons.filter((b, i) => keys.filter((k) => k === keys[i]).length === 1);
    if (unique.length !== 1) return null;

    const label = unique[0].textContent.trim();
    if (label === "Battle") return { kind: "battle" };
    const m = label.match(/^Round #(\d+)$/);
    return m ? { kind: "round", roundNumber: Number(m[1]) } : null;
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

  // Sums `value` across every page of the ranking. A failed page used to be swallowed — break out
  // of the loop and return whatever partial sum had accumulated so far, as if that were the real
  // total. That's actively wrong (a 429 on page 1 of 30 would report as "done" with a total that's
  // ~97% too low, and nothing would ever retry it since the promise resolved normally). A failed
  // page now propagates as a real rejection instead, so the caller's retry-with-cooldown logic
  // actually gets a chance to run.
  async function fetchSideTotal(battleId, roundId, type, side, selectionKey, onProgress) {
    let cursor;
    let total = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      // The user has since switched to a different round/battle tab — this sweep's result is no
      // longer wanted, so stop spending request budget (and rate-limit risk) on it.
      if (selectionKey !== activeSelectionKey) throw ABORTED;

      // battleId and roundId are mutually exclusive on this endpoint (confirmed against WarEra's
      // own requests) — sending both returns zero results. limit:100 is the server's documented
      // max (confirmed via a "too_big" validation error above it) — a big battle's round can have
      // ~2800 entries, and without this the default ~20/page means ~140 requests just to sum one
      // side of one round, which reliably triggers WarEra's rate limiting when both sides (or
      // multiple rounds) are summed close together.
      const params = roundId
        ? { side, roundId, type, dataType: "money", limit: 100 }
        : { battleId, dataType: "money", type, side, limit: 100 };
      if (cursor) params.cursor = cursor;
      const raw = await queuedApiCall("battleRanking.getRanking", params);
      const payload = raw?.result?.data ?? raw;

      const items = payload?.items ?? [];
      for (const item of items) {
        if (typeof item.value === "number") total += item.value;
      }
      // A round can take dozens of requests (and, if a 429 slips in, tens of seconds) to fully
      // sum — surfacing the running total as it grows shows the tile is actively progressing
      // rather than stuck, instead of leaving a bare "Loading…" up the whole time.
      onProgress?.(total);
      if (!payload?.nextCursor || items.length === 0) break;
      cursor = payload.nextCursor;
    }
    return total;
  }

  const RETRY_COOLDOWN_MS = 5000; // don't hammer the API, but don't freeze on one bad fetch forever

  const cache = new Map(); // `${battleId}|${roundId}|${type}|${side}` -> { status, total, retryAfter }

  function getSideTotal(battleId, roundId, type, side) {
    const key = `${battleId}|${roundId || "all"}|${type}|${side}`;
    let entry = cache.get(key);
    // A failed fetch used to stick around forever (no code path ever re-fetched it) — one transient
    // hiccup would permanently freeze the tile at "Error"/stale-zero for the rest of the page's
    // life. Retrying after a cooldown instead of never lets it self-heal. While a global rate-limit
    // backoff is active, don't even try — that would just flip the tile to "Loading…" for a
    // request that's actually parked in the queue, hiding the rate-limited countdown for no reason.
    if (!entry || (entry.status === "error" && Date.now() > entry.retryAfter && !isRateLimited())) {
      entry = { status: "loading", total: null, partial: 0, retryAfter: 0 };
      cache.set(key, entry);
      fetchSideTotal(battleId, roundId, type, side, activeSelectionKey, (partial) => {
        entry.partial = partial;
        scheduleSync();
      })
        .then((total) => {
          entry.status = "done";
          entry.total = total;
          scheduleSync();
        })
        .catch((err) => {
          if (err === ABORTED) {
            // Not a real failure — the user moved on before this finished. Drop the entry rather
            // than marking it "error" (with a retry cooldown) or "done" (with a wrong number) —
            // a later visit to this same tab just starts a clean sweep.
            if (cache.get(key) === entry) cache.delete(key);
            return;
          }
          console.error("[WarEra Ops] failed to fetch battle money ranking", err);
          entry.status = "error";
          entry.retryAfter = Date.now() + RETRY_COOLDOWN_MS;
          scheduleSync();
        });
    }
    return entry;
  }

  const battleRoundsCache = new Map(); // battleId -> { status, rounds: [id, ...] in round order }

  // battle.getById's `rounds` array gives the round ObjectIds in order (rounds[0] = "Round #1",
  // etc.) — nothing in the DOM exposes them, the tab buttons only show the human label.
  function getBattleRounds(battleId) {
    let entry = battleRoundsCache.get(battleId);
    if (!entry || (entry.status === "error" && Date.now() > entry.retryAfter && !isRateLimited())) {
      entry = { status: "loading", rounds: [], retryAfter: 0 };
      battleRoundsCache.set(battleId, entry);
      queuedApiCall("battle.getById", { battleId })
        .then((raw) => {
          const data = raw?.result?.data ?? raw;
          entry.status = "done";
          entry.rounds = Array.isArray(data?.rounds) ? data.rounds : [];
          scheduleSync();
        })
        .catch((err) => {
          console.error("[WarEra Ops] failed to fetch battle rounds", err);
          entry.status = "error";
          entry.retryAfter = Date.now() + RETRY_COOLDOWN_MS;
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

  function renderTileValue(tile, total, isError, partial) {
    const valueSpan = findMoneyValueSpan(tile);
    if (!valueSpan) return;
    if (isError) valueSpan.textContent = isRateLimited() ? `Rate limited (${rateLimitSecondsLeft()}s)` : "Error";
    else if (total == null) {
      valueSpan.textContent = partial > 0 ? `Loading… (${formatMoney(partial)} so far)` : "Loading…";
    } else valueSpan.textContent = formatMoney(total);
  }

  function buildTotalTile(sampleRow, total, isError, partial) {
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

    renderTileValue(tile, total, isError, partial);
    return tile;
  }

  function syncColumn(columnEl, battleId, roundId, sides) {
    const rowContainer = findRowContainer(columnEl);
    const existing = Array.from(rowContainer.children).find((c) => c.hasAttribute(MARKER_ATTR));

    if (!sides || !columnShowsMoney(columnEl)) {
      existing?.remove(); // not viewing money right now — don't leave a stale total
      return;
    }

    const type = detectType(columnEl);
    if (!type) return;

    const entries = sides.map((side) => getSideTotal(battleId, roundId, type, side));
    const anyError = entries.some((e) => e.status === "error");
    const allDone = entries.every((e) => e.status === "done");
    const total = allDone ? entries.reduce((sum, e) => sum + e.total, 0) : null;
    // Sum whatever each side has accumulated so far — done sides contribute their final total,
    // still-loading ones contribute their running partial — so the tile can show visible progress
    // instead of a bare "Loading…" for however long a big round's pagination takes.
    const partial = entries.reduce((sum, e) => sum + (e.status === "done" ? e.total : e.partial || 0), 0);

    // The rate-limited countdown and the streaming partial total both need to force a re-render
    // on every change, even though "still loading"/"still rate-limited" itself hasn't changed.
    const statusKey = anyError
      ? isRateLimited()
        ? `wait${rateLimitSecondsLeft()}`
        : "error"
      : total != null
        ? `done${total}`
        : `loading${Math.round(partial)}`;
    const displayKey = `${type}|${roundId || "all"}|${sides.join(",")}|${statusKey}`;
    if (existing) {
      if (existing.dataset.wiKey !== displayKey) {
        renderTileValue(existing, total, anyError, partial);
        existing.dataset.wiKey = displayKey;
      }
      return;
    }

    const sampleRow = findSampleMoneyRow(rowContainer);
    if (!sampleRow) return;
    const tile = buildTotalTile(sampleRow, total, anyError, partial);
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

    let roundId = null;
    const activeTab = findActiveRoundTab();
    if (activeTab?.kind === "round") {
      const rounds = getBattleRounds(battleId);
      if (rounds.status === "loading") return; // battle.getById not back yet — try again once it is
      roundId = rounds.rounds[activeTab.roundNumber - 1] || null;
    }
    activeSelectionKey = `${battleId}|${roundId || "all"}`;

    const columns = findColumns(leaderboard);
    const headers = findHeaderLabels(leaderboard);

    if (columns.length >= 2) {
      columns.forEach((column, i) => {
        const label = headers[i];
        const side = label === "Attackers" ? "attacker" : label === "Defenders" ? "defender" : null;
        syncColumn(column, battleId, roundId, side ? [side] : null);
      });
    } else if (columns.length === 1) {
      syncColumn(columns[0], battleId, roundId, ["attacker", "defender"]);
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
          battleRoundsCache.clear();
        }
        document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((el) => el.remove());
        scheduleSync();
      } else if (isRateLimited()) {
        // Nothing on the page needs to mutate for the countdown to tick down or for a retry to
        // fire once the backoff window closes — nudge it explicitly instead of waiting on an
        // unrelated DOM mutation to happen to trigger the observer.
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
