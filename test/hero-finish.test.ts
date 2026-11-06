import { describe, expect, it } from "vitest";
import { createFinisher } from "../src/main/hero-finish";

/** A stdout that holds on to its write callbacks until the test flushes them, and the exit codes asked for. */
function rig() {
  const lines: string[] = [];
  const flushes: (() => void)[] = [];
  const exits: number[] = [];
  const dropped: [unknown, number][] = [];
  const finish = createFinisher(
    (line, done) => { lines.push(line); flushes.push(done); },
    (code) => { exits.push(code); },
    (result, code) => { dropped.push([result, code]); },
  );
  return { finish, lines, flushes, exits, dropped };
}

describe("the sidecar's single result line", () => {
  it("writes the result as one JSON line, and exits with its code once the line is flushed", () => {
    const t = rig();
    t.finish({ type: "scrape", data: { "1": null } }, 0);
    expect(t.lines).toEqual(['{"type":"scrape","data":{"1":null}}\n']);
    expect(t.exits).toEqual([]);            // not before it is out
    t.flushes[0]();
    expect(t.exits).toEqual([0]);
  });

  it("writes nothing for a result that comes after the first, even while the first is still being flushed", () => {
    const t = rig();
    t.finish({ type: "scrape", data: {} }, 0);
    t.finish({ error: "late unhandled rejection" }, 1); // Hero Core shutting down, before the first line is out
    expect(t.lines).toEqual(['{"type":"scrape","data":{}}\n']);
    t.flushes[0]();
    t.finish({ error: "and another, after the flush" }, 1);
    expect(t.lines).toHaveLength(1);
    expect(t.exits).toEqual([0]);            // the first result's code, once
    expect(t.dropped).toEqual([[{ error: "late unhandled rejection" }, 1], [{ error: "and another, after the flush" }, 1]]);
  });

  it("lets an error be the one result when it comes first", () => {
    const t = rig();
    t.finish({ error: "Hero won't start", stage: "hero" }, 1);
    t.finish({ type: "scrape", data: {} }, 0);
    expect(t.lines).toEqual(['{"error":"Hero won\'t start","stage":"hero"}\n']);
    t.flushes[0]();
    expect(t.exits).toEqual([1]);
  });
});
