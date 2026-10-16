// Turns a custom Steam profile name (steamcommunity.com/id/<name>) into a SteamID64. With a Steam Web API key this
// is the official call; without one, the profile's public XML page names the same ID.

const ID64 = /^7656\d{13}$/;

export type VanityResult = { ok: true; steamId: string } | { ok: false; reason: "not-found" | "unreachable" | "bad-key" };

export async function resolveVanity(name: string, key: string | null, fetchImpl: typeof fetch = fetch): Promise<VanityResult> {
  try {
    if (key) {
      const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?key=${encodeURIComponent(key)}&vanityurl=${encodeURIComponent(name)}`;
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
      if (res.status === 403) return { ok: false, reason: "bad-key" };
      if (!res.ok) return { ok: false, reason: "unreachable" };
      const body = (await res.json()) as { response?: { success?: number; steamid?: string } };
      const id = body.response?.steamid;
      return body.response?.success === 1 && id && ID64.test(id) ? { ok: true, steamId: id } : { ok: false, reason: "not-found" };
    }
    const res = await fetchImpl(`https://steamcommunity.com/id/${encodeURIComponent(name)}/?xml=1`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, reason: "unreachable" };
    const id = /<steamID64>(\d{17})<\/steamID64>/.exec(await res.text())?.[1];
    return id && ID64.test(id) ? { ok: true, steamId: id } : { ok: false, reason: "not-found" };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
