// Checks for a newer release version against GitHub.
//
// Parses tags like "cs2clean-v1.2.3" into [1, 2, 3] and compares numerically.
// Says which of three things happened: a newer release exists, this is the newest, or the check couldn't tell
// (network, rate limit, an answer it can't read). The last one is not "up to date": it must not tell anybody they
// are on the latest version, or use up the once-a-day automatic check.

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

export type UpdateResult =
  /** A newer release is out. */
  | { status: "available"; remoteVersion: string }
  /** GitHub answered, and nothing newer than this version is out. */
  | { status: "current" }
  /** The check couldn't tell; `reason` is a fragment for "Couldn't check for updates: …". */
  | { status: "failed"; reason: string };

const failed = (reason: string): UpdateResult => ({ status: "failed", reason });

/** Check GitHub for a newer release. Never throws. */
export async function checkForUpdate(currentVersion: string, fetchImpl: typeof fetch = fetch): Promise<UpdateResult> {
  const local = parseVersion(currentVersion);
  if (!local) return failed(`this app's version "${currentVersion}" isn't one it can compare`);
  let res: Response;
  try {
    res = await fetchImpl(API, { headers: { Accept: "application/vnd.github.v3+json" } });
  } catch (e) {
    return failed(`can't reach GitHub (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!res.ok) return failed(`GitHub answered HTTP ${res.status}`);
  let tag: unknown;
  try {
    tag = ((await res.json()) as { tag_name?: unknown } | null)?.tag_name;
  } catch {
    return failed("GitHub's answer couldn't be read");
  }
  if (typeof tag !== "string") return failed("GitHub's answer has no release tag");
  const remote = parseVersion(tag);
  if (!remote) return failed(`the latest release's tag "${tag}" isn't a version`);
  if (!isNewer(remote, local)) return { status: "current" };
  return { status: "available", remoteVersion: tag.replace(/^cs2clean-v/, "") };
}
