# CS2Clean Design Document

## Overview

CS2Clean is an Electron desktop companion with a CS2 in-game overlay that checks player reputations using Leetify's Public API. When a match loads, the app looks up the first 10 players and shows each one's reputation score (0–100, 100 = nothing unusual) and performance classification.

The app does not look at demos and makes no accusations. Treat a flag as "worth a closer look", not as proof of cheating.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Electron App                         │
├──────────────────────┬──────────────────────────────────────┤
│   Main Process       │   Renderer Process                   │
│                      │                                      │
│  ┌───────────────┐   │   ┌──────────────────────────────┐   │
│  │   Controller  │───┼──►│   Desktop Window (React)     │   │
│  │               │   │   │   - Lobby list               │   │
│  └───────┬───────┘   │   │   - API key input            │   │
│          │           │   │   - Settings panel           │   │
│  ┌───────▼───────┐   │   └──────────────────────────────┘   │
│  │  Game Source  │   │                                      │
│  │  (Steam/      │   │   ┌──────────────────────────────┐   │
│  │   Overwolf/   │   │   │   Overlay Window (React)     │   │
│  │   Replay)     │   │   │   - Player cards             │   │
│  └───────┬───────┘   │   │   - Flagged players view     │   │
│          │           │   └──────────────────────────────┘   │
│  ┌───────▼───────┐   │                                      │
│  │  LobbyService │   │                                      │
│  │               │   │                                      │
│  └───────┬───────┘   │                                      │
│          │           │                                      │
│  ┌───────▼───────┐   │                                      │
│  │ LeetifyClient │   │                                      │
│  └───────────────┘   │                                      │
├──────────────────────┴──────────────────────────────────────┤
│  Shared Types (lobby-order.ts, types.ts)                    │
└─────────────────────────────────────────────────────────────┘
```

### Process Separation

- **Main process**: Controller, game sources, lobby service, Leetify client, window management, IPC, hotkeys
- **Coplay worker**: Separate utility process that reads Steam's players list (isolated from the app so a Steam client quirk can't crash it). Uses [`koffi`](https://github.com/felixge/node-koffi), a native FFI library, to call Steam's native API without a full native addon.
- **Friend finding** (see below) uses plain `fs` and `fetch` in the main process; only the coplay read is isolated in the utility process
- **Renderer**: Two React windows (desktop + overlay), both receive state via IPC and use the bridge for IPC calls

## Components

### Controller (`src/main/controller.ts`)

The central state machine. Connects game sources to the lobby service, manages settings, and publishes state to both windows.

**Responsibilities:**
- API key management (validate, save, clear)
- Hotkey registration and validation
- Match lifecycle (warm-up → live → gameover)
- Lobby lookups and caching
- Overlay visibility control
- Siren alert management

**State model:**
```typescript
interface AppState {
  version: string;
  leetify: { hasKey: boolean; reachable: boolean | null; fallback: { working: boolean | null; reason: string | null } };
  steam: { hasKey: boolean };
  notice: string | null;
  game: { source: GameKind; running: boolean; problem: string | null };
  match: { map: string | null; mode: string | null; phase: MatchPhase | null } | null;
  lobby: { rows: LobbyRow[]; updatedAt: string | null; error: string | null; cycle: number[] };
  overlay: { hotkey: string; detailHotkey: string; cycleHotkey: string; previousHotkey: string; mode: OverlayMode; visible: boolean; view: ViewKind; focusSlot: number | null; siren: boolean };
  hotkeysEditable: boolean;
  startWithWindows: boolean | null;
  alert: { seq: number; names: string[] };
}
```

### Game Sources (`src/main/game/`)

Abstract interface for reading match data from different platforms:

```typescript
interface GameSource extends EventEmitter {
  kind: "steam" | "overwolf" | "replay";
  start(): void;
  stop(): void;
  refresh(): void;
  on("running", (running: boolean)): void;
  on("problem", (problem: string | null)): void;
  on("hint", (hint: string | null)): void;   // a suggestion that isn't a problem; null clears it
  on("match", (m: MatchState)): void;
}
```

**Steam** (`steam.ts`):
- Reads players from Steam's "recently played with" list via native coplay API
- Uses CS2 Game State Integration (GSI) for match phases, map name, local Steam ID
- Does NOT provide team information (Steam's API doesn't include it)
- Fills missing players with friends, which the coplay list leaves out (see "Finding friends in the match")

**Overwolf** (`overwolf.ts`):
- Uses Overwolf's Game Events Provider (GEP) for CS2 game events
- Provides team information (T/CT) from `match_info.roster_N.team`
- Requires Overwolf approval for the app
- Uses Overwolf's built-in overlay rendering

**Replay** (`replay.ts`):
- Plays a recorded session from a JSONL file
- For testing without CS2 running
- Recording format: `{"t": <ms>, "kind": "running"|"info", "value": <data>}`

**GEP** (`gep.ts`):
- Parses Overwolf GEP info updates into a MatchState
- Handles roster entries, map/mode detection, phase transitions
- Extracts team info from roster entries

### Finding friends in the match (`src/main/steam/`)

Steam's coplay list leaves out people who are already your friends. What was tried for finding them, and found empty on both Windows and Linux: the game server address and lobby ID in the Steam client's game info (CS2 reports neither, and the Web API's `gameserverip` and `lobbysteamid` are empty too), and rich presence through the Steam client interface, even after `RequestFriendRichPresence` (Steam appears to give it only to the game itself). What does work:

| Source | Modules | Needs | Nature |
|--------|---------|-------|--------|
| `status` names | `console-log.ts`, `name-match.ts`, `friend-names.ts` | CS2 launched with `-condebug`; the user runs `status` | Exact |
| Friends list status lines | `steam-ui.ts`, `steam-ui-page.ts`, `friends-window.ts` | Steam's debug port on | Live, matched on an identical line |
| Mini-profile | `miniprofile.ts` | Nothing; used only when neither above is in use | A guess, up to ~10 minutes old |

`capabilities.ts` says what is available and why not; `game/steam.ts` runs it all.

**Capabilities** (`capabilities.ts`). Every system touch goes through an injectable `io`, so the decisions are tested.
- *Debug port*: probed at `127.0.0.1:<port>/json`. On Linux the port comes from Steam's web helper command line in `/proc` (`--remote-debugging-port=8080`), else `CS2CLEAN_DEBUG_PORT`, else 8080. A closed port is explained: Steam not running, running without the flag, or the flag file (`.cef-enable-remote-debugging`) present but Steam not restarted. On Windows the command line isn't read, so a closed port is just "unknown".
- *console.log*: `game/csgo/console.log` next to CS2's `cfg` folder. It is "active" when written to since the session began; `profileFallbackWanted` also counts a write within the last two hours as in use, because the app may have started mid-match.
- `friendsHint` and `profileFallbackWanted` are pure functions of these, and `main.ts` shares one look at them (at most every 10 s) between the hint and the fallback.

**Friends list** (`steam-ui.ts`). Steam's friends list shows each friend's rich presence ("Competitive - Office [ 5 : 0 ]": mode, map and score). With the debug port on, the app evaluates a read-only script in the Friends List page over the local DevTools protocol, joins the rows to the Steam client's friends in CS2 by persona name, and adds friends whose line equals ours. They are re-checked on every scan: they stay while they remain in our mode and map (two players' scores can differ for a moment at a round end) and drop out when they leave. A failed read keeps what was found before. The window's title is localized, so `isFriendsWindowTitle` knows all 26 titles Steam uses.

**Opening the window** (`friends-window.ts`). When the window is closed the app asks Steam for it with `steam://open/friends`, the only address it ever opens, then waits up to 5 s for the page to appear. Rules: only with the debug port reachable and the setting (`autoOpenFriendsList`, on by default) on; once after start-up (first try 12 s in, so a running CS2 has sent a heartbeat; up to 8 tries 15 s apart while Steam may still be starting) and in a match's warm-up while a friend is in CS2 and a slot is empty; never in a live round, at half-time or on the end screen; at most once a minute and 3 times per match; one try at a time.

