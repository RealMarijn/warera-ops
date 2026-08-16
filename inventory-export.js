// Feature: adds an "Export JSON" button to the inventory page next to Craft/Dismantle, which
// scrapes the page's own item/equipment tiles into a JSON download. There's no documented API
// endpoint that returns the full inventory (only currently-equipped items, or aggregate wealth
// totals), so this reads the DOM instead — anchored on stable signals (English button/badge
// text, inline style attributes) rather than the hashed "_1dnmndy*" classes used elsewhere,
// since those are the least likely thing here to survive a rebuild.
(function () {
  const MARKER_ATTR = "data-warera-ops-export-button";
  const NUMBER_SUFFIX = { K: 1e3, M: 1e6, B: 1e9 };

  function isInventoryPage() {
    return /\/user\/[a-fA-F0-9]{24}\/inventory/.test(location.pathname);
  }

  function extractUserId() {
    const match = location.pathname.match(/\/user\/([a-fA-F0-9]{24})\/inventory/);
    return match ? match[1] : null;
  }

  // Reads a displayed number like "1.01K" back into 1010. Large stacks only have as much
  // precision as the UI already rounded them to.
  function parseFormattedNumber(text) {
    if (!text) return null;
    const match = text.trim().match(/^([\d.]+)\s*([KMB])?$/i);
    if (!match) return null;
    const num = parseFloat(match[1]);
    if (Number.isNaN(num)) return null;
    const mult = match[2] ? NUMBER_SUFFIX[match[2].toUpperCase()] : 1;
    return Math.round(num * mult);
  }

  // Climbs from the Craft button until it finds an ancestor containing both item images and
  // at least one category header — independent of exactly how many levels of nesting sit
  // between them, unlike hardcoding a fixed number of `.parentElement` hops.
  function findInventoryContainer() {
    const craftButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent.trim() === "Craft"
    );
    let node = craftButton?.parentElement || null;
    for (let i = 0; i < 8 && node; i++) {
      if (node.querySelector('img[alt]') && node.querySelector('div[style*="font-weight: 600"]')) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function precedes(a, b) {
    return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  // Skinned item/equipment codes are "<skinName><BaseType>" (e.g. "grimdarkSniper",
  // "valentineBoots") — strip the skin prefix down to just the base type. Longest names first
  // so "LightAmmo"/"HeavyAmmo" match before the shorter "Ammo" they both end with.
  const EQUIPMENT_TYPE_SUFFIXES = [
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
    return EQUIPMENT_TYPE_SUFFIXES.find((suffix) => code.endsWith(suffix)) || code;
  }

  // Items have no header of their own (they're just whatever comes before the first
  // "Weapons"/"Helmets"/etc. header), so each image's section is whichever header most
  // recently precedes it in document order — this doesn't depend on assumed tree depth.
  function sectionForImage(img, headers) {
    let section = null;
    for (const header of headers) {
      if (precedes(header, img)) section = header;
      else break;
    }
    return section ? section.textContent.trim() : null;
  }

  function extractItemTile(img) {
    const scope = img.closest('[aria-expanded="false"]') || img.parentElement;
    const quantityEl = scope.querySelector('div[style*="display: inline-block"]');
    return {
      code: stripSkin(img.getAttribute("alt")),
      quantity: parseFormattedNumber(quantityEl?.textContent),
    };
  }

  // Each equipment category shows 1-2 top stats; this maps their position to what they
  // actually are in-game (confirmed by the user, not guessed).
  const EQUIPMENT_STAT_LABELS = {
    Weapons: ["attack", "critChance"],
    Helmets: ["critDamages"],
    Chests: ["armor"],
    Pants: ["armor"],
    Gloves: ["precision"],
    Boots: ["dodge"],
  };

  // The wear/condition bar is rendered as `transform: scaleX(0.18)` on its fill element —
  // reading that fraction directly is exact, and (unlike matching "%"-suffixed text) can't be
  // confused with the top stat(s) above it, which is what caused wrong values before.
  function extractDurabilityPercent(scope) {
    const barEl = Array.from(scope.querySelectorAll("div")).find((el) =>
      /transform:[^;]*scaleX\(/.test(el.getAttribute("style") || "")
    );
    const match = barEl?.getAttribute("style").match(/scaleX\(([\d.]+)\)/);
    if (!match) return null;
    const fraction = parseFloat(match[1]);
    return Number.isNaN(fraction) ? null : `${Math.round(fraction * 100)}%`;
  }

  function extractEquipmentTile(img, sectionName) {
    const scope =
      img.closest('[aria-expanded="false"]') ||
      img.closest('[aria-haspopup="dialog"]') ||
      img.parentElement;
    const statsRow = scope.querySelector('div[style*="white-space: nowrap"]');
    const statTexts = statsRow
      ? Array.from(statsRow.children)
          .map((el) => el.textContent.trim())
          .filter(Boolean)
      : [];

    const stats = {};
    (EQUIPMENT_STAT_LABELS[sectionName] || []).forEach((label, i) => {
      stats[label] = statTexts[i] ?? null;
    });

    return {
      code: stripSkin(img.getAttribute("alt")),
      ...stats,
      durability: extractDurabilityPercent(scope),
    };
  }

  function scrapeInventory() {
    const container = findInventoryContainer();
    if (!container) return null;

    const headers = Array.from(container.querySelectorAll('div[style*="font-weight: 600"]'));
    const images = Array.from(container.querySelectorAll("img[alt]"));

    const result = { items: [], equipment: {} };
    for (const img of images) {
      const section = sectionForImage(img, headers);
      if (!section) {
        result.items.push(extractItemTile(img));
      } else {
        (result.equipment[section] ||= []).push(extractEquipmentTile(img, section));
      }
    }

    return result;
  }

  async function fetchUsername(userId) {
    try {
      const raw = await browser.runtime.sendMessage({
        type: "WARERA_OPS_FETCH",
        endpoint: "user.getUserById",
        params: { userId },
      });
      const payload = raw?.result?.data ?? raw;
      return payload?.username ?? null;
    } catch (err) {
      console.error("[WarEra Ops] failed to fetch username for export filename", err);
      return null;
    }
  }

  function sanitizeFilenamePart(text) {
    return text.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function timestampStamp() {
    // "2026-08-14_14-32" — colons aren't valid in filenames on Windows.
    return new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
  }

  function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function buildExportButton(referenceWrapper) {
    const wrapper = referenceWrapper.cloneNode(true);
    wrapper.setAttribute(MARKER_ATTR, "true");
    // The Craft/Dismantle row lays these out with flex-grow, sized for a 2-button row — without
    // this, the clone stretches to share that space evenly and ends up padded well past its text.
    wrapper.style.flex = "0 0 auto";
    wrapper.style.width = "fit-content";

    const button = wrapper.querySelector("button");
    if (button) {
      button.style.width = "auto";
      button.style.fontSize = "85%";
    }
    const labelSpan = button?.querySelector("span.agd9b40");
    const iconHolder = button?.querySelector(".a6izou0");

    if (labelSpan) labelSpan.textContent = "Export JSON";
    if (iconHolder) {
      iconHolder.innerHTML = `
        <svg style="width: 1em; overflow: visible; height: 1em; font-size: 120%; filter: drop-shadow(black 1px 1px 0px);" viewBox="0 0 24 24" fill="currentColor">
          <path d="M5,20H19V18H5M19,9H15V3H9V9H5L12,16L19,9Z"></path>
        </svg>
      `;
    }

    // cloneNode doesn't carry over React's event listeners, so this can't accidentally
    // trigger the real Craft action — only our own listener below runs.
    button?.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const data = scrapeInventory();
      if (!data) {
        console.error("[WarEra Ops] could not find inventory data to export");
        return;
      }
      const userId = extractUserId();
      const username = userId ? await fetchUsername(userId) : null;
      const namePart = sanitizeFilenamePart(username || userId || "unknown");
      downloadJSON(data, `warera-inventory-${namePart}-${timestampStamp()}.json`);
    });

    return wrapper;
  }

  let active = false;
  let observer = null;
  let pollInterval = null;
  let lastPath = null;
  let scheduled = false;

  function tryInsertButton() {
    if (!active || !window.WarEraOps.isEnabled()) return;

    if (!isInventoryPage()) {
      document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((el) => el.remove());
      return;
    }
    if (document.querySelector(`[${MARKER_ATTR}]`)) return;

    const craftButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent.trim() === "Craft"
    );
    const referenceWrapper = craftButton?.parentElement;
    const buttonsRow = referenceWrapper?.parentElement;
    if (!referenceWrapper || !buttonsRow) return;

    buttonsRow.appendChild(buildExportButton(referenceWrapper));
  }

  function scheduleInsert() {
    if (!active || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      tryInsertButton();
    });
  }

  function activate() {
    active = true;

    // WarEra re-renders this row client-side (route changes), which can wipe our injected
    // button since React doesn't know about it — watch and re-add.
    observer = new MutationObserver(scheduleInsert);
    observer.observe(document.body, { childList: true, subtree: true });

    lastPath = location.pathname;
    pollInterval = setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        scheduleInsert();
      }
    }, 800);

    scheduleInsert();
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

  window.WarEraOps.registerFeature({ name: "inventoryExport", activate, deactivate });
})();
