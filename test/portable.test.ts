import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePortableDataDir, PORTABLE_MARKER, portableDataDir } from "../src/main/portable";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cs2clean-portable-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("portable data folder", () => {
  it("is the data folder beside the exe when portable.txt is there", () => {
    writeFileSync(join(dir, PORTABLE_MARKER), "marker");
    expect(portableDataDir(dir)).toBe(join(dir, "data"));
  });

  it("is none without the marker (the installed app and a source checkout)", () => {
    expect(portableDataDir(dir)).toBeNull();
    writeFileSync(join(dir, "data"), "not the marker");
    expect(portableDataDir(dir)).toBeNull();
  });

  it("is none when the exe's folder doesn't exist", () => {
    expect(portableDataDir(join(dir, "missing"))).toBeNull();
  });

  it("makes the data folder, and is fine when it is already there", () => {
    const data = join(dir, "data");
    expect(ensurePortableDataDir(data)).toBe(true);
    expect(statSync(data).isDirectory()).toBe(true);
    expect(ensurePortableDataDir(data)).toBe(true);
  });

  it("makes missing parents too", () => {
    expect(ensurePortableDataDir(join(dir, "a", "b", "data"))).toBe(true);
  });

  it("says so when the folder can't be made, so the app can use the usual one", () => {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "a file where a folder would have to go");
    expect(ensurePortableDataDir(join(blocker, "data"))).toBe(false);
  });
});