**`status`** (`console-log.ts`, `name-match.ts`, `friend-names.ts`). `LogTailer` polls the file every 250 ms, starts at its end (a file that appears later is read from its start), and copes with truncation, replacement, CRLF, half-written lines and characters split across reads. `StatusParser` reads the block `status` prints (`---------players--------` ... `#end`), skipping bots and `[NoChan]` slots; it carries names, not Steam IDs, so the names are matched to friends: the ones Steam says are in CS2 (with names, from `coplay.ts`) plus, with a key, all friends from the Web API (`GetFriendList` + `GetPlayerSummaries`, batches of 100, cached 5 minutes, a failure remembered as long). A name counts only when it fits exactly one friend and one lobby entry; players the app already has, and the user, use up lobby entries first, so a stranger and a friend with the same name aren't mixed up. Lists are accepted only while in a match, an arriving list triggers a scan at once (or right after the one running), and matched friends stay for the match.

**Mini-profile** (`miniprofile.ts`). A friend's rich presence from `steamcommunity.com/miniprofile/<account id>`, which anyone can read. It is a fallback because the page refreshes only about every 10 minutes: only map and mode are used (never the score), friends on our map in a mode that can be ours are added only if they all fit the empty slots (otherwise none: the lines are too old to tell who is in this match), they are marked `via: "profile"` (a "maybe" badge), and they are worked out afresh each scan. Lookups are cached for 2 minutes, share a request in flight, and back off for 5 minutes after a 429 or a Steam error. Up to 12 friends per scan.

