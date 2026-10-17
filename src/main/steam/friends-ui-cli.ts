// `npm run friends-ui`: prints what Steam's friends list window shows (read over the debug port) and which friends
// the app would add to your match because their status line equals yours. Use it in a match's warm-up or live, with
// Steam started with -cef-enable-debugging. Optional: your SteamID64 as an argument, to leave yourself out.
// Port: the one in Steam's command line (Linux), else CS2CLEAN_DEBUG_PORT, else 8080. It also says what the app can
// use to find friends (the debug port, CS2's console.log) and why not.

import { cefHint, describeCapabilities, detectCef, profileFallbackWanted, systemConsoleLog, systemCefIo } from "./capabilities";
import { readCoplay, type FriendInGame } from "./coplay";
import { matchFriends, readFriendUi, rowName } from "./steam-ui";

async function main(): Promise<void> {
  const cef = await detectCef(systemCefIo());
  const port = cef.port;
  // CS2's session start isn't known here: a console.log written in the last 10 minutes counts as active.
  const log = systemConsoleLog(Date.now() - 10 * 60_000);
  for (const line of describeCapabilities(cef, log, true)) console.log(line);
  console.log(`Steam profile fallback (friends on your map, up to 10 minutes old): ${profileFallbackWanted({ cef, log, nowMs: Date.now() }) ? "used, since neither the debug port nor console.log is in use" : "not needed"}`);
  console.log();
  const local = process.argv.slice(2).find((a) => /^\d{17}$/.test(a)) ?? null;

  const ui = await readFriendUi(port);
  if (!ui.ok) {
    const why = {
      unreachable: cefHint(cef, true) ?? `Nothing answers on 127.0.0.1:${port}. Quit Steam fully, then start it with -cef-enable-debugging.`,
      "no-friends-window": "The debug port works, but Steam has no \"Friends List\" window open. Open the friends list (Shift+Tab or View > Friends).",
      error: "The debug port answered, but reading the friends list failed.",
    }[ui.reason];
    console.error(`${why}${ui.detail ? ` (${ui.detail})` : ""}`);
    process.exitCode = 1;
    return;
  }

  const { own, rows } = ui.snapshot;
  console.log(`Your match status: ${own ?? "(none: not in a match, or Steam shows no score)"}`);
  const inMatch = rows.filter((r) => /\[\s*\d+\s*:\s*\d+\s*\]/.test(r.status));
  console.log(`\nFriends showing a match status: ${inMatch.length}`);
  for (const r of inMatch) console.log(`  ${rowName(r).padEnd(28)} ${r.status}`);

  let native: FriendInGame[] = [];
  try {
    native = readCoplay(local).friends ?? [];
  } catch (e) {
    console.error(`\nCouldn't read Steam's friends in CS2: ${e instanceof Error ? e.message : e}`);
  }
  console.log(`\nFriends the Steam client says are playing CS2: ${native.length}`);
  const matches = matchFriends(native, ui.snapshot, { exclude: new Set(local ? [local] : []) });
  const matched = new Set(matches.map((m) => m.steamId));
  for (const f of native) {
    const row = rows.find((r) => rowName(r) === (f.name ?? "").normalize("NFC").trim());
    const verdict = matched.has(f.steamId) ? "SAME MATCH AS YOU" : row ? "different status" : "no row with this name";
    console.log(`  ${f.steamId}  ${(f.name ?? "?").padEnd(28)} ${(row?.status ?? "-").padEnd(34)} ${verdict}`);
  }
  console.log(`\nFriends the app would add to your match: ${matches.map((m) => m.name ?? m.steamId).join(", ") || "none"}`);
}

void main();
