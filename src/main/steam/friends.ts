// Groups lobby players by Steam friendship using the Steam Web API.
//
// For each player in the lobby, fetches their friends list and builds an undirected
// friendship graph restricted to lobby members. Connected components become groups.
//
// Privacy: a 401 means the player's list is private. The edge may still be found if
// the other player's list is public. When both are private, no edge is detected.

import { setTimeout as sleep } from "node:timers/promises";

const BASE = "https://api.steampowered.com";
const ENDPOINT = "/ISteamUser/GetFriendList/v0001/";
const DELAY_MS = 200;

/** Steam ID with a private friends list, used to validate the API key without exposing data. */
const KEY_TEST_ID = "76561197960287930";

export interface FriendsResult {
  /** Each connected component of friends within the lobby. Largest first, solos last. */
  groups: string[][];
  /** Players whose friends list was private (401). */
  private: string[];
  /** Players that had transient errors (rate limit, network, timeout). */
  errors: string[];
}

type FetchResult = { kind: "ok"; friends: Set<string> } | { kind: "private" } | { kind: "error" };

/** Fetch one player's friends list. Distinguishes private profiles from transient errors. */
async function fetchFriends(steamId: string, key: string): Promise<FetchResult> {
  const url = `${BASE}${ENDPOINT}?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamId)}&relationship=friend`;
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.status === 401) return { kind: "private" };
      if (res.status === 403) {
        const body = await res.text().catch(() => "");
        throw new Error(`Steam API key invalid or missing: ${body.slice(0, 200)}`);
      }
      if (res.status === 429 || res.status >= 500) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) return { kind: "error" };
      const data = await res.json() as { friendslist?: { friends?: { steamid: string }[] } };
      const friends = data.friendslist?.friends ?? [];
      return { kind: "ok", friends: new Set(friends.map((f) => f.steamid)) };
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      // Network error (DNS, connection refused)
      if (attempt < maxRetries - 1) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      return { kind: "error" };
    }
  }
  return { kind: "error" };
}

/** Union-Find data structure for connected components. */
class UnionFind {
  private parent: Map<string, string> = new Map();
  private rank: Map<string, number> = new Map();

  constructor(items: Iterable<string>) {
    for (const item of items) {
      this.parent.set(item, item);
      this.rank.set(item, 0);
    }
  }

  find(x: string): string {
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    while (this.parent.get(x) !== root) {
      const parent = this.parent.get(x)!;
      this.parent.set(x, root);
      x = parent;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    if (this.rank.get(ra)! < this.rank.get(rb)!) {
      this.parent.set(ra, rb);
    } else if (this.rank.get(ra)! > this.rank.get(rb)!) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, this.rank.get(ra)! + 1);
    }
  }

  /** Return all members grouped by root, largest groups first. */
  groups(): string[][] {
    const buckets = new Map<string, string[]>();
    for (const item of this.parent.keys()) {
      (buckets.get(this.find(item)) ?? (buckets.set(this.find(item), []), buckets.get(this.find(item))!)).push(item);
    }
    return [...buckets.values()].sort((a, b) => b.length - a.length);
  }
}

/** Group lobby players by Steam friendship. */
export async function groupPlayers(lobbyIds: string[], apiKey: string): Promise<FriendsResult> {
  const lobbySet = new Set(lobbyIds);
  const deduped = [...new Set(lobbyIds)];
  const uf = new UnionFind(deduped);
  const private_: string[] = [];
  const errors: string[] = [];

  for (const id of deduped) {
    const result = await fetchFriends(id, apiKey);
    await sleep(DELAY_MS);
    if (result.kind === "private") {
      private_.push(id);
      continue;
    }
    if (result.kind === "error") {
      errors.push(id);
      continue;
    }
    for (const fid of result.friends) {
      if (lobbySet.has(fid)) {
        uf.union(id, fid);
      }
    }
  }

  return { groups: uf.groups(), private: private_, errors };
}

/** Check whether a Steam Web API key is valid by fetching one private profile. Returns false on 403 or non-JSON. */
export async function validateSteamKey(key: string): Promise<boolean> {
  const url = `${BASE}${ENDPOINT}?key=${encodeURIComponent(key)}&steamid=${KEY_TEST_ID}&relationship=friend`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const text = await res.text().catch(() => "");
  return text.startsWith("{") && text.endsWith("}");
}
