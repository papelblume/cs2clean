// Reads what a person pastes to name a player: a SteamID64, a SteamID2 (STEAM_0:1:123), a SteamID3 ([U:1:123]), or a
// link to a Steam or Leetify profile. Pure, so the controller and its tests share one rule.

const BASE = 76561197960265728n; // SteamID64 of account number 0 (individual, public universe)

export type SteamInput =
  | { kind: "id"; steamId: string }
  /** A custom profile URL (steamcommunity.com/id/<name>): the name has to be looked up at Steam. */
  | { kind: "vanity"; name: string };

const ID64 = /^7656\d{13}$/;

/** What `text` names, or null when it names no player. */
export function parseSteamInput(text: string): SteamInput | null {
  const t = text.trim().replace(/^<|>$/g, "");
  if (!t) return null;
  if (ID64.test(t)) return { kind: "id", steamId: t };

  // STEAM_X:Y:Z (what `status` and many server tools print)
  const id2 = /^STEAM_[0-5]:([01]):(\d{1,10})$/i.exec(t);
  if (id2) return accountId(BigInt(id2[2]) * 2n + BigInt(id2[1]));

  // [U:1:N]
  const id3 = /^\[?U:1:(\d{1,10})\]?$/i.exec(t);
  if (id3) return accountId(BigInt(id3[1]));

  // Links: only the host and the first path segments matter.
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const [a, b, c] = url.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  if (host === "steamcommunity.com") {
    if (a === "profiles" && b && ID64.test(b)) return { kind: "id", steamId: b };
    if (a === "id" && b && /^[A-Za-z0-9_-]{2,64}$/.test(b)) return { kind: "vanity", name: b };
  }
  if (host === "leetify.com" && a === "app" && b === "profile" && c && ID64.test(c)) return { kind: "id", steamId: c };
  return null;
}

function accountId(n: bigint): SteamInput | null {
  return n > 0n ? { kind: "id", steamId: String(BASE + n) } : null;
}
