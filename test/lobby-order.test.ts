import { describe, expect, it } from "vitest";
import { cycleHints, cycleStep } from "../src/shared/lobby-order";

// A walk over the players in slots 2, 1, 4 (not the order of the slot numbers: it comes from the controller).
const WALK = [2, 1, 4];

describe("cycleStep", () => {
  it("steps along the walk, in its order", () => {
    expect(cycleStep(WALK, 2, 1)).toEqual({ hide: false, slot: 1 });
    expect(cycleStep(WALK, 1, 1)).toEqual({ hide: false, slot: 4 });
    expect(cycleStep(WALK, 4, -1)).toEqual({ hide: false, slot: 1 });
    expect(cycleStep(WALK, 1, -1)).toEqual({ hide: false, slot: 2 });
  });

  it("hides past either end", () => {
    expect(cycleStep(WALK, 4, 1)).toEqual({ hide: true });
    expect(cycleStep(WALK, 2, -1)).toEqual({ hide: true });
  });

  it("starts at the first player (forward) or the last (back) when the cards aren't up, or the shown player isn't on the walk", () => {
    expect(cycleStep(WALK, 1, 1, false)).toEqual({ hide: false, slot: 2 });
    expect(cycleStep(WALK, 1, -1, false)).toEqual({ hide: false, slot: 4 });
    expect(cycleStep(WALK, null, 1)).toEqual({ hide: false, slot: 2 });
    expect(cycleStep(WALK, 3, 1)).toEqual({ hide: false, slot: 2 });
    expect(cycleStep(WALK, 3, -1)).toEqual({ hide: false, slot: 4 });
  });

  it("with nobody to show, brings the cards up once and hides them on the next press", () => {
    expect(cycleStep([], null, 1, false)).toEqual({ hide: false, slot: null });
    expect(cycleStep([], null, -1, false)).toEqual({ hide: false, slot: null });
    expect(cycleStep([], null, 1)).toEqual({ hide: true });
    expect(cycleStep([], null, -1)).toEqual({ hide: true });
  });
});

describe("cycleHints", () => {
  it("counts from 1 along the walk, and says step back and next in the middle of it", () => {
    expect(cycleHints(WALK, 2)).toEqual({ position: 1, total: 3, previous: "hide", next: "next" });
    expect(cycleHints(WALK, 1)).toEqual({ position: 2, total: 3, previous: "back", next: "next" });
    expect(cycleHints(WALK, 4)).toEqual({ position: 3, total: 3, previous: "back", next: "hide" });
  });

  it("says hide both ways for a walk of one player", () => {
    expect(cycleHints([7], 7)).toEqual({ position: 1, total: 1, previous: "hide", next: "hide" });
  });

  it("says where a key jumps when the card shown isn't on the walk (the player left, or has nothing to show)", () => {
    expect(cycleHints(WALK, 3)).toEqual({ position: null, total: 3, previous: "last", next: "first" });
    expect(cycleHints(WALK, null)).toEqual({ position: null, total: 3, previous: "last", next: "first" });
  });

  it("says hide both ways when there is nobody", () => {
    expect(cycleHints([], null)).toEqual({ position: null, total: 0, previous: "hide", next: "hide" });
  });
});
