// The portable build: a zip that is extracted into a folder of its own. It has a `portable.txt` next to CS2Clean.exe
// (tools/portable/portable.txt, added by `npm run dist:zip` and not to the installer). While that file is there the
// app keeps everything it writes in a `data` folder beside the exe instead of %APPDATA%\CS2Clean, so deleting the
// folder removes the app.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const PORTABLE_MARKER = "portable.txt";
export const PORTABLE_DATA_DIR = "data";

/** Where a portable app keeps its data: `data` beside the exe when the marker is there, otherwise null. */
export function portableDataDir(exeDir: string): string | null {
  return existsSync(join(exeDir, PORTABLE_MARKER)) ? join(exeDir, PORTABLE_DATA_DIR) : null;
}

/** Makes the folder (Electron wants it to exist). False when it can't be made, a read-only place say, so the app can
 *  fall back to the usual data folder instead of failing to start. */
export function ensurePortableDataDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
