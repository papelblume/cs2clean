# Cheatscanner app

The desktop companion and in-game overlay. When a CS2 match loads, it looks every player up on
[Leetify](https://leetify.com) (Leetify's Public API) and shows a class: Normal, Elevated, High, Very high, or
not enough data, with the number of recent Leetify matches it is based on. For flagged players, **F7** shows an
extended card (score, average match rating, strong matches, aim and clutch ratings, latest matches), and a
siren plays when a High or Very high player is in your match.

The class is a **performance** class: it says how far above average a player's Leetify ratings are, not whether
anyone cheats (see [How the classes are computed](#how-the-classes-are-computed)). Data: Leetify.

It runs as a plain Electron app, **without Overwolf**. Nothing in it reads or changes CS2's memory,
injects into the game or hooks its drawing:

- **Who is in the match**: Steam's "recently played with" list (Steam > View > Players). CS2 reports
  everyone in your match to Steam when the match loads; a small helper process reads that list from the
  running Steam client. It has no teams, so the list shows one group of players.
- **When the match starts**: CS2's Game State Integration. The app writes
  `gamestate_integration_cheatscanner.cfg` into CS2's `cfg` folder (restart CS2 once after the first
  start) and listens on `127.0.0.1:37215`.
- **Overlay**: a see-through window kept on top of the game; clicks go through to the game. It shows
  itself in warm-up and hides when the match goes live. Needs CS2's display mode **Fullscreen Windowed**
  (Settings > Video); in plain Fullscreen, Windows draws the game over it.

| Key | What it does |
| --- | --- |
| **Shift+F2** | Show the lobby list (again to hide) |
| **F7** | Show the extended card of flagged players (again to hide) |

<<<<<<< ours
Settings also has "Start automatically with Windows, minimized" (installed app only; it starts with
`--minimized`). Both keys can be changed under Settings in the app (letters and digits only with Ctrl or Alt). The server
address is not a setting: the installed app always uses https://cheatscanner.eu (`--server` and
`CHEATSCANNER_SERVER` are for development).
=======
Settings also has "Start automatically with Windows, minimized" (installed Windows app only; it starts with
`--minimized`). Both keys can be changed under Settings in the app (letters and digits only with Ctrl or Alt).

## Leetify API key

Lookups work without a key, at Leetify's stricter rate limits. A free key from
https://leetify.com/app/developer makes them reliable: paste it into the app's window (it is checked with Leetify
before it is saved), or set `LEETIFY_API_KEY` in the environment. A saved key wins over the variable.

Leetify's API has no batch lookup, so a full lobby is up to 10 requests (3 at a time). Answers are kept for 15
minutes, and a player Leetify rate-limits is asked for again after the pause Leetify names. Only players with a
public Leetify profile have data; the others show "Not enough data" (hover for the reason).
>>>>>>> theirs

## Running it (Windows PowerShell, one command per line)

Steam must be running and signed in. Then:

```powershell
cd companion
npm ci
npm start
```

Paste your Leetify API key if you have one, restart CS2 once, and join a match.

To check what the app sees from Steam, run this in a match's warm-up. It prints Steam's players list with
times and the players the app would pick as your match:

```powershell
npm run coplay
```

Without CS2, `npm run start:replay` plays a recorded session (`fixtures/premier-mirage.jsonl`: warm-up,
then live after 30 s). To use one of your own analyzed matches:

```powershell
node tools/replay-from-match.mjs <matchId>
npx electron . --replay=fixtures/local-match.jsonl
```

(Replay mode needs a cheatscanner.eu server to build the recording; the replayed players' Steam IDs are not
real Leetify players, so the overlay will show them as "Not enough data".)

Other options, passed after `electron .`:

| Option | What it does |
| --- | --- |
| `--replay` / `--replay=<file>` | Play a recording instead of live data |
| `--dev-ui=<url>` | Load the pages from `npm run dev:ui` (hot reload) |

