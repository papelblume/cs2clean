# Development

Back to the [README](../README.md). For the architecture and the scoring internals, see [DESIGN.md](DESIGN.md).

## Requirements

**Node 22.12 or newer.**

## Running from source

These steps were written for Linux. They should largely apply for Windows as well:

```bash
git clone https://github.com/papelblume/CS2Clean.git
cd CS2Clean
npm ci
npm start
```

## Run modes

`npm start` builds and runs the app against the real game (Steam's players list and CS2's game-state feed). The other modes are for development without CS2 or Steam data:

```bash
npm run start:replay                       # plays fixtures/premier-mirage.jsonl instead of a live match
npm start -- --replay=path/to/file.jsonl   # plays a recording of your own
npm run start:overwolf                     # Overwolf's CS2 events and overlay (needs Overwolf's approval for the app)
npm run start:overwolf -- --record         # ...and saves what Overwolf reports to recordings/ in the app's data folder
```

## The csst.at fallback

The fallback needs nothing beyond `npm ci`: it sends its requests from inside the app with wreq-js, an HTTP client whose TLS and HTTP/2 handshake is Chrome's (explained in [DESIGN.md](DESIGN.md)). There is no browser, no download and no helper process.

If the window says "csst.at fallback unavailable":

- The full error is in `csst.log` in the app's data folder (`%APPDATA%\CS2Clean` on Windows, `data` beside `CS2Clean.exe` in the portable zip, `~/.config/CS2Clean` on Linux).
- "couldn't be reached" or "timed out" is csst.at or your connection; the lobby asks again after a minute.
- "asked for a browser check", "rate-limiting" or "refused" means csst.at turned the request away; it clears up by itself, and the lobby asks again after a minute.
- "network library (wreq-js) couldn't be loaded" is a problem with this install: from a source checkout run `npm ci` again (wreq-js's native library is a separate per-platform package).

## Linux: chrome-sandbox error

If Electron refuses to start with a `chrome-sandbox` error (common on Ubuntu 24.04 and derivatives), grant the sandbox the permissions it needs:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

From the Linux tar.gz release, the file sits in the extracted folder instead:

```bash
sudo chown root:root cs2clean-*/chrome-sandbox
sudo chmod 4755 cs2clean-*/chrome-sandbox
```

## Environment variables

| Variable | What it does |
|----------|--------------|
| `LEETIFY_API_KEY` | Your Leetify API key. A key saved in the app takes priority |
| `STEAM_API_KEY` | Your Steam Web API key. A key saved in the app takes priority |
| `CS2CLEAN_DATA_DIR` | Where `csst.log` goes when the app doesn't say (the app itself always uses its data folder) |
| `CS2CLEAN_CSST_ORIGIN` | The address csst.at is read from (default `https://csst.at`), for testing |

## UI development

Preview UI states in a browser without running the full app:

```bash
npm run dev:ui
```

Then open `http://localhost:5173` with query params:
- `?screen=lobby|detail|player|nokey|waiting|community|problem|hint` — which screen to show (default: lobby)
- `?fallback=off` — preview the window with the csst.at fallback unavailable

## Debug scripts

```bash
npm run leetify:probe    # test the Leetify API client directly
npm run coplay           # run the Steam coplay reader standalone
npm run friends-ui       # show what the app can use to find friends (debug port, console.log, profile fallback), the friends list status lines and who would be added
npm run console-status   # watch CS2's console.log (-condebug): run `status` in CS2 to see which lobby names are your friends (STEAM_API_KEY adds all your friends' names)
```

## Checks

```bash
npm test
npm run build
npm run check:package                                # verify a packaged app's asar contains expected files
npm run check:wreq -- release/linux-unpacked/resources   # wreq-js loads and makes a request inside the packaged app
```
