import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noteUpdateCheck, readLastUpdateCheck, settingsFileStore, type KeyCrypto } from "../src/main/settings-file";

/** A keychain that "encrypts" by wrapping the text, so a test can tell encrypted from plain. */
function keychain(available = true): KeyCrypto {
  return {
    isAvailable: () => available,
    encrypt: (plain) => Buffer.from(`enc:${plain}`).toString("base64"),
    decrypt: (base64) => Buffer.from(base64, "base64").toString().replace(/^enc:/, ""),
  };
}

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cs2clean-settings-"));
  file = join(dir, "settings.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const onDisk = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

describe("settings file: save and load", () => {
  it("loads nothing when there is no file yet", () => {
    expect(settingsFileStore(file, keychain()).load()).toEqual({});
  });

  it("round-trips the keys, siren, friends-list setting and hotkeys", () => {
    const store = settingsFileStore(file, keychain());
    store.save({ leetifyKey: "L-key", steamApiKey: "S-key", siren: false, autoOpenFriendsList: false, hotkeys: { cycle: "F8" } });
    expect(store.load()).toEqual({ leetifyKey: "L-key", steamApiKey: "S-key", siren: false, autoOpenFriendsList: false, hotkeys: { cycle: "F8" } });
  });

  it("keeps the keys encrypted on disk when the keychain is available", () => {
    settingsFileStore(file, keychain()).save({ leetifyKey: "L-key", steamApiKey: "S-key" });
    const raw = onDisk();
    expect(raw.leetifyKeyEnc).toBeTypeOf("string");
    expect(raw.steamApiKeyEnc).toBeTypeOf("string");
    expect(raw).not.toHaveProperty("leetifyKey");
    expect(raw).not.toHaveProperty("steamApiKey");
    expect(readFileSync(file, "utf8")).not.toContain("L-key");
  });

  it("stores the keys as plain text when there is no keychain, and reads them back", () => {
    const store = settingsFileStore(file, keychain(false));
    store.save({ leetifyKey: "L-key", steamApiKey: "S-key" });
    expect(onDisk()).toMatchObject({ leetifyKey: "L-key", steamApiKey: "S-key" });
    expect(store.load()).toMatchObject({ leetifyKey: "L-key", steamApiKey: "S-key" });
  });

  it("replaces a plain-text key with an encrypted one once a keychain is there", () => {
    writeFileSync(file, JSON.stringify({ leetifyKey: "old-plain" }));
    settingsFileStore(file, keychain()).save({ leetifyKey: "old-plain" });
    expect(onDisk()).not.toHaveProperty("leetifyKey");
    expect(onDisk()).toHaveProperty("leetifyKeyEnc");
  });

  it("removes a key from the file when it is cleared", () => {
    const store = settingsFileStore(file, keychain());
    store.save({ leetifyKey: "L-key", steamApiKey: "S-key" });
    store.save({ leetifyKey: null, steamApiKey: null });
    const raw = onDisk();
    for (const k of ["leetifyKey", "leetifyKeyEnc", "steamApiKey", "steamApiKeyEnc"]) expect(raw).not.toHaveProperty(k);
    expect(store.load()).toMatchObject({ leetifyKey: null, steamApiKey: null });
  });

  it("starts over when the file is not valid JSON", () => {
    writeFileSync(file, "{ not json");
    const store = settingsFileStore(file, keychain());
    expect(store.load()).toEqual({});
    store.save({ siren: true });
    expect(store.load()).toMatchObject({ siren: true });
  });
});

describe("settings file: what a save leaves alone", () => {
  it("keeps the time of the last update check (the once-a-day limit must survive a settings save)", () => {
    noteUpdateCheck(file, 1_700_000_000_000);
    settingsFileStore(file, keychain()).save({ siren: false, leetifyKey: "L-key" });
    expect(readLastUpdateCheck(file)).toBe(1_700_000_000_000);
  });

  it("keeps entries it doesn't know, such as ones a newer version wrote", () => {
    writeFileSync(file, JSON.stringify({ siren: true, somethingNew: { a: 1 } }));
    settingsFileStore(file, keychain()).save({ siren: false });
    expect(onDisk()).toMatchObject({ siren: false, somethingNew: { a: 1 } });
  });

  it("changes its own entries even when the file has older values for them", () => {
    writeFileSync(file, JSON.stringify({ siren: true, hotkeys: { cycle: "F9" }, lastUpdateCheck: 5 }));
    settingsFileStore(file, keychain()).save({ siren: false, hotkeys: { cycle: "F8" } });
    expect(onDisk()).toMatchObject({ siren: false, hotkeys: { cycle: "F8" }, lastUpdateCheck: 5 });
  });
});

describe("settings file: the update check time", () => {
  it("is unknown before any check, and for a file that is missing, broken or holds something else", () => {
    expect(readLastUpdateCheck(file)).toBeNull();
    writeFileSync(file, "{ not json");
    expect(readLastUpdateCheck(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ lastUpdateCheck: "yesterday" }));
    expect(readLastUpdateCheck(file)).toBeNull();
    writeFileSync(file, "null");
    expect(readLastUpdateCheck(file)).toBeNull();
  });

  it("is noted in a new file, and read back", () => {
    noteUpdateCheck(file, 123);
    expect(readLastUpdateCheck(file)).toBe(123);
  });

  it("is noted without touching the keys and settings already saved", () => {
    const store = settingsFileStore(file, keychain());
    store.save({ leetifyKey: "L-key", siren: false, hotkeys: { lobby: "F3" } });
    noteUpdateCheck(file, 456);
    expect(store.load()).toMatchObject({ leetifyKey: "L-key", siren: false, hotkeys: { lobby: "F3" } });
    expect(readLastUpdateCheck(file)).toBe(456);
  });

  it("is replaced by a later check", () => {
    noteUpdateCheck(file, 1);
    noteUpdateCheck(file, 2);
    expect(readLastUpdateCheck(file)).toBe(2);
  });
});
