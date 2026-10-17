import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LogTailer, StatusParser, parseStatusLine, watchStatusBlocks, type StatusBlock } from "../src/main/steam/console-log";

// A real `status` printed to console.log (names replaced), prefix and all.
const SAMPLE = readFileSync(join(__dirname, "..", "fixtures", "console-status.log"), "utf8").split("\n").filter(Boolean);
const P = "10/16 08:08:47 [Client] ";

function parse(lines: string[]): StatusBlock[] {
  const p = new StatusParser();
  return lines.map((l) => p.feed(l)).filter((b): b is StatusBlock => b !== null);
}

describe("a player line of `status`", () => {
  it("reads the slot and the name", () => {
    expect(parseStatusLine("   0    42:54   13    0     active 786432 'Player01'")).toEqual({ slot: 0, name: "Player01" });
    expect(parseStatusLine("   2    32:00   23    0     active 1000000 'Player03'")).toEqual({ slot: 2, name: "Player03" });
    expect(parseStatusLine("  26    00:06   31    0     active 786432 'Player15'")).toEqual({ slot: 26, name: "Player15" });
  });

  it("keeps whatever is between the first and the last quote", () => {
    expect(parseStatusLine("  3    1:02:03   9    0     active 786432 'Bob's  \"pal\" é 好'")).toEqual({ slot: 3, name: "Bob's  \"pal\" é 好" });
  });

  it("skips bots, slots still connecting, and every other kind of line", () => {
    expect(parseStatusLine("  24      BOT    0    0     active      0 'DemoRecorder'")).toBeNull();
    expect(parseStatusLine("65535 [NoChan]    0    0 challenging      0 ''")).toBeNull();
    expect(parseStatusLine("  id     time ping loss      state   rate name")).toBeNull();
    expect(parseStatusLine("Official Valve Server")).toBeNull();
    expect(parseStatusLine("")).toBeNull();
  });
});

describe("the status block", () => {
  it("is read out of a real log: 15 players, no bots, no empty slots", () => {
    const blocks = parse(SAMPLE);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].loggedAt).toBe("10/16 08:08:47");
    expect(blocks[0].players.map((p) => p.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 25, 26]);
    expect(blocks[0].players.map((p) => p.name)).toEqual(Array.from({ length: 15 }, (_, i) => `Player${String(i + 1).padStart(2, "0")}`));
  });

  it("only ends at #end", () => {
    const p = new StatusParser();
    for (const l of SAMPLE.slice(0, -1)) expect(p.feed(l)).toBeNull();
    expect(p.feed(SAMPLE.at(-1)!)?.players).toHaveLength(15);
  });

  it("works without the timestamp and tag in front of each line", () => {
    const bare = SAMPLE.map((l) => l.slice(P.length));
    expect(parse(bare)).toEqual([{ players: parse(SAMPLE)[0].players, loggedAt: null }]);
  });

  it("reads several blocks, ignores what is between them, and starts over at a new header", () => {
    const second = [`${P}---------players--------`, `${P}   0    01:00   10    0     active 786432 'Solo'`, `${P}#end`];
    const unfinished = [`${P}---------players--------`, `${P}   1    01:00   10    0     active 786432 'Lost'`];
    const blocks = parse([`${P}something else`, ...SAMPLE, `${P}chatter`, ...unfinished, ...second]);
    expect(blocks.map((b) => b.players.map((p) => p.name))).toEqual([parse(SAMPLE)[0].players.map((p) => p.name), ["Solo"]]);
  });

  it("gives up on a block that never ends", () => {
    const p = new StatusParser();
    p.feed(`${P}---------players--------`);
    for (let i = 0; i < 500; i++) p.feed(`${P}   1    01:00   10    0     active 786432 'N${i}'`);
    expect(p.feed(`${P}#end`)).toBeNull();
  });
});

