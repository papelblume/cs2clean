// Checks for a newer release version against GitHub.
//
// Parses tags like "cs2clean-v1.2.3" into [1, 2, 3] and compares numerically.
// Returns null on any error (network, rate limit, API change) — the caller never sees a failure.

export const OWNER = "papelblume";
export const REPO = "cs2clean";
const API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

/** Parse "cs2clean-v1.2.3" or "1.2.3" into [1, 2, 3]. Returns null on bad input. */
export function parseVersion(tag: string): [number, number, number] | null {
  const m = tag.match(/^(?:cs2clean-v)?(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/** Compare two parsed versions: returns true if remote > local. */
function isNewer(remote: [number, number, number], local: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (remote[i] > local[i]) return true;
    if (remote[i] < local[i]) return false;
  }
  return false;
}

export interface UpdateResult {
  available: boolean;
  remoteVersion: string;
}

/**
 * Check GitHub for a newer release.
 * Returns the result if a newer version is found, null on any error.
 */
export async function checkForUpdate(currentVersion: string, fetchImpl: typeof fetch = fetch): Promise<UpdateResult | null> {
  try {
    const res = await fetchImpl(API, { headers: { Accept: "application/vnd.github.v3+json" } });
    if (!res.ok) return null;
    const data = await res.json() as { tag_name: string };
    const parsed = parseVersion(data.tag_name);
    if (!parsed) return null;
    const local = parseVersion(currentVersion);
    if (!local) return null;
    if (!isNewer(parsed, local)) return null;
    return { available: true, remoteVersion: data.tag_name.replace(/^cs2clean-v/, "") };
  } catch {
    return null;
  }
}
