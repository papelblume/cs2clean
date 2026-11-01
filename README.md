
https://github.com/user-attachments/assets/e75a84d9-3591-409e-a9bc-52b89796e756 


<h1 align="left">
  CS2Clean
  <img align="right" width="367" height="284" alt="FACEIT-ban" src="https://github.com/user-attachments/assets/1ab863aa-d131-4393-9be9-9dbc563d929e" />
</h1>

**Know your lobby before the first round.**


A desktop companion and in-game overlay for CS2 that automatically checks player reputations using Leetify's Public API. When a match loads, CS2Clean looks up the first 10 players in your lobby and shows each one's stats, reputation score (0–100, 100 = nothing unusual) and overall class: **Normal**, **Elevated**, **High**, **Very high**, or **Not enough data**.

**Contents:** [What it does](#what-it-does) · [Is it safe?](#is-it-safe) · [Installation](#installation) · [First run](#first-run) · [Keyboard shortcuts](#keyboard-shortcuts) · [How players are rated](#how-players-are-rated) · [API keys](#api-keys) · [Finding friends](#finding-friends-in-your-match) · [Community servers](#community-servers-and-offline-matches) · [Troubleshooting](#troubleshooting) · [More documentation](#more-documentation) · [Credits](#credits) · [License](#license)

## What it does

- **Lobby check** — when a match loads, reads the player list from Steam and looks up each player on Leetify
- **In-game overlay** — a transparent, click-through window on top of the game showing player cards with reputation scores, classifications, and Leetify's stats (aim, clutch, positioning, accuracy, etc.). It appears automatically in warm-up and hides when the match goes live
- **Siren alert** — plays an audible alert when a High or Very high player is detected; turn it on or off in Settings
- **Player cards** — detailed view for each player: class, reputation score, reasons for flags, and (for public profiles) recent match history
- **Ranks at a glance** — each player's Premier rating, FACEIT level and FACEIT Elo, shown right after their name in the window, the overlay list and the player cards
- **Stats, not accusations** — each stat is rated Low, Medium or High, and the reputation score and overall class show how unusual a player's numbers look for their rank. One strong number alone never flags a player (see [How players are rated](#how-players-are-rated))
- **Friend badges (optional)** — with a Steam Web API key (see [API keys](#api-keys)), players in your lobby who are friends on Steam share a colored bar and group badge, in the window and in the overlay. Friendships can run through a third player (A–B and B–C make a group of three), so the badge shows who is connected, not that everyone knows everyone
- **Friends in your match** — Steam's "played with" list does not include players from your friends list, so the app attempts to find who you're playing with using three different methods. See [Finding friends in your match](#finding-friends-in-your-match)
- **Configurable hotkeys** — all overlay keys can be changed in Settings
- **Start with Windows** — optional auto-start, minimized to the taskbar (Windows only)

The app checks for updates on startup (at most once per day). You can also trigger a manual check from Settings.

## Is it safe?

CS2Clean doesn't touch the game itself. In plain terms:

- **No injection.** No code is injected into CS2, and nothing reads or changes its memory. The overlay is an ordinary transparent window kept on top of CS2.
- **How it knows what's happening.** It uses Steam's players list and CS2's own *Game State Integration*, a feature Valve built into CS2 for apps like this. To use it, CS2Clean adds a small config file to CS2's `cfg` folder, and CS2 then sends basic match information (warm-up, live, the map) to the app on your own PC.
- **What leaves your PC.** Lookups of the SteamIDs of the players in your lobby, sent to Leetify, to csst.at for players Leetify doesn't have, and, only if you saved a Steam Web API key, to Steam's Web API to see which of them are friends. Your API keys stay on your PC, encrypted with your system's keychain when one is available. Details: [How it works](docs/HOW-IT-WORKS.md#privacy).

## Installation

Download the latest release from the [GitHub releases page](https://github.com/papelblume/CS2Clean/releases), then follow the steps for your system and the [first run](#first-run) steps below.

### Windows

Run the installer (it installs just for you, needs no administrator rights, and adds Start menu and desktop shortcuts) or the portable `.zip` (`CS2Clean-<version>-portable.zip`).

- **Installed app:** settings are stored in `%APPDATA%\CS2Clean`.
- **Portable `.zip`:** extract it into a folder of its own (Explorer's **Extract All**, or the **Extract to** entry in 7-Zip's menu) and run `CS2Clean.exe` from there. It keeps its settings and downloads in a `data` folder beside `CS2Clean.exe` (the csst.at fallback's Chrome download, about 370 MB, goes there too), so deleting the folder removes the app. It also adds one small file to CS2's `cfg` folder, which is harmless to leave. If you move the folder, switch **Start with Windows** off and on again.

**SmartScreen:** The installer and the portable `CS2Clean.exe` are not yet code-signed. Windows will show "Windows protected your PC" — click **More info**, then **Run anyway**.

### Linux

1. Download the latest AppImage or tar.gz from the releases page
2. **AppImage:** make it executable and run it:
   ```bash
   chmod +x CS2Clean-*.AppImage
   ./CS2Clean-*.AppImage
   ```
3. **tar.gz:** extract and run the binary inside:
   ```bash
   tar -xzf cs2clean-*.tar.gz
   cd cs2clean-*/
   ./cs2clean
   ```

You need native Steam running and signed in, and an X11 session (Wayland is untested). Settings are kept in `~/.config/CS2Clean`.

## First run

The same on Windows and Linux:

1. Start Steam and sign in. CS2Clean reads the players in your match from it.
2. Open CS2Clean. When it starts, it adds a small config file (`gamestate_integration_cs2clean.cfg`) to CS2's `cfg` folder if that file is missing. That is how CS2 tells the app when warm-up starts and the match goes live.
3. Paste your Leetify API key if you have one. It's optional (see [API keys](#api-keys)).
4. If CS2 was already running, restart it once so it picks up the new config file. Run CS2 in **Fullscreen Windowed** mode (Settings > Video > Display Mode); the overlay can't show over plain Fullscreen.
5. Join a match. The overlay appears during warm-up, hides itself when the match goes live, and can be re-opened using hotkeys.

## Keyboard shortcuts

| Key | What it does |
|-----|--------------|
| **Shift+F2** | Show or hide the player list in the game overlay |
| **F7** | Show details of flagged players (press again to hide) |
| **F6** | Show the next player's details (one at a time) |
| **Shift+F6** | Show the previous player's details |

Stepping past either end of the list hides the card. All four keys can be changed under **Settings** in the app.

The desktop window always lists every player in your match with their name, class, reputation score and ranks. In game, **Shift+F2** shows the same list in the overlay.

## How players are rated

**Data.** Player data is retrieved from Leetify's public API. When Leetify has no profile for a player, the app tries csst.at. Players with a private profile are shown from their lifetime stats only, without match history, so their numbers carry less weight. Players with no data on either site can't be shown.

**Stat levels.** Each stat is rated Low, Medium or High. High is roughly the median Pro's level or better (across Tier 1/2/3 Teams, median elo 3670, see [docs/pro-metrics](docs/pro-metrics)); Medium is roughly an average FACEIT Level 7 player's level or better. The cut-offs come from Leetify's Data Library (September 2026 FACEIT averages) and analysis of 623 professional players' Leetify stats.

**Reputation and class.** The reputation score (100 = nothing unusual) and a player's overall class compare their stats with the pros' and with the average player of their rank. They show how unusual the numbers are, not what the player did. Top players, pros and smurfs score high, and careful cheaters can look normal. A ban on record is the only hard evidence.

## API keys

An API key is a code, like a password, that lets an app ask a website for data on your behalf. CS2Clean can use two, both free and both optional. Paste them into the **API Keys** card in the app's window.

### Leetify API key

Lookups work without a key, but Leetify limits how many you can make. A free key makes lookups reliable:

1. Get a free key at [leetify.com/app/developer](https://leetify.com/app/developer)
2. Paste it into the **API Keys** card in the app's window (the app checks it before saving)

### Steam Web API key

Everything works without one. A Steam Web API key adds:

- **Friend badges:** shows which players in your lobby are friends on Steam
- **Find your own friends if using the `status` console command:** matches the names the `status` command prints to every friend of yours, including ones who appear offline (your friends list must be public). See [Finding friends in your match](docs/FINDING-FRIENDS.md#the-status-command-recommended)
- **Custom profile links:** lets *Check a player* use `steamcommunity.com/id/name` links (without a key, the app reads the profile page instead)
- **Names of players you add by hand:** looked up with your key (without one, the app reads the player's public mini-profile page instead)

To set it up:

1. Get a key at [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey). Steam asks for a domain name; `localhost` works. Accounts that are still limited can't register a key.
2. Paste it into the **API Keys** card in the app's window

Treat the key like a password and don't share it. The app stores it encrypted when your system has a keychain. If you believe it has been exposed, revoke it immediately at [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey) and generate a new one if needed.

## Finding friends in your match

Steam's players list leaves out people who are already your friends, so CS2Clean finds them another way. With no setup, friends on your map are guessed and marked "maybe" (Steam updates that information only every 10 minutes). For exact results: add the "-condebug" launch option to CS2 and run `status` in the console during a match. A more advanced option can read Steam's own friends list by launching Steam with debugging enabled.

Setup steps are in [docs/FINDING-FRIENDS.md](docs/FINDING-FRIENDS.md).

## Community servers and offline matches

CS2 only tells Steam who is in a matchmaking match. On a community server or an offline match, CS2Clean can't find the players by itself, and after a short wait the window says **Community server or offline match: roster unavailable**.

You can still check anyone you spot, with or without a match. Paste their **SteamID64**, **SteamID2/3** (like `STEAM_0:1:123…` or `[U:1:…]`) or a **Steam or Leetify profile link** into *Check a player* in the desktop window.

- They show their Steam name, which arrives a moment after you add them (until then, and if Steam can't say, the row reads *Unknown player*).
- They are looked up like any other player. In a match they join the list, on top of the 10 players a lobby has, with overlay cards and the siren. With no match they are listed on their own under *Checked players*.
- You can have up to 5 at a time.
- They go when the match's players do (a new map, CS2 closing) or when you click the trashcan icon next to them.

Custom profile links (`steamcommunity.com/id/name`) work too.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Steam didn't answer" | Make sure Steam is running and you're signed in |
| A friend in your match is missing | The window says what would find them. See [Finding friends in your match](docs/FINDING-FRIENDS.md): run `status` in the console with CS2 launched with `-condebug`, or turn on Steam's debug port |
| Steam's friends list window opens by itself | The app opens it when it needs it (see [Steam's debug port](docs/FINDING-FRIENDS.md#steams-debug-port-advanced)). Untick **Open Steam's friends list for me** in Settings to stop that |
| A friend marked "maybe" isn't in your match | That comes from a Steam profile page that can be 10 minutes old. Use `status` in the console for exact results |
| "Couldn't find CS2's folder" | The app can still read Steam's players list, but it won't know when warm-up starts or the match goes live. CS2Clean finds CS2 through Steam's library list, so any Steam library drive works, but it only looks for Steam in the usual places: the one in the Windows registry, or on Linux a native Steam in `~/.steam/debian-installation` or `~/.local/share/Steam` (Flatpak and Snap Steam aren't supported). |
| Overlay not visible in CS2 | Make sure CS2 is in **Fullscreen Windowed** mode, not plain Fullscreen |
| Leetify rate limits | Add a free Leetify API key (see [API keys](#api-keys)) |
| "Setting up the csst.at fallback: downloading Chrome" | A one-time download (about 370 MB on disk) into the app's data folder, the first time a player isn't on Leetify. Lookups carry on meanwhile and the fallback works from the next one after it. |
| "csst.at fallback unavailable" | The window gives the reason. Nothing else stops working: only players Leetify has no profile for can't be looked up on csst.at. Developers: see [the csst.at fallback](docs/DEVELOPMENT.md#the-csstat-fallback) |
| `chrome-sandbox` error on Linux (common on Ubuntu 24.04 and derivatives) | See [Development](docs/DEVELOPMENT.md#linux-chrome-sandbox-error). For the tar.gz, run the same two commands on the `chrome-sandbox` file in the extracted folder |

## More documentation

- [Finding friends in your match](docs/FINDING-FRIENDS.md) — setup steps for each method
- [How it works](docs/HOW-IT-WORKS.md) — data sources, local connections and privacy details
- [Development](docs/DEVELOPMENT.md) — running from source, debug scripts, tests
- [Design notes](docs/DESIGN.md) — architecture and scoring

## Credits

CS2Clean is a fork of [cheatscanner.eu](https://github.com/EspectroDK/cheatscanner.eu)'s companion app.

Player data is provided by [Leetify](https://leetify.com), and by [csst.at](https://csst.at) for players Leetify has no profile for. CS2Clean does not look at demos and makes no accusations — treat a flag as "worth a closer look", not as proof of cheating.

This project has been developed using AI tools - Claude Opus 5.5, Sonnet 5.5, Qwen3.6-35B, and gpt-oss-20b.

## License

CS2Clean is licensed under the [GNU Affero General Public License v3.0](LICENSE). The public repository is https://github.com/papelblume/cs2clean. If you run a modified version as a website or service, you must offer its users the source of that version.
