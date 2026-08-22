// Feature: on a battle page, adds one small pill-shaped "Bonuses" button next to the game's own
// personal-bonus display for EACH side ("+63.75%"/"+20%" etc.) — that native number is only ever
// YOUR OWN personal bonus, not what other groups in the same battle actually get. Nothing numeric
// shows until you hover the pill (styled to actually look like a button — a bare dotted-underline
// text label tried first wasn't a clear enough hover cue). Hovering shows that side's complete
// breakdown — Own citizens / Allies / Pact countries / Other, same table rijksoverheid_web's own
// "Live battles" page already renders (Home/Enemy/Pact/Ally/Order/MU-ord/MU-HQ/Upgrade/Revolt/Max
// per group) — fetched from that same live snapshot for the one battle currently open.
// Whitelist-gated: /api/ext/battles/{id}/bonus (see BACKEND_API.md) requires a valid session —
// this used to be a public endpoint (the underlying data happens to already be public elsewhere
// on the website) but was moved behind the whitelist as a matter of policy: every extension
// backend endpoint is whitelist-only, with no "it's already public anyway" exceptions.
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
  let countryCodeByName = null; // { lowercased country name -> code } — for the named-country flags
  let countryCodesLoading = false;
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
    ensureCountryCodes(); // fire-and-forget so named-country flags are ready by hover time
    document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((el) => el.remove());
    hideTooltip();
    try {
      const result = await browser.runtime.sendMessage({
        type: "WARERA_OPS_AUTHED_FETCH",
        path: `/api/ext/battles/${battleId}/bonus`,
        method: "GET",
      });
      data = result || null;
    } catch (err) {
      // Not logged in / not whitelisted / battle not tracked yet / backend unreachable — in every
      // case the feature just doesn't show, same as the other whitelist-gated features.
      data = null;
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
      background: "rgba(17,20,27,0.94)", border: "1px solid rgba(255,255,255,0.12)",
      borderRadius: "12px", padding: "13px 15px 12px", boxShadow: "0 16px 40px rgba(0,0,0,0.55)",
      backdropFilter: "blur(16px) saturate(150%)", WebkitBackdropFilter: "blur(16px) saturate(150%)",
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

  // A cell with no real contribution ("-", "N/A", empty, a plain zero) is dimmed hard so the eye
  // lands on the values that actually matter instead of a wall of dashes.
  const isEmptyCell = (v) => {
    const s = String(v == null ? "" : v).trim();
    return s === "" || s === "-" || s === "–" || s === "N/A" || s === "0" || s === "0%";
  };

  // ---- flags + category colours ---------------------------------------------------------------
  // The backend only names the country (e.g. "Philippines") — resolve its flag code from the game's
  // own country list (public endpoint), matched by name. Fetched once, cached; retried if it fails.
  const FLAG = (code) => `https://media.warera.io/images/flags/${code}.svg?v=16`;
  async function ensureCountryCodes() {
    if (countryCodeByName || countryCodesLoading) return;
    countryCodesLoading = true;
    try {
      const raw = await browser.runtime.sendMessage({
        type: "WARERA_OPS_FETCH", endpoint: "country.getAllCountries", params: {},
      });
      const list = raw?.result?.data ?? raw;
      const arr = Array.isArray(list) ? list : Object.values(list || {});
      const map = {};
      for (const c of arr) if (c && c.name && c.code) map[String(c.name).toLowerCase()] = c.code;
      countryCodeByName = map;
    } catch (_) {
      // leave it null so the next ensureFetched() retries — flags just don't show meanwhile
    } finally {
      countryCodesLoading = false;
    }
  }
  const flagFor = (name) => {
    const code = countryCodeByName && countryCodeByName[String(name).toLowerCase()];
    return code ? `<img class="wob-flag" src="${esc(FLAG(code))}" alt="">` : "";
  };

  // A colour per standard group; the same colours reappear as small dots behind the named
  // countries (ally / pact / order) so you can read a country's relationships at a glance.
  const GROUP_COLOR = {
    "Own citizens": "#6ea8ff", "Allies": "#7ee0a0", "Pact countries": "#c79bff", "Other": "#8a929e",
  };
  const ORDER_COLOR = "#f0c968";
  const dot = (color) => `<i class="wob-dot" style="background:${color}"></i>`;

  function relationshipTags(r) {
    const dots = [];
    if (!isEmptyCell(r.alliance)) dots.push(GROUP_COLOR["Allies"]);
    if (!isEmptyCell(r.pact)) dots.push(GROUP_COLOR["Pact countries"]);
    if (!isEmptyCell(r.order)) dots.push(ORDER_COLOR);
    return dots.length ? `<span class="wob-tags">${dots.map(dot).join("")}</span>` : "";
  }

  // Label cell: standard groups get a colour dot; named countries get a flag + relationship dots.
  function labelCellHTML(r, isNamed) {
    if (isNamed) {
      return `<span class="wob-lbl">${flagFor(r.group)}<span class="wob-nm">${esc(r.group)}</span>${relationshipTags(r)}</span>`;
    }
    const color = GROUP_COLOR[r.group];
    return `<span class="wob-lbl">${color ? dot(color) : ""}<span class="wob-nm">${esc(r.group)}</span></span>`;
  }

  function buildTooltipHTML(sideData) {
    const cols = ["Home", "Enemy", "Pact", "Ally.", "Order", "MU-ord*", "MU-HQ*", sideData.upgrade_label + "**", "Revolt", "~Max"];
    const keys = ["home", "enemy", "pact", "alliance", "order", "mu_order", "mu_hq", "upgrade", "revolt"];
    const totalCols = cols.length + 1; // + the group/label column
    let sectionAdded = false;
    const rows = (sideData.rows || []).map((r) => {
      const isNamed = !STANDARD_GROUPS.has(r.group);
      const isOther = r.group === "Other";
      // A labelled section header the first time we cross from the shared groups into the
      // specific named countries — a clear break, not just a hairline.
      let pre = "";
      if (isNamed && !sectionAdded) {
        sectionAdded = true;
        pre = `<tr class="wob-section"><td colspan="${totalCols}">Countries with an order</td></tr>`;
      }
      const cells = keys.map((k) =>
        `<td${isEmptyCell(r[k]) ? ' class="wob-dim"' : ""}>${esc(r[k])}</td>`).join("");
      const trCls = [isNamed ? "wob-named" : "", isOther ? "wob-other" : ""].filter(Boolean).join(" ");
      return `${pre}<tr${trCls ? ` class="${trCls}"` : ""}><td class="wob-grp">${labelCellHTML(r, isNamed)}</td>${cells}<td class="wob-max">~${esc(r.max_est)}%</td></tr>`;
    }).join("");
    const head = cols.map((c, i) =>
      `<th${i === cols.length - 1 ? ' class="wob-max-h"' : ""}>${esc(c)}</th>`).join("");
    return `
      <div class="wob-ttl"><b>${esc(sideData.country_name)}</b> · full breakdown</div>
      <table class="wob-table">
        <thead><tr><th></th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="wob-legend">
        <span>${dot(GROUP_COLOR["Own citizens"])}Own</span>
        <span>${dot(GROUP_COLOR["Allies"])}Ally</span>
        <span>${dot(GROUP_COLOR["Pact countries"])}Pact</span>
        <span>${dot(ORDER_COLOR)}Order</span>
      </div>
      <div class="wob-note"><b>*</b> depends on MU orders / HQ.&nbsp;&nbsp;<b>**</b> must be active.</div>
    `;
  }

  const TOOLTIP_CSS = `
    #${TOOLTIP_ID} .wob-ttl {
      font-weight: 700; font-size: 12.5px; letter-spacing: .2px; color: #cfd4dc;
      margin: 0 1px 9px; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.09);
    }
    #${TOOLTIP_ID} .wob-ttl b { color: #f0c9b6; font-weight: 700; }

    #${TOOLTIP_ID} table.wob-table { border-collapse: collapse; white-space: nowrap; }

    /* header row: quiet, spaced-out, uppercase labels */
    #${TOOLTIP_ID} table.wob-table thead th {
      padding: 2px 9px 8px; text-align: right; font-weight: 600;
      font-size: 9px; letter-spacing: .5px; text-transform: uppercase;
      color: rgba(238,240,244,0.42);
    }
    #${TOOLTIP_ID} table.wob-table thead th:first-child { text-align: left; }

    /* body cells: more vertical air + zebra for tracking across the wide row */
    #${TOOLTIP_ID} table.wob-table tbody td {
      padding: 5px 9px; text-align: right; font-variant-numeric: tabular-nums;
      font-size: 11px; color: #d7dbe2;
    }
    #${TOOLTIP_ID} table.wob-table tbody tr:nth-child(even) td { background: rgba(255,255,255,0.028); }

    /* group / country label column */
    #${TOOLTIP_ID} table.wob-table td.wob-grp {
      text-align: left; font-weight: 700; color: #eef0f4; padding-right: 18px;
    }
    /* named-country detail rows read quieter than the three summary groups */
    #${TOOLTIP_ID} table.wob-table tr.wob-named td.wob-grp { font-weight: 500; color: rgba(238,240,244,0.72); }

    /* label = colour dot / flag + name (+ relationship dots for countries) */
    #${TOOLTIP_ID} .wob-lbl { display: inline-flex; align-items: center; gap: 7px; }
    #${TOOLTIP_ID} .wob-nm { overflow: hidden; text-overflow: ellipsis; }
    #${TOOLTIP_ID} .wob-flag {
      width: 18px; height: 13px; object-fit: cover; border-radius: 2px; flex: none;
      box-shadow: 0 0 0 1px rgba(0,0,0,0.4);
    }
    #${TOOLTIP_ID} .wob-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; display: inline-block; }
    #${TOOLTIP_ID} .wob-tags { display: inline-flex; align-items: center; gap: 3px; margin-left: 4px; }

    /* labelled break between the shared groups and the per-country rows */
    #${TOOLTIP_ID} table.wob-table tr.wob-section td {
      text-align: left; padding: 10px 9px 4px;
      font-size: 8.5px; letter-spacing: .7px; text-transform: uppercase; font-weight: 700;
      color: rgba(238,240,244,0.4); border-top: 1px solid rgba(255,255,255,0.14);
    }
    /* the trailing "Other" catch-all gets its own separation */
    #${TOOLTIP_ID} table.wob-table tr.wob-other td { border-top: 1px solid rgba(255,255,255,0.10); }

    /* empty / N-A cells recede so the real numbers pop */
    #${TOOLTIP_ID} table.wob-table td.wob-dim { color: rgba(238,240,244,0.20); }

    /* the ~Max result column — the takeaway, set off from the rest */
    #${TOOLTIP_ID} table.wob-table th.wob-max-h { color: rgba(240,201,182,0.65); }
    #${TOOLTIP_ID} table.wob-table th.wob-max-h,
    #${TOOLTIP_ID} table.wob-table td.wob-max { border-left: 1px solid rgba(255,255,255,0.10); padding-left: 13px; }
    #${TOOLTIP_ID} table.wob-table td.wob-max { font-weight: 700; font-size: 11.5px; color: #f0c9b6; }

    /* section break above the per-country rows */
    #${TOOLTIP_ID} table.wob-table tr.wob-divider td { border-top: 1px solid rgba(255,255,255,0.14); padding-top: 8px; }

    #${TOOLTIP_ID} .wob-legend {
      display: flex; flex-wrap: wrap; gap: 12px; margin: 11px 1px 0;
      padding-top: 9px; border-top: 1px solid rgba(255,255,255,0.07);
      font-size: 10px; color: rgba(238,240,244,0.55);
    }
    #${TOOLTIP_ID} .wob-legend span { display: inline-flex; align-items: center; gap: 5px; }

    #${TOOLTIP_ID} .wob-note {
      margin: 7px 1px 0; font-size: 9.5px; line-height: 1.5;
      color: rgba(238,240,244,0.4); white-space: normal; max-width: 360px;
    }
    #${TOOLTIP_ID} .wob-note b { color: rgba(238,240,244,0.6); font-weight: 700; }
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
  function buildTriggerText(label, marker) {
    ensureTriggerCSS();
    const el = document.createElement("span");
    el.setAttribute(MARKER_ATTR, marker);
    el.innerHTML = `<span class="wob-info">ⓘ</span>${esc(label)}`;
    // Built on hover, not up front, so late-arriving flags (country codes fetched async) and any
    // refreshed data show up without having to re-create the trigger. `marker` is the side key.
    el.addEventListener("mouseenter", () => {
      if (data && data[marker]) showTooltip(el, buildTooltipHTML(data[marker]));
    });
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
        trigger = buildTriggerText("Bonuses", side);
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
