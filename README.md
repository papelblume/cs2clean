
https://github.com/user-attachments/assets/e75a84d9-3591-409e-a9bc-52b89796e756 


<h1 align="left">
  CS2Clean
  <img align="right" width="367" height="284" alt="FACEIT-ban" src="https://github.com/user-attachments/assets/1ab863aa-d131-4393-9be9-9dbc563d929e" />
</h1>

**Know your lobby before the first round.**


A desktop companion and in-game overlay for CS2 that automatically checks player reputations using Leetify's Public API. When a match loads, CS2Clean looks up the first 10 players in your lobby and shows each one's judged reputation score (0–100, 100 = nothing unusual) and risk classification: **Normal**, **Elevated**, **High**, or **Very high**.
## What it does
- **Lobby check** — when a match loads, reads the player list from Steam and looks up each player on Leetify
- **In-game overlay** — a transparent, click-through window on top of the game showing player cards with reputation scores, classifications, aim/clutch ratings, and Leetify's own stats. It appears automatically in warm-up and hides when the match goes live
- **Siren alert** — plays an audible alert when a High or Very high player is detected
- **Player cards** — detailed view for each player: performance score, reputation tier, reasons for flags, and (for public profiles) recent match history
- **Two scores, different questions** — the performance class measures how far above average a player performs; the reputation score measures how implausible their stats look for their rank. One strong number alone never flags a player. A ban on record is the only hard evidence.
- **Friend badges (optional)** — with a Steam Web API key, lobby players who are linked by Steam friendships share a colored bar and an "N friends" badge, in the window and in the overlay. A link can run through a third player (A–B and B–C make a group of three), so the badge tells you who is connected, not that all of them are friends with each other
- **Configurable hotkeys** — all overlay keys can be changed in Settings
- **Start with Windows** — optional auto-start, minimized to the taskbar (Windows only)
- **Siren toggle** — turn the alert sound on or off in Settings
- **No game injection** — nothing reads or modifies CS2's memory. The overlay is an ordinary transparent window kept on top of the game

The app checks for updates on startup (at most once per day). You can also trigger a manual check from Settings.


## How it works

| Data source | What it provides |
|-------------|-----------------|
| **Steam's coplay list** | Who is in your match (Steam > View > Players). CS2 reports the roster to Steam when the match loads. |
| **Steam's friends list** *(optional)* | Steam's players list leaves out people who are already your friends. With Steam started with `-cef-enable-debugging` and the friends list window open, the app reads the status line the friends list shows ("Competitive - Office [ 5 : 0 ]", read-only, over Steam's local debug port) and adds friends whose line equals yours, score included. |
| **CS2 Game State Integration (GSI)** | When warm-up starts, when the match goes live, the map name, and your own Steam ID. The app writes a config file into CS2's `cfg` folder and listens on `127.0.0.1:37215`. |
| **Leetify Public API** | Player ratings, stats, and match history. Two scores are computed from this data: a performance class and a 0–100 reputation score. |
| **Steam Web API** *(optional)* | Each lobby player's friends list, to mark who is friends with whom. Needs your own Steam Web API key. |
| **GitHub** | The number of the latest release, for the update banner. |

**Privacy note:** The Leetify and Steam Web API keys are each encrypted with your OS keychain (Windows DPAPI, Linux desktop keyring) and stored in the app's settings file. If no keychain is available, they are stored as plain text. Besides Leetify, the app contacts `api.steampowered.com` (only if you saved a Steam key; it sends that key and the SteamIDs of the players in your lobby), `csst.at` (only for players Leetify doesn't know; the first time, the Chrome that the helper drives is also downloaded from `github.com/ulixee/chrome-versions`) and `api.github.com` (the update check).

## Keyboard shortcuts

| Key | What it does |
|-----|--------------|
| **Shift+F2** | Toggle the lobby list (desktop window) |
| **F7** | Show cards of flagged players in the overlay |
| **F6** | Step forward through player cards (one at a time) |
| **Shift+F6** | Step backward through player cards |

All four keys can be changed under **Settings** in the app.

## Leetify API key

Lookups work without a key, but at Leetify's stricter rate limits. A free key from [leetify.com/app/developer](https://leetify.com/app/developer) makes lookups reliable:

1. Get a free key from the link above
2. Paste it into the app's window (it is validated before saving), or set `LEETIFY_API_KEY` in the environment
3. A saved key takes priority over the environment variable

## Platforms