**Roster** (`game/steam.ts`). The players we are sure of come first: the players list, then `status` friends, then friends-list friends, each friend once, up to the mode's size (a friend both of the last two find counts as a `status` friend). The mini-profile's guesses come after, and never count towards the match being complete or take a slot from an exact source.

**Hint**. While a friend is playing CS2 and a slot is empty, `game.hint` carries one line (shown in the overlay and window): nothing when the friends list will find them by itself or `status` has been run, otherwise a prompt to run `status`, with what it needs (`-condebug`) and what the friends list needs when those aren't set up. It is worked out at most every 15 s.

Every source fails closed: when one can't be read, nothing is added and the others carry on. `npm run friends-ui` and `npm run console-status` show what each can see.

### Lobby Service (`src/main/lobby.ts`)

Manages player lookups and caching:
- Looks up players on Leetify when a match loads
- Caches results per match
- Handles rate limiting and retries
- Tops up player list with scraped data from csst.at when API returns "not found"
- Only looks up the first 10 players

### Leetify Client (`src/main/leetify.ts`)

HTTP client for Leetify's Public API:
- Validates API keys
- Fetches player profiles by Steam ID
- Handles rate limiting and retries
- Scrapes csst.at as a fallback, through the Hero sidecar (see below)

### csst.at fallback: the Hero sidecar (`src/main/leetify-hero.ts`, `hero-runtime/`)

Players Leetify has no profile for are looked up on csst.at with Ulixee Hero. Hero needs `better-sqlite3`, a native
module that must be built for the Node that loads it. electron-builder rebuilds native modules for Electron's ABI, and
Electron's Node is not the Node that Hero can use, so Hero cannot live inside the app. It lives next to it:

```
packaged app   <resources>/hero/   cli.js, node_modules/, bin/node(.exe)      (electron-builder extraResources)
source build   <repo>/hero-runtime/                                           (npm run hero:install, npm run build)
```

- `hero-runtime/package.json` and its own lockfile pin Hero. It is **not** in the app's `package.json`, so electron-builder
  never sees it and nothing is rebuilt for Electron.
- `bin/node` is a copy of the Node 22 that ran `npm ci` in `hero-runtime/`, so `better-sqlite3` is always loaded by the
  Node it was installed with. The app starts `cli.js` with it as a child process (`src/main/leetify-hero-cli.ts`, bundled by
  `tools/build-hero-runtime.mjs`). Nothing here is inside `app.asar`: a Node that isn't Electron can't read inside one.
- `package.json` lists two `extraResources` entries for it, one for the folder and one for `hero-runtime/node_modules`.
  That is not redundancy: electron-builder drops a root-level `node_modules` from any `extraResources` source
  (`app-builder-lib/out/util/filter.js`) whatever the patterns say, and a single entry silently packaged Node without Hero.
- Chrome (370 MB on disk for Chrome 139) is not packaged. The first lookup that needs it downloads it into `<data>/hero-browsers` in the
  background; lookups don't wait for it, they ask again a minute later.
- On Linux Mint, Hero crashes on `cat /etc/upstream-release` (a folder there), so the child gets a `cat` shim first on its
  PATH, written under the data folder.
- Overrides: `CS2CLEAN_HERO_DIR` (the sidecar folder), `CS2CLEAN_NODE22` (the Node to run it with), `CS2CLEAN_DATA_DIR`.

**Failures are never silent.** Every way the fallback can break ends as a `HeroStatus` with a problem kind
(`no-runtime`, `no-node`, `spawn-failed`, `setup-failed`, `abi-mismatch`, `native-load`, `module-missing`, `browser-missing`,
`site-unreachable`, `timeout`, `crashed`, `bad-output`), a reason in plain words, and the raw error text. It is logged to the
console and to `hero.log` in the data folder (the console is invisible in a packaged app), and the desktop window shows
"csst.at fallback unavailable" with the reason. A player the fallback couldn't check gets a note saying so, not "profile
isn't public". Problems that can clear up by themselves (`browser-missing`, `site-unreachable`, `timeout`) are asked again
later; build problems are not. `classifyHeroFailure()` maps what actually happened (the OS's error for starting Node, a
timeout, the CLI's JSON error, Node's own `NODE_MODULE_VERSION` crash text) to those kinds.

