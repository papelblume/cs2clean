import { describe, expect, it } from "vitest";
import { clutchDisplay } from "../src/renderer/parts";

describe("the clutch row of a card", () => {
  it("is the rating times 100, with a plus for a positive one", () => {
    expect(clutchDisplay(0.1)).toBe("+10.0");
    expect(clutchDisplay(0.0562)).toBe("+5.6");
  });

  it("carries a single minus for a negative rating, not '+-'", () => {
    expect(clutchDisplay(-0.032)).toBe("-3.2");
    expect(clutchDisplay(-0.2)).toBe("-20.0");
  });

  it("shows zero, and what rounds to it, as +0.0 (never -0.0)", () => {
    expect(clutchDisplay(0)).toBe("+0.0");
    expect(clutchDisplay(-0)).toBe("+0.0");
    expect(clutchDisplay(-0.0004)).toBe("+0.0");
    expect(clutchDisplay(0.0004)).toBe("+0.0");
  });

  it("shows a dash when the API sent none", () => {
    expect(clutchDisplay(null)).toBe("–");
    expect(clutchDisplay(undefined)).toBe("–");
  });
});
