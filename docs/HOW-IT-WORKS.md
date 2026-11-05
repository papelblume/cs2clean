# How CS2Clean works

Back to the [README](../README.md).

This page is for anyone curious about what the app reads, what it sends, and where. For the architecture and the scoring internals, see [DESIGN.md](DESIGN.md).

## What happens in a match

1. CS2 reports the match's players to Steam when the match loads, and the app reads them from Steam's players list (Steam > View > Players).
2. CS2's Game State Integration (GSI) tells the app when warm-up starts and when the match goes live. The overlay appears in warm-up and hides when the match goes live.
3. For each player, the app asks Leetify for their stats (csst.at if Leetify has no profile) and works out their class and reputation score. See [How players are rated](../README.md#how-players-are-rated).
4. Optional sources find your friends in the match. See [Finding friends in your match](FINDING-FRIENDS.md).

## Data sources

| Data source | What it provides |
|-------------|-----------------|
| **Steam's coplay list** | Who is in your match (Steam > View > Players). CS2 reports the roster to Steam when the match loads. |
| **CS2 Game State Integration (GSI)** | When warm-up starts, when the match goes live, the map name, and your own Steam ID. GSI is a feature Valve built into CS2. The app writes a config file into CS2's `cfg` folder and listens on `127.0.0.1:37215`. |
| **Leetify Public API** | Player ratings, stats, and match history. The class and the 0–100 reputation score are computed from this data. |
| **csst.at** *(fallback)* | Stats for players Leetify has no profile for. The app reads csst.at through a headless Chrome driven by a helper program (Ulixee Hero), with a short pause between players. Chrome is downloaded the first time it is needed. |
| **Steam's friends list** *(optional)* | Steam's players list leaves out your friends. With Steam's debug port on, the app reads the status line Steam's friends list shows for each friend ("Competitive - Office [ 5 : 0 ]", read-only, over a local port) and adds friends whose line equals yours. |
| **CS2's `console.log`** *(optional)* | With CS2 launched with `-condebug`, the player list the `status` command prints in the CS2 console (read-only: the app only reads the file). Names that match your friends are added. |
| **Steam profile pages** *(fallback)* | Only when neither of the above is in use: a friend's public Steam profile popup shows the map they are on, up to 10 minutes late. Matches are added as guesses, marked "maybe". |
| **Steam Web API** *(optional)* | Each lobby player's friends list, to mark who is friends with whom, the names of all your friends, to match the `status` list, and the name of a player you add by hand. Needs your own Steam Web API key. |
| **GitHub** | The number of the latest release, for the update banner. |

## Local connections

- **GSI:** the app listens on `127.0.0.1:37215`, an address only your own PC can reach, and CS2 sends its match information there.
- **Steam's debug port** (optional, off unless you turn it on): the app connects to `127.0.0.1:8080` to read the Friends List window.
- **`console.log`** (optional): the app reads new lines from the file CS2 writes when launched with `-condebug`. Nothing is typed into CS2.

## Privacy

- **Your keys:** your Leetify and Steam Web API keys are encrypted with your OS keychain (Windows DPAPI, Linux desktop keyring), or stored as plain text if none is available.
- **What the app contacts:**
  - Leetify.
  - `csst.at` for players Leetify doesn't know. The first time, it also downloads Chrome from `github.com/ulixee/chrome-versions`.
  - `api.steampowered.com`, only if you saved a Steam key. It sends the key and the SteamIDs of the lobby players, plus yours when you run `status`, and the SteamID of a player you add by hand.
  - `steamcommunity.com` for the profile-page fallback, custom profile links and, without a Steam key, the name of a player you add by hand (their public mini-profile page).
  - `api.github.com` for the update check.
- **Stays on your PC:** Steam's debug port and CS2's `console.log` are only read locally, and the only thing the app asks Steam to open is `steam://open/friends`. Links you click (a player's Leetify profile, the pages for getting API keys, the releases page) open in your normal browser.

## Where settings are stored

| System | Folder |
|--------|--------|
| Windows (installed) | `%APPDATA%\CS2Clean` |
| Windows (portable `.zip`) | the `data` folder next to `CS2Clean.exe` |
| Linux | `~/.config/CS2Clean` |

The same folder holds `siren-ignore.txt`, the list of players the siren leaves out (one SteamID per line; **Settings > Ignore list** opens it).

The portable zip has a `portable.txt` file next to `CS2Clean.exe`. While it is there, the app keeps its settings, API keys, logs and downloads in the `data` folder beside it, so deleting the whole folder removes the app. The one thing outside it is `gamestate_integration_cs2clean.cfg` in CS2's `cfg` folder, which is harmless to leave.
