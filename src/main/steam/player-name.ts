// The name of a player added by hand (Controller.addPlayer), so their row doesn't stay "Unknown player".
//
// With a Steam Web API key it is the official call, GetPlayerSummaries. Without a key, or when Steam's API can't be
// reached or turns the key down, it is the persona name on Steam's public mini-profile page
// (https://steamcommunity.com/miniprofile/<account id>, see miniprofile.ts), which any tool can read without logging in.
// An API that answers "no such player" is not asked again at the mini-profile. Never throws: no name is null.

import { accountId, parseMiniprofileName } from "./miniprofile";

const SUMMARIES = "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/";

/** Steam's limit for a name is 32 characters, so a longer text is something else (a page that changed). */
const MAX_NAME = 64;

function clean(v: unknown): string | null {
  const name = typeof v === "string" ? v.trim() : "";
  return name && name.length <= MAX_NAME ? name : null;
}

/** The name per the Steam Web API; null when Steam has no such player; undefined when the call didn't work out. */
async function fromApi(steamId: string, key: string, fetchImpl: typeof fetch): Promise<string | null | undefined> {
  try {
    const res = await fetchImpl(`${SUMMARIES}?${new URLSearchParams({ key, steamids: steamId })}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return undefined; // 403: the key; anything else: Steam is having trouble
    const body = (await res.json()) as { response?: { players?: { steamid?: unknown; personaname?: unknown }[] } };
    return clean(body.response?.players?.find((p) => p.steamid === steamId)?.personaname);
  } catch {
    return undefined;
  }
}

async function fromMiniprofile(steamId: string, fetchImpl: typeof fetch): Promise<string | null> {
  const acc = accountId(steamId);
  if (!acc) return null;
  try {
    const res = await fetchImpl(`https://steamcommunity.com/miniprofile/${acc}`, {
      headers: { "User-Agent": "CS2Clean", "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(8_000),
    });
    return res.ok ? clean(parseMiniprofileName(await res.text())) : null;
  } catch {
    return null;
  }
}

export async function lookupPlayerName(steamId: string, key: string | null, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (key) {
    const viaApi = await fromApi(steamId, key, fetchImpl);
    if (viaApi !== undefined) return viaApi;
  }
  return fromMiniprofile(steamId, fetchImpl);
}