Checks: CI runs `npm run hero:install` (which ends with the sidecar's selftest: Hero and `better-sqlite3` load, a database
opens) and then `node tools/build-hero-runtime.mjs check release/<platform>-unpacked/resources/hero` on the **packaged** copy.

### csst.at HTML parser (`src/main/csst-parse.ts`)

Pure JS function that parses csst.at's HTMX HTML response into a `LeetifyProfile`. No native or Electron dependencies —
its only caller is the Hero sidecar's CLI (`leetify-hero-cli.ts`), which is bundled into `cli.js` and runs under a
different Node. The main process just re-exports it from `leetify-hero.ts` (that is how the tests import it). Extracts aim, utility,
rating, preaim, reaction time, headshot kills (csst.at's "HS kills", the share of kills that were headshots: not the
API's headshot accuracy, so it goes into `stats.headshot_kill_percentage`, is shown as "Headshot kills" and scored on its own range),
spray accuracy, counter-strafing ratio, and total games from the HTML by matching element IDs like `leetify-aim-{steamId}`.

### Scoring System

Two independent scores computed from the same Leetify profile:

#### Performance Class (`src/main/assess.ts`)

**Question**: "How far above average does this player perform?"

**Signals**:
- Leetify rating (50% weight) — from recent matches or overall rating
- Aim rating (35% weight)
- Clutch rating (15% weight)

**Classes**: NORMAL, ELEVATED, HIGH, VERY_HIGH, INSUFFICIENT_DATA

**Rules**:
- One strong number alone never flags a player — signals must agree
- VERY_HIGH requires both rating AND aim signals to be strong
- Score is discounted for thin data (few matches)
- Not evidence of cheating — top players, pros, and smurfs score high too

#### Reputation Score (`src/main/reputation.ts`)

**Question**: "How implausible do the numbers look, given the player's skill and rank?"

**Signal families**:
- **Mechanics**: extreme values for rank (aim rating and reaction time count most, then preaim, headshot accuracy, headshot kills (csst.at data only), spray and spotted accuracy, opening duels, counter-strafing). The ranges are the pros' stats; a lower Premier rating or FACEIT level slides them down by half the gap to the average player of that rank (`src/main/rank-means.ts`, Leetify's Performance Metric Tool, September 2026). Premier 20k and up counts as the top, because those averages are skewed by cheating accounts.
- **Coherence**: stats that contradict each other (high aim but low positioning/utility, high headshot accuracy but low stopping)
- **Trajectory**: sudden improvements, unnaturally steady reaction times, FACEIT vs non-FACEIT divergence

**Tiers**: TRUSTED, NORMAL, WATCH, SUSPICIOUS, VERY_SUSPICIOUS, BANNED, UNKNOWN

**Rules**:
- A ban on record decides everything (BANNED, score 0)
- Worst tiers require two active families
- Score is 0–100 (100 = nothing unusual)
- Not proof of cheating — only a ban is hard evidence

### Overlay (`src/renderer/overlay.tsx`)

Transparent, click-through window on top of CS2:
- Shows player list grouped by team (CT → T → unknown)
- Appears automatically in warm-up, hides when match goes live
- F6: cycle through player cards (one at a time)
- F7: show flagged players
- Shift+F6: step backward through cards
- Plays siren when HIGH/VERY_HIGH player detected

### Desktop Window (`src/renderer/desktop.tsx`)

Full-featured window for setup and monitoring:
- API key input and validation
- Lobby list with player details
- Settings panel (hotkeys, siren toggle, auto-start)
- Leetify status indicator
- csst.at fallback status: shown only when it can't be used, with the reason

## Data Flow

```
Game Source → MatchState → Controller → LobbyService → LeetifyClient
                                                    ↓
                                              Player Profiles
                                                    ↓
                                    assessProfile() + assessReputation()
                                                    ↓
                                               LobbyRow[]
                                                    ↓
                                    IPC → Renderer (Desktop + Overlay)
```

## Settings

Stored in `%APPDATA%\CS2Clean` (Windows) or `~/.config/CS2Clean` (Linux):

```typescript
interface Settings {
  leetifyKey?: string | null;      // Encrypted with OS keychain
  steamApiKey?: string | null;     // Optional, encrypted: friendship badges, and friend names for `status`
  siren?: boolean;                  // Default: true
  autoOpenFriendsList?: boolean;    // Open Steam's friends list window when needed. Default: true
  hotkeys?: Partial<Hotkeys>;       // Custom hotkeys
}
```