- **Windows** — installer (NSIS) or portable `.exe` from [GitHub releases](https://github.com/papelblume/CS2Clean/releases)
- **Linux** — AppImage or tar.gz from [GitHub releases](https://github.com/papelblume/CS2Clean/releases)

## Installation (Windows)

1. Download the latest release from the [GitHub releases page](https://github.com/papelblume/CS2Clean/releases)
2. Run the installer (per-user, no admin required) or the portable `.exe` (no installation)
3. Start CS2 and launch CS2Clean
4. Paste your Leetify API key if you have one
5. Restart CS2 once (so it loads the GSI config), then join a match

The installer adds Start menu and desktop shortcuts. Settings are stored in `%APPDATA%\CS2Clean`.

**SmartScreen:** The installer is not yet code-signed. Windows will show "Windows protected your PC" — click **More info**, then **Run anyway**.

## Installation (Linux)

### Pre-built binaries

1. Download the latest AppImage or tar.gz from [GitHub releases](https://github.com/papelblume/CS2Clean/releases)
2. **AppImage:** make it executable and run it:
   ```bash
   chmod +x CS2Clean-*.AppImage
   ./CS2Clean-*.AppImage
   ```
3. **tar.gz:** extract and run the binary inside:
   ```bash
   tar -xzf CS2Clean-*.tar.gz
   ./CS2Clean
   ```

### From source

Requires **Node 22.12 or newer**:

```bash
git clone https://github.com/papelblume/CS2Clean.git
cd CS2Clean
npm ci
npm run hero:install
npm start
```

`npm run hero:install` sets up the csst.at fallback (the Hero sidecar; docs/DESIGN.md explains it). It needs Node 22 itself: the Node that runs it
if that is 22, otherwise the newest nvm `v22.x`, or the one `CS2CLEAN_NODE22` points at. It installs Hero with that Node
and copies the Node next to it. Skip it and the app still works; the window then says "csst.at fallback unavailable" and why.

### Linux requirements

- Native Steam running and signed in
- CS2 in **Fullscreen Windowed** mode (Settings > Video > Display Mode)
- X11 session (Wayland is untested)

On first start the app writes `gamestate_integration_cs2clean.cfg` into CS2's `cfg` folder.

If Electron refuses to start with a `chrome-sandbox` error (common on Ubuntu 24.04 and derivatives), grant the sandbox the permissions it needs:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Settings are kept in `~/.config/CS2Clean`.

## Running from the desktop window

After joining a match warm-up, press **Shift+F2** to open the lobby list. It shows each player's name, classification, and reputation score. Click a player to open their Leetify profile.

## Replay mode (no CS2 needed)

To try the app without CS2, replay mode plays a recorded session:

```bash
npm run start:replay
```

To record a real match (Overwolf mode only):

```bash
npm run start:overwolf -- --record
```

The recording is saved to `%APPDATA%\CS2Clean\recordings`. You can then replay it with:

```bash
npx electron . --replay=recordings/your-recording.jsonl
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Steam didn't answer" | Make sure Steam is running and you're signed in |
| A friend in your match is missing | Quit Steam fully and start it with `-cef-enable-debugging` (or create an empty file named `.cef-enable-remote-debugging` in Steam's folder), and keep the friends list window open. `npm run friends-ui` shows what the app can read. The debug port (8080, or `CS2CLEAN_DEBUG_PORT`) lets any program on this PC control Steam, so leave it off when you don't need it. |
| "Couldn't find CS2's folder" | The app can still read Steam's players list; GSI won't detect match phases. Install CS2 in a standard location. |
| "CS2 is running as administrator" | Start CS2Clean as administrator too, or start CS2 without admin rights |
| Overlay not visible in CS2 | Make sure CS2 is in **Fullscreen Windowed** mode, not plain Fullscreen |
| `chrome-sandbox` error on Linux | Run the `chown`/`chmod` commands above |
| Leetify rate limits | Get a free API key from leetify.com/app/developer |
| "csst.at fallback unavailable" | The window gives the reason. Nothing else stops working: only players Leetify has no profile for can't be looked up on csst.at. The full error is in `hero.log` in the app's data folder (`%APPDATA%\CS2Clean` on Windows, `~/.config/CS2Clean` on Linux). From a source checkout the usual fix is `npm run hero:install`. |
| "Setting up the csst.at fallback: downloading Chrome" | One-time download (a few hundred MB; Chrome is 370 MB on disk) into the app's data folder, the first time a player isn't on Leetify. Lookups carry on meanwhile and the fallback works from the next one after it. |

## UI Development

Preview UI states in a browser without running the full app:

```bash
npm run dev:ui
```

Then open `http://localhost:5173` with query params:
- `?screen=lobby|detail|player|nokey|waiting|problem` — which screen to show (default: lobby)
- `?fallback=off` — preview the window with the csst.at fallback unavailable

## Debug Scripts

```bash
npm run leetify:probe    # test the Leetify API client directly
npm run coplay           # run the Steam coplay reader standalone
npm run friends-ui       # show the friends list status lines and which friends would be added
```

## Checks

```bash
npm test
npm run build
npm run hero:check                                   # the sidecar's selftest, from a source checkout
npm run hero:check -- release/linux-unpacked/resources/hero   # ...or on a packaged build
npm run check:package                                # verify a packaged app's asar contains expected files
```

## Credits

CS2Clean is a fork of [cheatscanner.eu](https://github.com/EspectroDK/cheatscanner.eu)'s companion app.

Player data is provided by [Leetify](https://leetify.com). CS2Clean does not look at demos and makes no accusations — treat a flag as "worth a closer look", not as proof of cheating.

This project have been developed using AI tools - Claude Opus 5.5, Sonnet 5.5, Qwen3.6-35B, and gpt-oss-20b.

