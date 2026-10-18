import { describe, expect, it } from "vitest";
import { cspLevel, hsAccuracyLevel, spottedAccuracyLevel, sprayAccuracyLevel, ttdLevel } from "../src/renderer/parts";

// The card's Low / Medium / High: High from the median pro, Medium from the average FACEIT Level 7 player (Leetify's
// Performance Metric Tool, September 2026: 562.8 ms, 9.41 degrees, 18.9%, 36.8%, 35.1%), rounded.
describe("card tiers", () => {
  const cases: [string, (v: number | null | undefined) => string, number, number][] = [
    // [name, tier function, last value that is High, last value that is Medium]
    ["time to damage", ttdLevel, 470, 565],
    ["crosshair placement", cspLevel, 8.8, 9.4],
    ["headshot accuracy", hsAccuracyLevel, 23, 19],
    ["spray accuracy", sprayAccuracyLevel, 43, 37],
    ["spotted accuracy", spottedAccuracyLevel, 40, 35],
  ];

  for (const [name, level, high, medium] of cases) {
    it(`${name}: High at ${high}, Medium at ${medium}, Low beyond`, () => {
      // Lower is better for time to damage and crosshair placement, higher for the accuracies.
      const better = (v: number, by: number) => (level === ttdLevel || level === cspLevel ? v - by : v + by);
      expect(level(high)).toBe("HIGH");
      expect(level(better(high, 0.01))).toBe("HIGH");
      expect(level(better(high, -0.01))).toBe("MEDIUM");
      expect(level(medium)).toBe("MEDIUM");
      expect(level(better(medium, -0.01))).toBe("LOW");
    });

    it(`${name}: no value, no tier`, () => {
      expect(level(null)).toBe("");
      expect(level(undefined)).toBe("");
    });
  }
});
