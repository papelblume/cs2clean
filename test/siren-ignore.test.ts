import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSirenIgnore, SIREN_IGNORE_TEMPLATE, SirenIgnoreList } from "../src/main/siren-ignore";

const A = "76561198000000001"; // account 39734273
const B = "76561198000000002";

describe("reading a siren ignore list", () => {
  it("takes one SteamID64 per line", () => {
    const { ids, problems } = parseSirenIgnore(`${A}\n${B}\n`);
    expect([...ids]).toEqual([A, B]);
    expect(problems).toEqual([]);
  });

  it("takes the other ways of writing a SteamID and links to a profile", () => {
    const { ids, problems } = parseSirenIgnore(
      [`STEAM_0:1:19867136`, `[U:1:39734273]`, `https://steamcommunity.com/profiles/${B}`, `https://leetify.com/app/profile/76561198000000003`].join("\n"),
    );
    expect([...ids]).toEqual([A, B, "76561198000000003"]);
    expect(problems).toEqual([]);
  });

  it("ignores blank lines, comment lines and a comment after an ID, so a player can be labelled", () => {
    const { ids, problems } = parseSirenIgnore(`# who\n\n   \n${A}   # my friend\n  ${B}\t#another\n# ${"76561198000000003"}\n`);
    expect([...ids]).toEqual([A, B]);
    expect(problems).toEqual([]);
  });

  it("copes with Windows line endings, a byte order mark and an ID listed twice", () => {
    const { ids, problems } = parseSirenIgnore(`\uFEFF${A}\r\n${B}\r\n${A}\r\n`);
    expect([...ids]).toEqual([A, B]);
    expect(problems).toEqual([]);
  });

  it("says which lines it couldn't use, and keeps the others", () => {
    const { ids, problems } = parseSirenIgnore(`${A}\nmy friend bob\nhttps://steamcommunity.com/id/some_name\n${B}#stuck-on\n${"76561198000000003"}`);
    expect([...ids]).toEqual([A, "76561198000000003"]);
    expect(problems.map((p) => [p.line, p.text])).toEqual([
      [2, "my friend bob"],
      [3, "https://steamcommunity.com/id/some_name"],
      [4, `${B}#stuck-on`],
    ]);
    expect(problems.find((p) => p.line === 3)!.why).toMatch(/custom profile link/);
    expect(problems.find((p) => p.line === 2)!.why).toMatch(/not a SteamID/);
  });

  it("is an empty list for the file a new install gets: its example is a comment", () => {
    const { ids, problems } = parseSirenIgnore(SIREN_IGNORE_TEMPLATE);
    expect(ids.size).toBe(0);
    expect(problems).toEqual([]);
  });
});

describe("the siren ignore list file", () => {
  let dir: string;
  let file: string;
  const warnings: string[] = [];
  const list = () => new SirenIgnoreList(file, (m) => warnings.push(m));
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs2clean-siren-"));
    file = join(dir, "siren-ignore.txt");
    warnings.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is made with an explanation when there is none, and left alone when there is one", () => {
    list().ensureFile();
    expect(readFileSync(file, "utf8")).toBe(SIREN_IGNORE_TEMPLATE);
    writeFileSync(file, `${A}\n`);
    list().ensureFile();
    expect(readFileSync(file, "utf8")).toBe(`${A}\n`);
  });

  it("makes no fuss when it can't be made", () => {
    expect(() => new SirenIgnoreList(join(dir, "no", "such", "folder", "siren-ignore.txt"), () => {}).ensureFile()).not.toThrow();
  });

  it("is empty with no file and for a new one", () => {
    expect(list().ids().size).toBe(0);
    const l = list();
    l.ensureFile();
    expect(l.ids().size).toBe(0);
  });

  it("lists the players in the file", () => {
    writeFileSync(file, `${A}\n${B}\n`);
    expect([...list().ids()]).toEqual([A, B]);
  });

  it("picks up an edit without a restart, and the player taken out is back in the siren", () => {
    const l = list();
    writeFileSync(file, `${A}\n`);
    expect([...l.ids()]).toEqual([A]);
    writeFileSync(file, `${A}\n${B}\n`);
    expect([...l.ids()]).toEqual([A, B]);
    writeFileSync(file, `${B}\n`);
    expect([...l.ids()]).toEqual([B]);
  });

  it("picks up an edit that leaves the size the same", () => {
    const l = list();
    writeFileSync(file, `${A}\n`);
    expect([...l.ids()]).toEqual([A]);
    writeFileSync(file, `${B}\n`);
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    expect([...l.ids()]).toEqual([B]);
  });

  it("reads the file only when it has changed", () => {
    writeFileSync(file, `junk\n${A}\n`);
    const l = list();
    l.ids();
    l.ids();
    l.ids();
    expect(warnings).toHaveLength(1); // the junk line, said once, not at every look
  });

  it("says about a line it can't use, with its number", () => {
    writeFileSync(file, `${A}\nnot a steam id\n`);
    list().ids();
    expect(warnings).toEqual([expect.stringContaining('[siren-ignore] line 2: not a SteamID or a profile link: "not a steam id"')]);
  });

  it("is empty again when the file is deleted, and reads it when it comes back", () => {
    const l = list();
    writeFileSync(file, `${A}\n`);
    expect([...l.ids()]).toEqual([A]);
    unlinkSync(file);
    expect(l.ids().size).toBe(0);
    writeFileSync(file, `${B}\n`);
    expect([...l.ids()]).toEqual([B]);
  });

  it("keeps the last list when the file can't be read just now", () => {
    const l = list();
    writeFileSync(file, `${A}\n`);
    expect([...l.ids()]).toEqual([A]);
    unlinkSync(file);
    mkdirSync(file); // a folder where the file was: it exists, but reading it fails
    expect([...l.ids()]).toEqual([A]);
  });
});