describe("following the file", () => {
  let dir: string, path: string, lines: string[], tailer: LogTailer;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs2clean-tail-"));
    path = join(dir, "console.log");
    lines = [];
    tailer = new LogTailer(path, (l) => lines.push(l));
  });
  afterEach(() => { tailer.stop(); rmSync(dir, { recursive: true, force: true }); });

  it("ignores what is already in the file and delivers what is appended", async () => {
    writeFileSync(path, "old 1\nold 2\n");
    await tailer.poll();
    expect(lines).toEqual([]);
    appendFileSync(path, "new 1\nnew 2\n");
    await tailer.poll();
    expect(lines).toEqual(["new 1", "new 2"]);
    await tailer.poll();
    expect(lines).toEqual(["new 1", "new 2"]);                     // nothing twice
  });

  it("holds a half-written line until its newline arrives, and drops the CR of CRLF", async () => {
    writeFileSync(path, "");
    await tailer.poll();
    appendFileSync(path, "first\r\nsecond ha");
    await tailer.poll();
    expect(lines).toEqual(["first"]);
    appendFileSync(path, "lf\n");
    await tailer.poll();
    expect(lines).toEqual(["first", "second half"]);
  });

  it("puts a character back together when its bytes arrive in two reads", async () => {
    writeFileSync(path, "");
    await tailer.poll();
    const bytes = Buffer.from("名前é\n");
    appendFileSync(path, bytes.subarray(0, 4));                      // ends in the middle of a character
    await tailer.poll();
    appendFileSync(path, bytes.subarray(4));
    await tailer.poll();
    expect(lines).toEqual(["名前é"]);
  });

  it("starts again at the beginning of a file that was truncated or replaced", async () => {
    writeFileSync(path, "a long line that is going away\n");
    await tailer.poll();
    writeFileSync(path, "x\n");                                      // CS2 restarted and cleared it
    await tailer.poll();
    expect(lines).toEqual(["x"]);
    renameSync(path, join(dir, "old.log"));
    writeFileSync(path, "from the new file\n");                      // a different file under the same name
    await tailer.poll();
    expect(lines).toEqual(["x", "from the new file"]);
  });

  it("reads a file that doesn't exist yet from its first line, once it appears", async () => {
    await tailer.poll();
    writeFileSync(path, "hello\n");
    await tailer.poll();
    expect(lines).toEqual(["hello"]);
    unlinkSync(path);
    await tailer.poll();                                              // gone: nothing to read, and no crash
    writeFileSync(path, "again\n");
    await tailer.poll();
    expect(lines).toEqual(["hello", "again"]);
  });

  it("reads a large backlog over several rounds", async () => {
    const small = new LogTailer(path, (l) => lines.push(l), { maxReadBytes: 16 });
    writeFileSync(path, "");
    await small.poll();
    appendFileSync(path, Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join(""));
    await small.poll();
    expect(lines).toHaveLength(20);
    expect(lines[19]).toBe("line 19");
  });

  it("stops when told to", async () => {
    const t = new LogTailer(path, (l) => lines.push(l), { pollMs: 10 });
    writeFileSync(path, "");
    t.start();
    await new Promise((r) => setTimeout(r, 40));
    t.stop();
    appendFileSync(path, "late\n");
    await new Promise((r) => setTimeout(r, 60));
    expect(lines).toEqual([]);
  });
});

describe("watching a console.log for status blocks", () => {
  it("hands over a block when `status` is run, and none before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs2clean-watch-"));
    try {
      const path = join(dir, "console.log");
      writeFileSync(path, "10/16 07:00:00 [Client] ---------players--------\n10/16 07:00:00 [Client] #end\n"); // an old status: ignored
      const got: (StatusBlock & { at: number })[] = [];
      const w = watchStatusBlocks(path, (b) => got.push(b), { pollMs: 1_000_000, now: () => 42 });
      await w.poll();
      appendFileSync(path, SAMPLE.join("\n") + "\n");
      await w.poll();
      w.stop();
      expect(got).toHaveLength(1);
      expect(got[0].at).toBe(42);
      expect(got[0].players).toHaveLength(15);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
