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
- **Coplay worker**: Separate utility process that reads Steam's players list (isolated from the app so a Steam client quirk can't crash it)
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
  leetify: { hasKey: boolean; reachable: boolean | null };
  notice: string | null;
  game: { source: GameKind; running: boolean; problem: string | null };
  match: { map: string | null; mode: string | null; phase: MatchPhase | null } | null;
  lobby: { rows: LobbyRow[]; updatedAt: Date | null; error: string | null };
  overlay: { mode: OverlayMode; visible: boolean; view: ViewKind; focusSlot: number | null; siren: boolean; hotkey: string; detailHotkey: string; cycleHotkey: string; previousHotkey: string };
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
  on("match", (m: MatchState)): void;
}
```

**Steam** (`steam.ts`):
- Reads players from Steam's "recently played with" list via native coplay API
- Uses CS2 Game State Integration (GSI) for match phases, map name, local Steam ID
- Does NOT provide team information (Steam's API doesn't include it)
- Fills missing players with Steam friends on the same map or in the same party

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
- Scrapes csst.at as a fallback (requires Node 22 for Ulixee Hero)

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
- **Mechanics**: extreme values for rank (preaim, reaction time, headshot accuracy, spray accuracy, opening duels)
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
  siren?: boolean;                  // Default: true
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

**Test coverage**: 9 test files, 95 tests covering controller, assess, reputation, leetify, hotkeys, lobby, and more.

**Replay fixture**: `fixtures/premier-mirage.jsonl` — hand-written test data for replay mode without CS2.

## Key Design Decisions

1. **No game injection**: The overlay is an ordinary transparent window kept on top of the game. Nothing reads or modifies CS2's memory.

2. **Two scores, different questions**: Performance class measures how far above average a player performs; reputation score measures how implausible their stats look for their rank.

3. **Signal agreement**: One strong number alone never flags a player. The worst tiers require two active signal families.

4. **Steam friends fill-in**: When the coplay list is short, the app tops it up with Steam friends playing on the same map or in the same party.

5. **csst.at fallback**: When Leetify's API returns "not found", the app fetches profiles from csst.at as a fallback (requires Node 22).

6. **GSI config auto-write**: The app writes `gamestate_integration_cs2clean.cfg` into CS2's `cfg` folder on first start.

7. **Process isolation**: Steam coplay reading runs in a separate utility process to prevent Steam client quirks from crashing the app.

8. **Encrypted API key**: The Leetify API key is encrypted with the OS keychain (Windows DPAPI, Linux desktop keyring).
