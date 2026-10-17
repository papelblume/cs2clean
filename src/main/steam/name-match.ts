// Turns the names in a `status` player list (console-log.ts) into Steam IDs, by matching them to friends.
//
// `status` prints names only. Friends come as name + Steam ID pairs: from the Steam client (the friends playing CS2
// right now, steam/coplay.ts) and, when there is a Steam Web API key, from the Steam Web API (friend-names.ts), which
// also knows friends who appear offline. A name is only trusted when it points to exactly one friend and exactly one
// place in the lobby: two players called "Bob" never get a friend's ID.
//
// Players the app already knows (the players list, and ourselves) use up lobby entries first. Without that, a
// stranger called "Bob" in the match and a friend "Bob" playing somewhere else would look like one friend in the match.

import type { LobbyPlayer } from "./console-log";

export interface NameCandidate {
  steamId: string;
  /** The friend's current persona name; null when unknown. */
  name: string | null;
}

export interface NameMatch {
  steamId: string;
  /** The name as the lobby shows it. */
  name: string;
  slot: number;
}

export interface MatchOptions {
  /** Steam IDs never matched: players already in the list, and ourselves. */
  exclude?: ReadonlySet<string>;
  /** Names of the players already known (from the players list): each accounts for one lobby entry. */
  knownNames?: readonly (string | null)[];
  /** Our own name: it is in the lobby too. */
  localName?: string | null;
}

export interface MatchResult {
  matches: NameMatch[];
  /** Names (as the lobby shows them) that fit more than one friend or more than one lobby entry, so were left out. */
  ambiguous: string[];
}

/** The form names are compared in: Unicode-normalized, trimmed, and without case. */
export function normalizeName(s: string): string {
  return s.normalize("NFC").trim().toLowerCase();
}

export function matchLobbyNames(lobby: readonly LobbyPlayer[], candidates: readonly NameCandidate[], o: MatchOptions = {}): MatchResult {
  // The lobby by name, minus the entries that belong to players we already know.
  const byName = new Map<string, LobbyPlayer[]>();
  for (const p of lobby) {
    const k = normalizeName(p.name);
    if (k) byName.set(k, [...(byName.get(k) ?? []), p]);
  }
  for (const name of [...(o.knownNames ?? []), o.localName]) {
    if (!name) continue;
    byName.get(normalizeName(name))?.shift();
  }

  // The friends by name, each friend once (the first source to name them wins), without the excluded.
  const exclude = o.exclude ?? new Set<string>();
  const seen = new Set<string>();
  const friendsByName = new Map<string, NameCandidate[]>();
  for (const c of candidates) {
    if (!c.name || exclude.has(c.steamId) || seen.has(c.steamId)) continue;
    seen.add(c.steamId);
    const k = normalizeName(c.name);
    if (k) friendsByName.set(k, [...(friendsByName.get(k) ?? []), c]);
  }

  const matches: NameMatch[] = [];
  const ambiguous: string[] = [];
  for (const [k, friends] of friendsByName) {
    const here = byName.get(k) ?? [];
    if (here.length === 0) continue; // not in the lobby (or the entry belongs to someone we know)
    if (here.length === 1 && friends.length === 1) matches.push({ steamId: friends[0].steamId, name: here[0].name, slot: here[0].slot });
    else ambiguous.push(here[0].name);
  }
  return { matches: matches.sort((a, b) => a.slot - b.slot), ambiguous };
}
