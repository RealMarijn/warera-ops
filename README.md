<img src="icons/icon128.png" width="96" height="96" alt="WarEra Ops icon">

# WarEra Ops

A browser extension (Firefox and Chrome, Manifest V3) that adds extra stats, a live battle damage tracker, and map overlays (bases, bunkers, resistance, core country colors, proxy countries) to the [WarEra](https://app.warera.io) browser game — mostly pulled from WarEra's own public API, with a few whitelist-gated features backed by a companion server — styled to match the game's own UI.

## Table of contents

- [Screenshots](#screenshots)
- [Features](#features)
  - [Profile & inventory](#profile--inventory)
  - [Country & MU](#country--mu)
  - [Battles](#battles)
  - [Map](#map)
  - [Extension controls](#extension-controls)
- [Signing in with Discord](#signing-in-with-discord)
- [Installing](#installing)
  - [1. Download it](#1-download-it)
  - [2. Load it in Chrome (or Edge, Brave, and other Chromium browsers)](#2-load-it-in-chrome-or-edge-brave-and-other-chromium-browsers)
  - [3. Load it in Firefox](#3-load-it-in-firefox)

## Screenshots

<img src="docs/screenshots/damage-tracker-country.png" alt="LIVE Damage tracker showing where one country is dealing damage in battles" width="100%">

<img src="docs/screenshots/damage-tracker-battle.png" alt="LIVE Damage tracker showing where the damage in a battle is coming from" width="100%">

## Features

### Profile & inventory

- **Profile pages** — adds ranking tiles the game doesn't show by default: Bounty, Cases opened, Elite cases opened, Gems purchased, Health, and Hunger. Hovering the cases tiles shows a loot rarity breakdown.
- **Inventory page** — an "Export JSON" button next to Craft/Dismantle that downloads your full items and equipment as JSON.

### Country & MU

- **Country pages** — adds Region Diff, Country Bounty, and Current Population ranking tiles, plus Daily/Weekly/Monthly Tax Revenue tiles (whitelist-gated — sign in with Discord in the popup to see these). If the country is currently a proxy/puppet of another (see [Proxy countries](#map) below), a small "(proxy of X)" badge appears next to its name, linking to that origin country (also whitelist-gated).
- **MU pages** — adds Bounty and Invested Money ranking tiles.
- **Country/MU account pages** — shows total inventory value (money plus all items at current market price).

### Battles

- **Battle pages** — shows the true total money earned per side (attacker/defender), fetched from the full battle ranking rather than only what's been scrolled into view.
- **LIVE Damage tracker** — a floating window on the map with real-time damage-flow lines for a battle: one line from every contributing country toward the contested region, colour-coded and sized by how much damage they're currently dealing, with each fighting nation's total damage rate shown right next to its name.
  - Pick any active battle from a searchable dropdown (favourites, your country, with orders, allies, enemies, etc.) — you don't need the battle page open to watch it.
  - Open several tracker windows at once (**+** button) to watch multiple battles side by side. They're linked by default — drag one and they all move together; detach one (⛓ button) to reposition it independently, and reattach it later. Whichever window you clicked last is the "active" one; only its lines are drawn on the map, so the map doesn't get cluttered with every open battle at once.
  - Collapsed by default to just the two fighting countries and the region; click "Show supporting countries" to expand the full per-country damage breakdown, which scrolls and can be resized taller.
  - Close windows with the ✕ button; closing the last one turns the "Damage lines" toggle off in the popup, so re-enabling it there spawns a fresh window.
  - A small timeline chart shows damage rate (K/min) over time since the window started tracking, for both sides.
- **Country damage** — a companion floating window (independent on/off toggle from the tracker above) that picks one country and draws a line to every currently active battle it's dealing damage in — including battles it's not a direct belligerent of, via allies or mercenaries. Shows Total (all-time) or Now (since you last clicked "Now", with a timestamp of when that was) damage per battle, colour-split red/blue by that battle's attacker/defender ratio, plus its own timeline chart of total damage rate. Like the tracker above, you can open several windows to watch multiple countries at once.

### Map

- **Core country colors** (off by default) — recolors every region by its *original* owning country instead of whoever currently controls it, using the same colors WarEra's own map already uses per country. Useful for seeing at a glance how much of a country's original territory has actually been conquered.
- **Proxy countries** (whitelist-gated) — flags a country as a proxy/puppet when most of its recent citizens immigrated from one other ("origin") country. Adds a small flag + "proxy of X" label under that country's own native flag on the map, in the origin's real label colour and font. Countries too small to ever get their own flag on the map (no room for WarEra to draw one) are skipped rather than shown floating disconnected from anything.

### Extension controls

- **Popup menu** (toolbar icon) — toggle Extra stats, the Damage tracker, Country damage, Core country colors, and (if you're on the whitelist) Proxy countries on or off independently, and sign in with Discord for features that need it.

## Signing in with Discord

A few features need data that isn't in WarEra's own public API, so they're served by a small companion server instead and gated to a Discord whitelist:

- Military base, bunker, and resistance icons on the map
- Daily/Weekly/Monthly Tax Revenue tiles on country pages
- Proxy countries on the map, and the matching "(proxy of X)" badge on country pages

Everything else in this extension (profile/country/MU/battle stats, the damage tracker, country damage, core country colors) works without signing in.

To sign in:

1. Open the popup (click the WarEra Ops icon in your toolbar) and scroll to the bottom.
2. Click **Login with Discord**. A new tab opens to complete the Discord login.
3. If your Discord account is on the whitelist, the popup shows "Logged in as &lt;your name&gt;" and the gated rows (Military bases / Bunkers / Resistance / Proxy countries under Map features, and the tax tiles + proxy badge on country pages) become available.
4. If it isn't, you'll see "That Discord account isn't on the WarEra Ops whitelist." — reach out to **RealMarijn** in-game or on Discord to request access.

Click **Logout** in the popup at any time to sign out again; that immediately revokes the session on the server. See the [Privacy Policy](https://warera.realmarijn.nl/privacy) for exactly what's stored on each side.

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