`npm run dev:ui` also works in a normal browser with a simulated app: open
`http://localhost:5173/index.html?screen=lobby` (or `nokey`, `waiting`, `problem`) and
`overlay.html?screen=lobby` or `overlay.html?screen=detail`.

<<<<<<< ours
=======
## Running it on Linux

Linux works from source, with native Steam and native CS2. There is no packaged Linux build yet.

Requirements:

- **Steam**, the native package (not Flatpak or Snap: their sandboxes keep the Steam client out of reach of
  other processes), running and signed in. The app finds it in `~/.steam/debian-installation` or
  `~/.local/share/Steam`.
- **CS2**, native, in one of Steam's libraries (found through `libraryfolders.vdf`), with display mode
  **Fullscreen Windowed**.
- **An X11 session.** The overlay window and its global hotkeys have been tried on X11 (Linux Mint 22.3,
  Cinnamon); Wayland is untested.
- **Node 22.12 or newer** (`engines` in `package.json`; tested with Node 24). Distro packages are often
  older, so check `node --version` and use nvm, NodeSource or similar if needed.

```bash
cd companion
npm ci
npm start
```

Replay mode, the other options and `npm run dev:ui` above work the same in a Linux shell.

Paste your Leetify API key if you have one (or start with `LEETIFY_API_KEY=... npm start`), restart CS2 once,
and join a match. On first start the app writes
`gamestate_integration_cheatscanner.cfg` into
`<Steam library>/steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg/`.

`npm run coplay` prints Steam's players list; compare it with Steam > View > Players. If it says Steam isn't
running, check that native Steam is signed in and that `~/.steam/steam.pid` names a live process.

If Electron refuses to start with a `chrome-sandbox` (SUID sandbox) error, which distros that restrict
unprivileged user namespaces do (Ubuntu 24.04 and its derivatives), give the bundled helper the permissions it
needs:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Settings are kept in `~/.config/Cheatscanner`. The Leetify API key is encrypted with the
desktop keyring through Electron's `safeStorage`; with no keyring available it is stored as plain text in
`settings.json`. "Start automatically with Windows" and the installer and Store packages are Windows only.

>>>>>>> theirs
## Building the installer (Windows PowerShell, one command per line)

```powershell
cd companion
npm ci
npm run dist
```

This writes `release\Cheatscanner-Setup-<version>.exe` (the version comes from `package.json`). The installed
app talks to Leetify's Public API.
It installs per user (no admin prompt), adds Start menu and desktop shortcuts, and keeps its settings in
`%APPDATA%\Cheatscanner`, the same place `npm start` uses, so a saved API key carries over.

The installer isn't code-signed yet, so Windows SmartScreen shows "Windows protected your PC" the first
time: click **More info**, then **Run anyway**. Signing needs a code-signing certificate; electron-builder
picks one up from `CSC_LINK` / `CSC_KEY_PASSWORD`.

Build on Windows. On Linux or macOS, electron-builder needs Wine for the Windows installer.

## Microsoft Store package

```powershell
cd companion
npm ci
npm run dist:store
```

This writes `release\Cheatscanner-<version>.appx`, an MSIX-family package with the Store identity from
Partner Center (`build.appx` in `package.json`). Upload it in Partner Center under the app's submission,
Packages. Microsoft signs it after certification, so no certificate is needed, and the Store handles updates
(raise `version` in `package.json` for each new upload). It must be built on Windows 10 or 11. The tile images
are in `assets/appx`.

### Releases from GitHub

Actions > **companion-release** > Run workflow, with a version such as `0.2.0` (or push a tag
`companion-v0.2.0`). It builds the installer and the Store package on Windows with that version, attaches both
to a GitHub release, and submits the package to the Store when the `PARTNER_CENTER_*` secrets exist (see the
top of `.github/workflows/companion-release.yml`). The first Store submission is made by hand in Partner Center;
later ones reuse its listing.

Differences from the `.exe` install: "Start automatically with Windows" isn't offered (Store apps can't add
a plain login item), and Windows may keep the app's settings in a separate place, so the API key has to be
entered again once.

## Overwolf (optional)

