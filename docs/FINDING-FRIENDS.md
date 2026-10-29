# Finding friends in your match

Back to the [README](../README.md).

Steam's players list (Steam > View > Players) leaves out people who are already your friends, and CS2 gives Steam nothing the app can use to see who is on your server. So CS2Clean finds your friends in other ways. You don't have to set anything up; the options below make the result more exact.

## Which should I use?

| Option | Setup | Result |
|--------|-------|--------|
| **Do nothing** (Steam profile pages) | None | A guess. Friends that have public profiles and are playing the same map as you are added and marked "maybe", but Steam updates that information only about every 10 minutes (on the hour, :10, :20 and so on) |
| **The `status` command** *(recommended)* | One launch option, and a key to press during a match | Exact. Players are matched to your friends by name |
| **Steam's debug port** *(advanced)* | Change how Steam starts | Live/automatic retrieval. Read the security note first |

You can use more than one. A friend found by several methods appears once. The order is Steam's players list, then `status`, then the friends list, then profile pages, and the lobby never grows past the mode's size. While a friend is playing CS2 and the match has an empty slot, the app's window says what would find them.

## The `status` command (recommended)

1. In Steam, open Library > Counter-Strike 2 > Properties > Launch Options and add `-condebug`. CS2 then saves everything its console prints to a file (`game/csgo/console.log`).
2. Turn on the developer console under Settings > Game > Enable Developer Console.
3. Optional, but handy: bind `status` to a key. Open the console and type `bind <key> status`, using a key you don't already use. You only do this once.
4. In a match, press that key (or open the console and type `status`). Run it again if a friend joins later. Friends found stay for the rest of the match.

How it works:

- The app only reads new lines of that file. Nothing is typed into CS2.
- `status` prints names, not Steam IDs, so the app matches the names to your friends.
- It matches against the friends Steam says are playing CS2. If you saved a [Steam Web API key](../README.md#steam-web-api-key) and your friends list is public, it matches against all your friends, including ones who appear offline.
- A name that fits two players, or two friends, is left out. Players the app already has use up their names first, so a stranger and a friend with the same name aren't mixed up.

## Steam's debug port (advanced)

This changes how Steam starts, and it has a security trade-off, so only use it if `status` doesn't suit you.

> **Security note:** The debug port lets any program on this PC control Steam. Turn it off again when you don't need it.

1. Turn the debug port on:
   - **Windows:** right-click your Steam shortcut > Properties, and add `-cef-enable-debugging` at the end of the Target box, after the closing quote (for example `"C:\Program Files (x86)\Steam\steam.exe" -cef-enable-debugging`). This only applies when you start Steam from that shortcut. Creating an empty file named `.cef-enable-remote-debugging` in Steam's folder (`C:\Program Files (x86)\Steam`) does the same.
   - **Linux:** create an empty file named `.cef-enable-remote-debugging` in Steam's folder (`~/.local/share/Steam` or `~/.steam/debian-installation`), or start Steam with `steam -cef-enable-debugging`.
2. Quit Steam fully and start it again.

After that you don't need to do anything. The app uses the debug port (port 8080) to read the Friends List window, in any of Steam's languages. It reads each friend's status line (for example "Competitive - Office [ 5 : 0 ]"), and a friend whose line equals yours is in your match.

The app also opens the Friends List window for you when it is closed:

- once when the app starts, and in a match's warm-up while a friend is in CS2 and a slot is empty
- never during a live round, at most once a minute, and at most three times per match
- untick **Open Steam's friends list for me** in Settings to stop this and open the window yourself (Shift+Tab, or View > Friends)

## Steam profile pages (the automatic fallback)

Nothing to set up. When neither `status` nor the debug port is in use, the app reads the public profile popup of friends who are playing CS2. It shows a line like "Premier - Inferno [ 0 : 2 ]".

- Friends on your map, in a mode that can be yours, are added and marked "maybe".
- Steam only refreshes that page about every 10 minutes, so the score is ignored.
- When more friends fit than there are empty slots, none are added.

## Checking what the app can see (advanced)

If friends are missing and you want to know why, developers can run `npm run friends-ui` (what the app can use to find friends, the friends list status lines, and who would be added) and `npm run console-status` (what it reads from `console.log` and who matched). See [Debug scripts](DEVELOPMENT.md#debug-scripts).
