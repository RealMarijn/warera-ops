// Feature: on a battle page, shows a concise per-group damage-bonus breakdown next to the game's
// own personal-bonus display for each side ("+63.75%"/"+20%" etc.) — own citizens, allies,
// defensive-pact countries (when applicable), and everyone else — since that native number is
// only ever YOUR own personal bonus, not what other groups in the same battle actually get.
// Hovering a badge shows the complete breakdown, same table rijksoverheid_web's own "Live
// battles" page already renders (Home/Enemy/Pact/Ally/Order/MU-ord/MU-HQ/Upgrade/Revolt/Max per
// group) — this feature just fetches the one battle currently open from that same live snapshot.
// Deliberately NOT whitelist-gated: see BACKEND_API.md's "public backend endpoints" section —
// the exact same data is already public, unauthenticated, on the website itself.
(function () {
  const MARKER_ATTR = "data-warera-ops-battle-bonus";
  const TOOLTIP_ID = "warera-ops-bonus-tooltip";
  // Standard groups every battle side has some subset of — named per-country order rows (e.g. a
  // specific ally that placed an order) are real data but too granular for the concise badge;
  // they only show up in the hover breakdown table, same as on the website.
  const CONCISE_GROUPS = ["Own citizens", "Allies", "Pact countries", "Other"];
  const CONCISE_LABELS = {
    "Own citizens": "Citizens",
    "Allies": "Allies",
    "Pact countries": "Pact",
    "Other": "Other",
  };

  let active = false;
  let observer = null;
  let pollInterval = null;
  let lastPath = null;
  let lastBattleId = null;
  let scheduled = false;
  let fetching = false;
  let data = null; // { attacker: {...}, defender: {...} } for lastBattleId, or null (not loaded/failed)
  let featureEnabled = true; // popup key "battleBonusEnabled" (default on)
  let storageListener = null;

  const FEATURE_KEY = "battleBonusEnabled";

  const esc = (s) => String(s == null ? "" : s).replace(/[<>&"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

  function extractBattleId() {
    const match = location.pathname.match(/\/battle\/([a-fA-F0-9]{24})/);
    return match ? match[1] : null;
  }

  async function ensureFetched(battleId) {
    if (lastBattleId === battleId && data !== null) return;
    if (fetching) return;
    fetching = true;
    lastBattleId = battleId;
    data = null;
    document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((el) => el.remove());
    hideTooltip();
    try {
      const result = await browser.runtime.sendMessage({
        type: "WARERA_OPS_BACKEND_FETCH",
        path: `/api/gevechten/battle/${battleId}/bonus`,
      });
      data = result && result.ok ? result : null;
    } catch (err) {
      data = null; // battle not tracked yet, backend unreachable, etc. — feature just doesn't show
    } finally {
      fetching = false;
      tryInject();
    }
  }

  // Anchored on #attacker-hit-button/#defender-hit-button — WarEra's own stable element ids for
  // the Resist/Defend buttons (confirmed live) — rather than any hashed class. The personal-bonus
  // display (the "+63.75%"/"+20%" text) sits as the PREVIOUS sibling of that button's own wrapper
  // div, both children of the same position:relative column wrapper (confirmed live).
  function findBonusWrapper(side) {
    const btn = document.getElementById(`${side}-hit-button`);
    const btnWrapper = btn && btn.parentElement;
    return (btnWrapper && btnWrapper.previousElementSibling) || null;
  }

  function rowsForConcise(rows) {
    return CONCISE_GROUPS
      .map((g) => (rows || []).find((r) => r.group === g))
      .filter(Boolean);
  }

  // ---- hover tooltip (full breakdown table, same shape as the website's own) ------------------
  let tooltipEl = null;
  function ensureTooltip() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement("div");
    tooltipEl.id = TOOLTIP_ID;
    Object.assign(tooltipEl.style, {
      position: "fixed", zIndex: "2147483647", pointerEvents: "none",
      background: "rgba(20,23,30,0.92)", border: "1px solid rgba(255,255,255,0.14)",
      borderRadius: "10px", padding: "8px 10px", boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
      backdropFilter: "blur(14px) saturate(150%)", WebkitBackdropFilter: "blur(14px) saturate(150%)",
      font: "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, sans-serif",
      color: "#eef0f4", display: "none",
      // A tall table flipped above a low-on-screen anchor could still push its own top past y=0
      // (nothing to flip TO at that point) — capping height and letting it scroll internally means
      // it always fits somewhere on screen instead of just running off the top.
      maxHeight: "calc(100vh - 16px)", overflowY: "auto",
    });
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  function buildTooltipHTML(sideData) {
    const cols = ["Home", "Enemy", "Pact", "Ally.", "Order", "MU-ord*", "MU-HQ*", sideData.upgrade_label + "**", "Revolt", "~Max"];
    const keys = ["home", "enemy", "pact", "alliance", "order", "mu_order", "mu_hq", "upgrade", "revolt"];
    const rows = (sideData.rows || []).map((r) => {
      const cells = keys.map((k) => `<td>${esc(r[k])}</td>`).join("");
      return `<tr><td class="wob-grp">${esc(r.group)}</td>${cells}<td class="wob-max">~${esc(r.max_est)}%</td></tr>`;
    }).join("");
    return `
      <div class="wob-ttl">${esc(sideData.country_name)} — full breakdown</div>
      <table class="wob-table">
        <thead><tr><th></th>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="wob-note">*not everyone — depends on MU orders/HQ. **must be active.</div>
    `;
  }

  const TOOLTIP_CSS = `
    #${TOOLTIP_ID} .wob-ttl { font-weight: 600; margin-bottom: 6px; opacity: 0.85; }
    #${TOOLTIP_ID} table.wob-table { border-collapse: collapse; white-space: nowrap; }
    #${TOOLTIP_ID} table.wob-table th, #${TOOLTIP_ID} table.wob-table td {
      padding: 2px 6px; text-align: right; font-variant-numeric: tabular-nums;
    }
    #${TOOLTIP_ID} table.wob-table th { color: rgba(238,240,244,0.55); font-weight: 500; }
    #${TOOLTIP_ID} table.wob-table td.wob-grp, #${TOOLTIP_ID} table.wob-table th:first-child { text-align: left; }
    #${TOOLTIP_ID} table.wob-table td.wob-max { font-weight: 700; color: #e7b9a5; }
    #${TOOLTIP_ID} .wob-note { margin-top: 6px; font-size: 9.5px; opacity: 0.5; white-space: normal; max-width: 340px; }
  `;
  let cssInjected = false;
  function ensureCSS() {
    if (cssInjected) return;
    const style = document.createElement("style");
    style.textContent = TOOLTIP_CSS;
    document.head.appendChild(style);
    cssInjected = true;
  }

  function showTooltip(anchorEl, sideData) {
    ensureCSS();
    const tip = ensureTooltip();
    tip.innerHTML = buildTooltipHTML(sideData);
    tip.style.display = "block";
    const r = anchorEl.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    let left = r.left;
    if (left + tipRect.width > window.innerWidth - 8) left = window.innerWidth - tipRect.width - 8;
    if (left < 8) left = 8;
    let top = r.bottom + 6;
    if (top + tipRect.height > window.innerHeight - 8) top = r.top - tipRect.height - 6;
    // The flip-above branch just above assumes there's enough room above the anchor — if the
    // tooltip is taller than THAT space too (anchor near the top of the screen, or a very tall
    // table), this still clamps it back on screen rather than letting the top run off past y=0.
    if (top < 8) top = 8;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = "none";
  }

  // ---- concise badge ----------------------------------------------------------------------
  // Row layout normally (matches "to the left/right of the native bonus"), but narrowing the
  // battle window pushes that whole row wider than the viewport with nowhere to wrap — WarEra's
  // own flex row around it doesn't wrap, and overriding that (DOM we don't own) risks breaking
  // its own layout, so instead our own badge switches to a narrow, stacked column below that
  // width, which shrinks its own footprint down to whatever the widest single chip needs.
  const NARROW_BREAKPOINT_PX = 700;
  // WarEra's own "damage bonus" glyph — the exact path its native personal-bonus display (the
  // "+63.75%"/"+20%" numbers) and the round-bar damage-share numbers both already use, added here
  // purely so our own numbers read as the same kind of thing rather than an unmarked plain label.
  const DMG_ICON_SVG = '<svg class="wob-icon" viewBox="0 0 24 24" fill="currentColor">' +
    '<path d="M6.23316 8.59556C6.30214 8.03946 6.39735 6.92211 7.65403 5.34032C9.25423 3.32614 ' +
    '12.9443 1.00678 16.1654 1C8.5369 2.58693 13.5375 16.0826 18.3726 11.8508C19.221 11.0641 ' +
    '17.269 8.59556 17.269 8.59556C18.5037 9.19236 19.9038 9.62639 20.5798 10.7657C21.3109 ' +
    '12.5697 20.5867 15.0993 18.3726 18.3613C19.8004 17.7441 21.2143 17.1202 21.6834 ' +
    '16.1911C22.042 19.0259 22.3041 21.7996 19.4762 22.7016C18.952 22.8169 18.3519 22.9118 ' +
    '17.7036 23C18.2554 21.1215 15.4412 19.4328 16.7862 16.1911C15.8757 16.815 14.6618 ' +
    '16.7133 14.4894 19.0734C13.7858 16.8829 12.8133 14.7466 9.93707 12.9359C10.2613 15.2552 ' +
    '11.0545 18.3748 9.11628 19.4464C7.84716 20.1517 5.79862 18.3613 5.12958 17.6831C5.30891 ' +
    '19.8397 6.36421 21.5758 8.14375 22.7626C5.63998 22.2133 3.59835 21.1893 2.9224 ' +
    '19.4464C1.5912 17.188 1.81882 12.9359 4.02599 10.7657C6.23316 18.8089 7.75059 12.2713 ' +
    '6.23316 8.59556Z"></path></svg>';
  const BADGE_CSS = `
    [${MARKER_ATTR}] { display: inline-flex; flex-direction: row; align-items: center; gap: 5px; margin: 0 6px;
      font: 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, sans-serif;
      cursor: default; vertical-align: middle; }
    [${MARKER_ATTR}] .wob-icon { width: 1em; height: 1em; flex: none; color: #e7b9a5; }
    [${MARKER_ATTR}] .wob-chip { display: inline-flex; align-items: center; gap: 3px;
      padding: 2px 4px; border-radius: 999px;
      color: rgba(238,240,244,0.85); white-space: nowrap; }
    [${MARKER_ATTR}] .wob-chip b { font-weight: 700; color: #e7b9a5; }
    @media (max-width: ${NARROW_BREAKPOINT_PX}px) {
      [${MARKER_ATTR}] { flex-direction: column; align-items: flex-start; gap: 2px; margin: 4px 0; }
    }
  `;
  let badgeCssInjected = false;
  function ensureBadgeCSS() {
    if (badgeCssInjected) return;
    const style = document.createElement("style");
    style.textContent = BADGE_CSS;
    document.head.appendChild(style);
    badgeCssInjected = true;
  }

  function buildConciseBadge(sideData, side) {
    ensureBadgeCSS();
    const badge = document.createElement("span");
    badge.setAttribute(MARKER_ATTR, side);
    let rows = rowsForConcise(sideData.rows);
    // Our badge sits BEFORE the native bonus on the defender side (to its left) but AFTER it on
    // the attacker side (to its right) — reversing the defender's chip order puts "Citizens"
    // last (i.e. nearest the native number, same as it already is on the attacker side, where
    // it's first/nearest) so the most directly-comparable number sits next to the native one on
    // both sides, not just one.
    if (side === "defender") rows = rows.slice().reverse();
    const chips = rows.map((r) =>
      `<span class="wob-chip">${esc(CONCISE_LABELS[r.group])} <b>~${esc(r.max_est)}%</b></span>`
    ).join("");
    // Mirrors the native bonus display's own icon placement: attacker has icon-then-text, so ours
    // leads with the icon too; defender has text-then-icon, so ours trails with it instead.
    badge.innerHTML = side === "defender" ? chips + DMG_ICON_SVG : DMG_ICON_SVG + chips;
    badge.addEventListener("mouseenter", () => showTooltip(badge, sideData));
    badge.addEventListener("mouseleave", hideTooltip);
    return badge;
  }

  function tryInject() {
    if (!active || !window.WarEraOps.isEnabled()) return;
    // Per-feature toggle (popup "Damage bonuses", under Battle features). Separate from the
    // global extra-stats switch — off means remove everything and stop, same pattern as
    // battle-contracts.js's "Open contracts" toggle.
    if (!featureEnabled) {
      document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((el) => el.remove());
      hideTooltip();
      return;
    }

    const battleId = extractBattleId();
    if (!battleId) return;
    if (battleId !== lastBattleId) {
      ensureFetched(battleId);
      return;
    }
    if (!data) return; // still loading, failed, or this battle isn't in the live snapshot

    if (!document.querySelector(`[${MARKER_ATTR}="defender"]`)) {
      const wrapper = findBonusWrapper("defender");
      if (wrapper && wrapper.parentElement) {
        wrapper.parentElement.insertBefore(buildConciseBadge(data.defender, "defender"), wrapper);
      }
    }
    if (!document.querySelector(`[${MARKER_ATTR}="attacker"]`)) {
      const wrapper = findBonusWrapper("attacker");
      if (wrapper && wrapper.parentElement) {
        wrapper.parentElement.insertBefore(buildConciseBadge(data.attacker, "attacker"), wrapper.nextSibling);
      }
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
    lastBattleId = null;
    data = null;

    // Watch the per-feature toggle independently of the global extra-stats switch.
    storageListener = (changes, area) => {
      if (area !== "local" || !(FEATURE_KEY in changes)) return;
      featureEnabled = changes[FEATURE_KEY].newValue !== false;
      scheduleInject();
    };
    browser.storage.onChanged.addListener(storageListener);
    browser.storage.local.get(FEATURE_KEY).then((v) => {
      featureEnabled = v[FEATURE_KEY] !== false; // default on
      scheduleInject();
    });

    // WarEra re-renders this area client-side, which can wipe our injected badges since React
    // doesn't know about them — watch and re-add, same pattern as country-rankings.js.
    observer = new MutationObserver(scheduleInject);
    observer.observe(document.body, { childList: true, subtree: true });

    lastPath = location.pathname;
    pollInterval = setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        lastBattleId = null;
        data = null;
        scheduleInject();
      }
    }, 800);

    scheduleInject();
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
    if (tooltipEl) {
      tooltipEl.remove();
      tooltipEl = null;
    }
    lastBattleId = null;
    data = null;
    fetching = false;
  }

  window.WarEraOps.registerFeature({ name: "battleBonus", activate, deactivate });
})();
