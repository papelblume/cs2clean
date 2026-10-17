// Whether the CS2 process is up. Only a process list is read: nothing opens, reads or changes CS2 itself.
// Used while CS2's game-state feed hasn't said anything yet, so that a closed game doesn't show its last match.

import { execFile } from "node:child_process";

type Run = (cmd: string, args: string[], opts: { timeout: number; windowsHide: boolean }, cb: (err: (Error & { code?: number | string }) | null, stdout: string) => void) => unknown;

/** True when a cs2 process is running, false when none is; rejects when the list couldn't be read (then nobody knows). */
export function isCs2Running(run: Run = execFile as unknown as Run, platform: string = process.platform): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const win = platform === "win32";
    // Windows: tasklist prints a CSV row per match ("cs2.exe","1234",...). Linux: pgrep exits 0 on a match, 1 on none
    // (cs2, or cs2.exe under Proton).
    const [cmd, args] = win ? ["tasklist", ["/FI", "IMAGENAME eq cs2.exe", "/FO", "CSV", "/NH"]] : ["pgrep", ["-x", "cs2(\\.exe)?"]];
    run(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (win) return err ? reject(err) : resolve(/^"cs2\.exe"/im.test(String(stdout)));
      if (!err) return resolve(true);
      return err.code === 1 ? resolve(false) : reject(err);
    });
  });
}
