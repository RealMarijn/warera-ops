// Feature: on a battle page, adds one small pill-shaped "Bonuses" button next to the game's own
// personal-bonus display for EACH side ("+63.75%"/"+20%" etc.) — that native number is only ever
// YOUR OWN personal bonus, not what other groups in the same battle actually get. Nothing numeric
// shows until you hover the pill (styled to actually look like a button — a bare dotted-underline
// text label tried first wasn't a clear enough hover cue). Hovering shows that side's complete
// breakdown — Own citizens / Allies / Pact countries / Other, same table rijksoverheid_web's own
// "Live battles" page already renders (Home/Enemy/Pact/Ally/Order/MU-ord/MU-HQ/Upgrade/Revolt/Max
// per group) — fetched from that same live snapshot for the one battle currently open.
// Deliberately NOT whitelist-gated: see BACKEND_API.md's "public backend endpoints" section —
// the exact same data is already public, unauthenticated, on the website itself.
(function () {
  // Same stack + weight already confirmed live for WarEra's own UI text elsewhere in this
  // extension (see tools/dmg-lines/map.js's FLAG_FONT) — Saira is the game's actual webfont, not
  // a system-font approximation, and 600 matches its own label weight.
  const WARERA_FONT = "Saira, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', " +
    "Roboto, 'Helvetica Neue', Arial, sans-serif";
  const MARKER_ATTR = "data-warera-ops-battle-bonus";
  const TOOLTIP_ID = "warera-ops-bonus-tooltip";

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
      font: `600 11px ${WARERA_FONT}`,
      color: "#eef0f4", display: "none",
      // A tall table flipped above a low-on-screen anchor could still push its own top past y=0
      // (nothing to flip TO at that point) — capping height and letting it scroll internally means
      // it always fits somewhere on screen instead of just running off the top.
      maxHeight: "calc(100vh - 16px)", overflowY: "auto",
    });
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  // Rows the backend always sends for the standard groups — anything else is a specific country
  // that placed a paid order (see BACKEND_API.md's gevechten/battle/.../bonus entry), inserted
  // between "Allies"/"Pact countries" and the trailing "Other" row. A thin divider above the
  // FIRST such country row visually separates "everyone in this group" from "these particular
  // named countries" — only once, not again when the list returns to "Other" afterward.
  const STANDARD_GROUPS = new Set(["Own citizens", "Allies", "Pact countries", "Other"]);

  function buildTooltipHTML(sideData) {
    const cols = ["Home", "Enemy", "Pact", "Ally.", "Order", "MU-ord*", "MU-HQ*", sideData.upgrade_label + "**", "Revolt", "~Max"];
    const keys = ["home", "enemy", "pact", "alliance", "order", "mu_order", "mu_hq", "upgrade", "revolt"];
    let dividerAdded = false;
    const rows = (sideData.rows || []).map((r) => {
      const isNamedCountry = !STANDARD_GROUPS.has(r.group);
      const divider = isNamedCountry && !dividerAdded;
      if (divider) dividerAdded = true;
      const cells = keys.map((k) => `<td>${esc(r[k])}</td>`).join("");
      return `<tr${divider ? ' class="wob-divider"' : ""}><td class="wob-grp">${esc(r.group)}</td>${cells}<td class="wob-max">~${esc(r.max_est)}%</td></tr>`;
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
    #${TOOLTIP_ID} table.wob-table th { color: rgba(238,240,244,0.55); font-weight: 600; }
    #${TOOLTIP_ID} table.wob-table td.wob-grp, #${TOOLTIP_ID} table.wob-table th:first-child { text-align: left; }
    #${TOOLTIP_ID} table.wob-table td.wob-max { font-weight: 600; color: #e7b9a5; }
    #${TOOLTIP_ID} table.wob-table tr.wob-divider td { border-top: 1px solid rgba(255,255,255,0.18); padding-top: 5px; }
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

  function showTooltip(anchorEl, html) {
    ensureCSS();
    const tip = ensureTooltip();
    tip.innerHTML = html;
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

  // ---- hover-button trigger (no numbers visible until you hover) -------------------------------
  // A bare dotted-underline text label was tried first for "hover for info" but wasn't a clear
  // enough cue — an actual pill/badge shape (background + rounded corners) reads as an
  // interactive element on sight, the way a real button does, not just styled text.
  //
  // position:absolute, not a normal in-flow sibling: the native bonus display's column wrapper
  // turned out (confirmed live) to be a flex row that WRAPS, not a stacking-context fight (its own
  // z-index is "auto", not something competing) — inserting an extra in-flow item into that row
  // sometimes tipped it over its available width, which is what actually pushed our pill onto a
  // wrapped second line ("under" the native number), not a z-index/paint-order problem at all.
  // Taking it out of flow entirely means it can never affect, or be affected by, that row's own
  // wrap decisions — it's positioned manually instead (see positionTrigger), anchored to the same
  // position:relative column div the native bonus display already lives in (confirmed live).
  const TRIGGER_CSS = `
    [${MARKER_ATTR}] { position: absolute; display: inline-flex; align-items: center; gap: 3px;
      padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,0.1);
      font: 600 11px ${WARERA_FONT}; color: rgba(238,240,244,0.8); cursor: help;
      white-space: nowrap; z-index: 999999; }
    [${MARKER_ATTR}]:hover { background: rgba(231,185,165,0.22); color: #e7b9a5; }
    [${MARKER_ATTR}] .wob-info { opacity: 0.8; }
  `;
  let triggerCssInjected = false;
  function ensureTriggerCSS() {
    if (triggerCssInjected) return;
    const style = document.createElement("style");
    style.textContent = TRIGGER_CSS;
    document.head.appendChild(style);
    triggerCssInjected = true;
  }

  // `marker` distinguishes the "defender"/"attacker" triggers so tryInject can check which one is
  // already present without re-inserting a duplicate on every re-render. The ⓘ glyph plus the
  // pill background above are both there for the same reason: make "hover this for info" obvious
  // at a glance, not just implied by a subtle color/underline.
  function buildTriggerText(label, marker, html) {
    ensureTriggerCSS();
    const el = document.createElement("span");
    el.setAttribute(MARKER_ATTR, marker);
    el.innerHTML = `<span class="wob-info">ⓘ</span>${esc(label)}`;
    el.addEventListener("mouseenter", () => showTooltip(el, html));
    el.addEventListener("mouseleave", hideTooltip);
    return el;
  }

  // Manually places an (already position:absolute) trigger beside its native bonus anchor,
  // relative to `container` — the position:relative column div both live in — rather than relying
  // on normal flex flow, which is what wrapped it onto a second line in the first place.
  function positionTrigger(el, anchorEl, container, side) {
    const containerRect = container.getBoundingClientRect();
    const anchorRect = anchorEl.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const top = anchorRect.top - containerRect.top + (anchorRect.height - elRect.height) / 2;
    const left = side === "defender"
      ? anchorRect.left - containerRect.left - elRect.width - 4
      : anchorRect.right - containerRect.left + 4;
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(left)}px`;
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

    for (const side of ["defender", "attacker"]) {
      const wrapper = findBonusWrapper(side);
      const container = wrapper && wrapper.parentElement;
      if (!container) continue;
      let trigger = document.querySelector(`[${MARKER_ATTR}="${side}"]`);
      if (!trigger) {
        trigger = buildTriggerText("Bonuses", side, buildTooltipHTML(data[side]));
        // Appended, not inserted at a specific flex position — position:absolute takes it out of
        // that row's flow entirely, so where it sits in the DOM no longer matters for layout.
        container.appendChild(trigger);
      }
      positionTrigger(trigger, wrapper, container, side);
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

    // The triggers are manually positioned (see positionTrigger) rather than left in normal flex
    // flow — a window resize doesn't touch the DOM at all, so the MutationObserver above would
    // never notice one, and the triggers would just go stale (positioned for the old layout).
    window.addEventListener("resize", scheduleInject);

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
    window.removeEventListener("resize", scheduleInject);
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
