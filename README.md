# CS2Clean

**Know your lobby before the first round.**

A desktop companion and in-game overlay for CS2 that automatically checks player reputations using Leetify's Public API. When a match loads, CS2Clean looks up the first 10 players and shows each one's reputation score (0–100, 100 = nothing unusual) and classification: **Normal**, **Elevated**, **High**, **Very high**, or **Not enough data**.

## What it does

- **Lobby check** — when a match loads, reads the player list from Steam and looks up each player on Leetify
- **In-game overlay** — a transparent, click-through window on top of the game showing player cards with reputation scores, classifications, aim/clutch ratings, and Leetify's own stats. It appears automatically in warm-up and hides when the match goes live
- **Siren alert** — plays an audible alert when a High or Very high player is detected
- **Player cards** — detailed view for each player: performance score, reputation tier, reasons for flags, and (for public profiles) recent match history
- **Two scores, different questions** — the performance class measures how far above average a player performs; the reputation score measures how implausible their stats look for their rank. One strong number alone never flags a player. A ban on record is the only hard evidence.
- **Configurable hotkeys** — all overlay keys can be changed in Settings
- **Start with Windows** — optional auto-start, minimized to the taskbar (Windows only)
- **Siren toggle** — turn the alert sound on or off in Settings
- **No game injection** — nothing reads or modifies CS2's memory. The overlay is an ordinary transparent window kept on top of the game

## How it works

| Data source | What it provides |
|-------------|-----------------|
| **Steam's coplay list** | Who is in your match (Steam > View > Players). CS2 reports the roster to Steam when the match loads. |
| **CS2 Game State Integration (GSI)** | When warm-up starts, when the match goes live, the map name, and your own Steam ID. The app writes a config file into CS2's `cfg` folder and listens on `127.0.0.1:37215`. |
| **Leetify Public API** | Player ratings, stats, and match history. Two scores are computed from this data: a performance class and a 0–100 reputation score. |

**Privacy note:** The Leetify API key is encrypted with your OS keychain (Windows DPAPI, Linux desktop keyring) and stored in the app's settings file. If no keychain is available, it is stored as plain text.

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

- **Windows** — installer (NSIS) or portable `.exe` from [GitHub releases](https://github.com/EspectroDK/CS2Clean/releases)
- **Linux** — AppImage or tar.gz from [GitHub releases](https://github.com/EspectroDK/CS2Clean/releases)

## Installation (Windows)

1. Download the latest release from the [GitHub releases page](https://github.com/EspectroDK/CS2Clean/releases)
2. Run the installer (per-user, no admin required) or the portable `.exe` (no installation)
3. Start CS2 and launch CS2Clean
4. Paste your Leetify API key if you have one
5. Restart CS2 once (so it loads the GSI config), then join a match

The installer adds Start menu and desktop shortcuts. Settings are stored in `%APPDATA%\CS2Clean`.

**SmartScreen:** The installer is not yet code-signed. Windows will show "Windows protected your PC" — click **More info**, then **Run anyway**.

## Installation (Linux)

### Pre-built binaries

1. Download the latest AppImage or tar.gz from [GitHub releases](https://github.com/EspectroDK/CS2Clean/releases)
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
git clone https://github.com/EspectroDK/CS2Clean.git
cd CS2Clean
npm ci
npm start
```

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
| "Couldn't find CS2's folder" | The app can still read Steam's players list; GSI won't detect match phases. Install CS2 in a standard location. |
| "CS2 is running as administrator" | Start CS2Clean as administrator too, or start CS2 without admin rights |
| Overlay not visible in CS2 | Make sure CS2 is in **Fullscreen Windowed** mode, not plain Fullscreen |
| `chrome-sandbox` error on Linux | Run the `chown`/`chmod` commands above |
| Leetify rate limits | Get a free API key from leetify.com/app/developer |

## Checks

```bash
npm test
npm run build
```

## Credits

CS2Clean is a fork of [cheatscanner.eu](https://github.com/EspectroDK/cheatscanner.eu).

Player data is provided by [Leetify](https://leetify.com). CS2Clean does not look at demos and makes no accusations — treat a flag as "worth a closer look", not as proof of cheating.

This project have been developed using AI tools - Claude Opus 5.5, Sonnet 5.5, and Qwen3.6-35B.