**Hotkey format**: Electron accelerators (e.g., "Shift+F2", "Ctrl+Alt+K")
**Constraints**: Letters and digits require Ctrl or Alt (to avoid blocking typing)

## Build and Distribution

### Build Pipeline

```
TypeScript → Vite (renderer) + tsc (main) → Electron
                                              ↓
                                    electron-builder
                                              ↓
                         Windows: NSIS installer + portable .exe
                         Linux: AppImage + tar.gz
```

The release workflow also runs `npm run hero:install` before packaging and checks the packaged sidecar afterwards
(`tools/build-hero-runtime.mjs check`). The sidecar adds the bundled Node 22 (about 120 MB unpacked) and Hero to every build.

### Package Verification

```bash
npm run check:package    # verify a packaged app's asar contains expected files
```

Runs `electron-builder --linux dir --x64` to create a dir output, then `tools/check-package.mjs` inspects the
`app.asar` to ensure critical files are present and nothing unexpected is included. Useful for catching packaging
regressions before publishing.

### Release Tags

Push a tag to trigger the GitHub Actions workflow:
```bash
git tag cs2clean-v0.2.0
git push origin cs2clean-v0.2.0
```

Artifacts:
- `CS2Clean-Setup-<version>.exe` — NSIS installer (Windows)
- `CS2Clean-<version>-portable.exe` — portable executable (Windows)
- `CS2Clean-<version>.AppImage` — AppImage (Linux)
- `CS2Clean-<version>.tar.gz` — tarball (Linux)

## Testing

```bash
npm test      # Run vitest tests
npm run typecheck  # TypeScript type checking
```

**Test setup**: `test/setup.ts` runs before every test file. It disables the hero sidecar by setting
`CS2CLEAN_HERO_DIR` to `/nonexistent/...` so tests that reach the fallback get a fast "no-runtime" status instead of
spawning Node or downloading Chrome. Tests of the sidecar itself set `CS2CLEAN_HERO_DIR` to a stub of their own.

**Test coverage**: controller, assess, reputation, leetify, hotkeys, lobby, and the Steam source and friend finding: `steam.test.ts`, `steam-ui.test.ts`, `capabilities.test.ts`, `friends-window.test.ts`, `console-log.test.ts`, `name-match.test.ts`, `friend-names.test.ts`, `status-friends.test.ts`, `miniprofile.test.ts` and `profile-friends.test.ts`, among others. Run `npm test` for the current count.

**Hero sidecar tests**: `test/hero-sidecar.test.ts` (316 lines) covers `classifyHeroFailure` and all failure modes
(abi-mismatch, native-load, module-missing, browser-missing, spawn errors, timeouts, crashes...).

**Replay fixture**: `fixtures/premier-mirage.jsonl` — hand-written test data for replay mode without CS2.

**Console fixture**: `fixtures/console-status.log` — a real `status` block as CS2 wrote it to `console.log` (names replaced), for the parser tests.

## Key Design Decisions

1. **No game injection**: The overlay is an ordinary transparent window kept on top of the game. Nothing reads or modifies CS2's memory.

2. **Two scores, different questions**: Performance class measures how far above average a player performs; reputation score measures how implausible their stats look for their rank.

3. **Signal agreement**: One strong number alone never flags a player. The worst tiers require two active signal families.

4. **Friend finding from several imperfect sources**: The coplay list leaves out your friends, and nothing the Steam client gives a non-game process (server address, lobby, rich presence) says which match a friend is in. So the app combines what each setup allows, exact where it can be (`status` names), live where it can be (Steam's friends list over the debug port), and a marked guess otherwise (mini-profile). None needs injection: the app only reads a local port and a log file, and only ever asks the system to open `steam://open/friends`. Each source fails closed, exact sources always win over guesses, and the window says what would help when no source can find a friend whose slot is empty. See "Finding friends in the match".

5. **csst.at fallback in a sidecar**: When Leetify's API returns "not found", the app fetches profiles from csst.at through Hero, which runs in a separate folder with its own Node 22 and its own `better-sqlite3` (see "Hero sidecar"). When it can't, the window says so and why.

6. **GSI config auto-write**: The app writes `gamestate_integration_cs2clean.cfg` into CS2's `cfg` folder on first start.

7. **Process isolation**: Steam coplay reading runs in a separate utility process to prevent Steam client quirks from crashing the app.

8. **Encrypted API key**: The Leetify API key is encrypted with the OS keychain (Windows DPAPI, Linux desktop keyring).
