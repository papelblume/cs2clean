import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assessProfile } from "../src/main/assess";
import { parseCsstAtHtml } from "../src/main/csst-parse";
import type { LeetifyProfile } from "../src/main/leetify";
import type { PlayerDetail } from "../src/shared/types";
import { matchesFact } from "../src/renderer/parts";
import { AVERAGE } from "./profiles";

const PAGE = readFileSync(join(__dirname, "..", "fixtures", "csst-leetify-extra.html"), "utf8");
const csst = (): LeetifyProfile => parseCsstAtHtml(PAGE, "76561198000000001")!;
const detailOf = (p: LeetifyProfile): PlayerDetail => assessProfile(p).detail!;

describe("the matches row of a card", () => {
  it("is the matches and the win rate for a player from csst.at", () => {
    const d = detailOf(csst());
    expect(d.source).toBe("csst.at");
    expect(matchesFact(d)).toEqual({ label: "Matches/Win rate", value: "30 / 43%" });
  });

  it("is the Leetify matches for a player from the API, with no win rate in it", () => {
    const d = detailOf({ ...AVERAGE(), total_matches: 420, winrate: 0.55 });
    expect(d.source).toBe("leetify");
    expect(matchesFact(d)).toEqual({ label: "Leetify matches", value: "420" });
  });

  it("shows a dash for what csst.at didn't give", () => {
    expect(matchesFact(detailOf({ ...csst(), winrate: null })).value).toBe("30 / –");
    expect(matchesFact(detailOf({ ...csst(), total_matches: null })).value).toBe("– / 43%");
  });

  it("rounds the win rate to a whole percent", () => {
    expect(matchesFact(detailOf({ ...csst(), winrate: 0.299 })).value).toBe("30 / 30%");
    expect(matchesFact(detailOf({ ...csst(), winrate: 0.505 })).value).toBe("30 / 51%");
  });
});
