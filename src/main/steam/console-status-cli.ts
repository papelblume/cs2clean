// `npm run console-status`: watches CS2's console.log (CS2 launched with -condebug) and, each time you run `status` in
// the CS2 console, prints the players it lists and which of your Steam friends they are (matched by name).
// Arguments, in any order: your SteamID64 (to leave yourself out and enable the Web API list) and a path to console.log
// (otherwise CS2's folder is found through Steam). STEAM_API_KEY in the environment adds the Steam Web API's friends
// list as a second source of names; it also knows friends who appear offline, and needs a public friends list.

import { findCs2ConsoleLog, systemConsoleLog } from "./capabilities";
import { watchStatusBlocks, type StatusBlock } from "./console-log";
import { readCoplay, type CoplayResult } from "./coplay";
import { FriendNameDirectory } from "./friend-names";
import { matchLobbyNames, type NameCandidate } from "./name-match";
import { othersToFind, pickMatchPlayers } from "./pick";

const local = process.argv.slice(2).find((a) => /^\d{17}$/.test(a)) ?? null;
const path = process.argv.slice(2).find((a) => !/^\d{17}$/.test(a)) ?? findCs2ConsoleLog();
const apiKey = process.env.STEAM_API_KEY?.trim() || null;
const directory = new FriendNameDirectory(() => apiKey, () => local);

async function report(block: StatusBlock): Promise<void> {
  console.log(`\n[${block.loggedAt ?? new Date().toLocaleTimeString()}] status: ${block.players.length} players listed`);

  // What the app would know at this point: Steam's players list, and the friends in CS2 with their names.
  let res: CoplayResult | null = null;
  try {
    res = readCoplay(local);
  } catch (e) {
    console.error(`  Couldn't read Steam's players list and friends in CS2: ${e instanceof Error ? e.message : e}`);
  }
  const known = res ? pickMatchPlayers(res.entries, { now: Math.floor(Date.now() / 1000), localSteamId: local, matchStart: null, expectedOthers: othersToFind(null) }).players : [];
  const candidates: NameCandidate[] = (res?.friends ?? []).map((f) => ({ steamId: f.steamId, name: f.name }));
  const fromClient = candidates.length;
  const web = await directory.get();
  candidates.push(...web.friends);

  console.log(`  Friends' names: ${fromClient} playing CS2 (Steam client)${apiKey ? `, ${web.friends.length} from the Steam Web API${web.error ? ` (${web.error})` : ""}` : "; set STEAM_API_KEY to add the Web API's list"}`);
  console.log(`  Players Steam's list already has: ${known.length}`);

  const { matches, ambiguous } = matchLobbyNames(block.players, candidates, {
    exclude: new Set([...known.map((p) => p.steamId), ...(local ? [local] : [])]),
    knownNames: known.map((p) => p.name),
    localName: res?.localName ?? null,
  });
  console.log(matches.length ? `  Friends in this lobby: ${matches.length}` : "  Friends in this lobby: none");
  for (const m of matches) console.log(`    [${String(m.slot).padStart(2)}] ${m.name.padEnd(28)} ${m.steamId}`);
  if (ambiguous.length) console.log(`  Left out, the name fits more than one: ${ambiguous.join(", ")}`);
}

function main(): void {
  if (!path) {
    console.error("Couldn't find CS2's folder. Pass the path to game/csgo/console.log as an argument.");
    process.exitCode = 1;
    return;
  }
  const log = systemConsoleLog(Date.now() - 10 * 60_000, path); // CS2's session start isn't known here: written in the last 10 minutes counts
  console.log(`Watching ${path} (${log.state})`);
  if (log.state === "missing") console.log("The file doesn't exist yet: launch CS2 with -condebug, then run `status` in its console.");
  else console.log("Run `status` in the CS2 console while you are in a match. Ctrl+C to quit.");

  let busy: Promise<void> = Promise.resolve();
  watchStatusBlocks(path, (b) => { busy = busy.then(() => report(b)).catch((e) => console.error(e instanceof Error ? e.message : e)); });
}

main();
