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
npm run hero:install
npm start
```

`npm run hero:install` sets up the csst.at fallback (see below). Skip it and the app still works; the window then says "csst.at fallback unavailable" and why.

## The csst.at fallback

The fallback uses a helper (the Hero sidecar, explained in [DESIGN.md](DESIGN.md)). `npm run hero:install` needs Node 22 itself: the Node that runs it if that is 22, otherwise the newest nvm `v22.x`, or the one `CS2CLEAN_NODE22` points at. It installs Hero with that Node and copies the Node next to it.

If the window says "csst.at fallback unavailable":

- The full error is in `hero.log` in the app's data folder (`%APPDATA%\CS2Clean` on Windows, `~/.config/CS2Clean` on Linux).
- From a source checkout the usual fix is `npm run hero:install`.

## Linux: chrome-sandbox error

If Electron refuses to start with a `chrome-sandbox` error (common on Ubuntu 24.04 and derivatives), grant the sandbox the permissions it needs:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

## Environment variables

| Variable | What it does |
|----------|--------------|
| `LEETIFY_API_KEY` | Your Leetify API key. A key saved in the app takes priority |
| `STEAM_API_KEY` | Your Steam Web API key. A key saved in the app takes priority |
| `CS2CLEAN_NODE22` | Points `npm run hero:install` at a Node 22 |

## UI development

Preview UI states in a browser without running the full app:

```bash
npm run dev:ui
```

Then open `http://localhost:5173` with query params:
- `?screen=lobby|detail|player|nokey|waiting|problem|hint` — which screen to show (default: lobby)
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
npm run hero:check                                   # the sidecar's selftest, from a source checkout
npm run hero:check -- release/linux-unpacked/resources/hero   # ...or on a packaged build
npm run check:package                                # verify a packaged app's asar contains expected files
```
