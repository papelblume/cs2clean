// The siren ignore list: a text file of SteamIDs, one per line, in the app's data folder. A player on it never sets the
// siren off (they are still listed and rated as usual). Kept free of Electron so the tests can run it.
//
// Each line is a SteamID64, a SteamID2 (STEAM_0:1:123), a SteamID3 ([U:1:123]) or a link to a Steam or Leetify profile;
// what parseSteamInput reads. A custom Steam link (steamcommunity.com/id/name) has to be looked up at Steam, which a file
// read can't do, so it isn't accepted. Blank lines, lines starting with # and anything after a # that follows an ID
// (a label: `76561198000000001  # my friend`) are ignored.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { parseSteamInput } from "../shared/steam-id";

export const SIREN_IGNORE_FILE = "siren-ignore.txt";

/** What a new file says, so a person who opens it knows what to put in it. */
export const SIREN_IGNORE_TEMPLATE = `# CS2Clean siren ignore list
#
# A player listed here never sets the siren off. They still show up in the lobby with their usual rating.
#
# One player per line: their SteamID64 (7656119...), SteamID2 (STEAM_0:1:123) or SteamID3 ([U:1:123]),
# or a link to their Steam profile (steamcommunity.com/profiles/7656119...) or their Leetify profile.
# Blank lines and lines starting with # are ignored, and so is anything after a # that follows an ID,
# so you can say who it is:
#
# 76561198000000001   # my friend with the strong aim
#
# A change takes effect the next time the siren would go off; CS2Clean doesn't need a restart.
# A player the siren already went off for in this match stays announced.
`;

export interface SirenIgnoreProblem {
  line: number;
  text: string;
  why: string;
}

/** The SteamID64s a file lists, and the lines that were neither blank, a comment nor a player. */
export function parseSirenIgnore(text: string): { ids: Set<string>; problems: SirenIgnoreProblem[] } {
  const ids = new Set<string>();
  const problems: SirenIgnoreProblem[] = [];
  text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.replace(/(^|\s)#.*$/, "").trim();
      if (!line) return;
      const parsed = parseSteamInput(line);
      if (parsed?.kind === "id") ids.add(parsed.steamId);
      else if (parsed?.kind === "vanity") problems.push({ line: i + 1, text: line, why: "a custom profile link can't be read here, use the SteamID64 or a steamcommunity.com/profiles/ link" });
      else problems.push({ line: i + 1, text: line, why: "not a SteamID or a profile link" });
    });
  return { ids, problems };
}

export class SirenIgnoreList {
  private current: ReadonlySet<string> = new Set();
  /** Which version of the file `current` was read from (its size and time), so it is read again only when it changes. */
  private stamp = "";

  constructor(
    readonly file: string,
    private readonly warn: (message: string) => void = (m) => console.warn(m),
  ) {}

  /** Writes the explanation when there is no file yet, and never touches one that is there. */
  ensureFile(): void {
    if (existsSync(this.file)) return;
    try {
      writeFileSync(this.file, SIREN_IGNORE_TEMPLATE, { flag: "wx" });
    } catch {
      /* nowhere to write it: the list stays empty */
    }
  }

  /**
   * The players to leave out of the siren. The file is read again when it has changed since the last look, so an edit
   * counts without a restart. No file is an empty list; a file that can't be read just now (a save in progress, say)
   * leaves the last list in place.
   */
  ids(): ReadonlySet<string> {
    try {
      const st = statSync(this.file);
      const stamp = `${st.mtimeMs}:${st.size}`;
      if (stamp === this.stamp) return this.current;
      const { ids, problems } = parseSirenIgnore(readFileSync(this.file, "utf8"));
      this.current = ids;
      this.stamp = stamp;
      for (const p of problems) this.warn(`[siren-ignore] line ${p.line}: ${p.why}: "${p.text}"`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.current = new Set();
        this.stamp = "";
      }
    }
    return this.current;
  }
}
