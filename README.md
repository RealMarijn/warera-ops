<img src="icons/icon128.png" width="96" height="96" alt="WarEra Ops icon">

# WarEra Ops

A browser extension (Firefox and Chrome, Manifest V3) that adds extra stats, a live battle damage tracker, and map overlays (bases, bunkers, resistance, core country colors) to the [WarEra](https://app.warera.io) browser game — mostly pulled from WarEra's own public API, with a few whitelist-gated features backed by a companion server — styled to match the game's own UI.

## Features

### Profile & inventory

- **Profile pages** — adds ranking tiles the game doesn't show by default: Bounty, Cases opened, Elite cases opened, Gems purchased, Health, and Hunger. Hovering the cases tiles shows a loot rarity breakdown.
- **Inventory page** — an "Export JSON" button next to Craft/Dismantle that downloads your full items and equipment as JSON.

### Country & MU

- **Country pages** — adds Region Diff, Country Bounty, and Current Population ranking tiles, plus Daily/Weekly/Monthly Tax Revenue tiles (whitelist-gated — sign in with Discord in the popup to see these).
- **MU pages** — adds Bounty and Invested Money ranking tiles.
- **Country/MU account pages** — shows total inventory value (money plus all items at current market price).

### Battles

- **Battle pages** — shows the true total money earned per side (attacker/defender), fetched from the full battle ranking rather than only what's been scrolled into view.
- **LIVE Damage tracker** — a floating window on the map with real-time damage-flow lines for a battle: one line from every contributing country toward the contested region, colour-coded and sized by how much damage they're currently dealing, with each fighting nation's total damage rate shown right next to its name.
  - Pick any active battle from a searchable dropdown (favourites, your country, with orders, allies, enemies, etc.) — you don't need the battle page open to watch it.
  - Open several tracker windows at once (**+** button) to watch multiple battles side by side. They're linked by default — drag one and they all move together; detach one (⛓ button) to reposition it independently, and reattach it later. Whichever window you clicked last is the "active" one; only its lines are drawn on the map, so the map doesn't get cluttered with every open battle at once.
  - Collapsed by default to just the two fighting countries and the region; click "Show supporting countries" to expand the full per-country damage breakdown, which scrolls and can be resized taller.
  - Close extra windows with the ✕ button (the last remaining window can't be closed).

### Map

- **Core country colors** (off by default) — recolors every region by its *original* owning country instead of whoever currently controls it, using the same colors WarEra's own map already uses per country. Useful for seeing at a glance how much of a country's original territory has actually been conquered.

### Extension controls

- **Popup menu** (toolbar icon) — toggle Extra stats, the Damage tracker, and Core country colors on or off independently, and, if you're on the whitelist, sign in with Discord for features that need it.

## Installing

The extension isn't required to come from a store — you can load it straight from a downloaded copy of this repository.

### 1. Download it

Go to the [GitHub repository](https://github.com/RealMarijn/warera-ops) and either:
- click **Code → Download ZIP** and unzip it somewhere, or
- clone it: `git clone https://github.com/RealMarijn/warera-ops.git`

Either way you should end up with a folder that has `manifest.json` directly inside it — that's the folder you'll point your browser at below.

### 2. Load it in Chrome (or Edge, Brave, and other Chromium browsers)

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the folder from step 1.
4. The WarEra Ops icon appears in your toolbar. Open [app.warera.io](https://app.warera.io) to see it in action.

### 3. Load it in Firefox

Firefox only allows unsigned extensions to be loaded *temporarily* — they're removed on browser restart and need to be reloaded each session.

1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select the `manifest.json` file inside the folder from step 1.
4. The WarEra Ops icon appears in your toolbar. Open [app.warera.io](https://app.warera.io) to see it in action.

If you update the downloaded files later, click **Reload** next to the extension on that same `about:debugging` page (Chrome: the reload icon on `chrome://extensions`) to pick up the changes.