The Overwolf route still works if Overwolf approves the app: `npm run start:overwolf` (ow-electron with
`--overwolf`) takes the roster from Overwolf's CS2 game events and draws the overlay with Overwolf's
overlay package. `--record` then saves Overwolf's CS2 data to `%APPDATA%\Cheatscanner\recordings`.

## How it fits together

```text
Steam players list ─┐ (helper process)          ┌─ desktop window (src/renderer/desktop.tsx)
CS2 game state ─────┼─► GameSource ─► Controller ─┤
 (or Overwolf,      │   game/*.ts        │        └─ overlay window (src/renderer/overlay.tsx)
  or a replay)      │                    ▼
                    │            LobbyService ─► leetify.ts ──HTTPS──► Leetify Public API  GET /v3/profile
                    │                              └─► assess.ts (ratings ─► class)
```

- `src/main/steam/`: `coplay.ts` (reads Steam's players list; runs in `coplay-worker.ts`, a separate
  process), `pick.ts` (picks the current match from the list), `gsi.ts` (CS2 game state: cfg file and
  listener), `coplay-cli.ts` (`npm run coplay`).
- `src/main/game/`: `steam.ts` (default source), `overwolf.ts`, `replay.ts`, `gep.ts`, `recorder.ts`.
- `src/main/leetify.ts` (Leetify client: key header, error kinds, Retry-After, a few requests at a time),
  `src/main/assess.ts` (profile ─► class), `src/main/lobby.ts` (cache, retries), `src/main/leetify-cli.ts`
  (`npm run leetify:probe`).
- `src/main/controller.ts`: API key, lobby lookups, overlay visibility (warm-up / live / hotkeys), siren;
  no Electron code, so it is unit-tested.
- `src/main/main.ts`: windows, hotkeys, IPC, the helper process.
<<<<<<< ours
- `src/main/preload.ts`: the only bridge the pages get. The token stays in the main process, encrypted
  with Windows DPAPI (`safeStorage`) in `settings.json`.
=======
- `src/main/preload.ts`: the only bridge the pages get. The API key stays in the main process, encrypted
  with the OS key store (`safeStorage`: Windows DPAPI, the desktop keyring on Linux) in `settings.json`.
>>>>>>> theirs

## How the classes are computed

`src/main/assess.ts` combines three numbers from `GET /v3/profile`: the `leetify_rating` of the newest 30
`recent_matches` (their average, and the share of strong matches), the profile's `rating.aim`, and its
`rating.clutch`. Each becomes a 0 to 1 signal (match rating 50%, aim 35%, clutch 15%), and the combined score
picks the class. A class also needs the signals to agree: one strong number alone never flags a player (aim 99 with
ordinary results stays Normal), and Very high needs both a very high match rating and a high aim. Fewer than 10
scored matches, a private profile or missing ratings give "Not enough data". All the cut-offs are in `THRESHOLDS`.

What this does and does not tell you: Leetify ratings measure how well someone plays. Top-rank players, pros and
smurfs score high too, and nothing here looks at demos, so there is no wall-hack or aim-lock signal. The cut-offs are
starting points that have not been checked against known cheaters. Treat High and Very high as "this player is far
above average", not as an accusation.

Units: Leetify's website shows match ratings and clutch like "+5.32", and the API may send them as fractions
(0.0532) or in the website's units; the docs don't make this obvious. The code reads the matches' own size to tell
which (website-sized values mean website units; fractions never exceed 1), and a test covers both. It was written
without calling the live API, so run the probe once to confirm what you get, which also shows the numbers next to what
the app computes, for tuning `THRESHOLDS`:

```bash
LEETIFY_API_KEY=... npm run leetify:probe -- 76561198000000000 76561198000000001
```

## Checks

```powershell
npm test
npm run build
```

To offer it on the website's front page, send it to the server with `tools\deploy\push-companion.ps1`
(see `docs/deploy/hetzner.md`, section 10).
The app is also in the Microsoft Store (https://apps.microsoft.com/detail/9N3R274VP3GV); the front page links
there first and offers the installer from the server as a fallback.
