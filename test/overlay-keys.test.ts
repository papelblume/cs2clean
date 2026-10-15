import { describe, expect, it } from "vitest";
import { pressViewKey } from "../src/shared/overlay-keys";
import type { AppState } from "../src/shared/types";

type Overlay = AppState["overlay"];
const overlay = (visible: boolean, view: Overlay["view"]): Overlay =>
  ({ hotkey: "Shift+F2", detailHotkey: "F7", cycleHotkey: "F6", previousHotkey: "Shift+F6", mode: "window", visible, view, focusSlot: 3, siren: true });
/** What a person sees after a press: the view, or "hidden". */
const after = (o: Overlay, key: "lobby" | "detail") => {
  const next = pressViewKey(o, key);
  return next.visible ? next.view : "hidden";
};

describe("pressViewKey", () => {
  it("Shift+F2 opens the list when nothing is open, and hides it when the list is showing", () => {
    expect(after(overlay(false, "lobby"), "lobby")).toBe("lobby");
    expect(after(overlay(true, "lobby"), "lobby")).toBe("hidden");
  });

  it("Shift+F2 opens the list over an open F6 or F7 card instead of closing the overlay", () => {
    expect(after(overlay(true, "player"), "lobby")).toBe("lobby");
    expect(after(overlay(true, "detail"), "lobby")).toBe("lobby");
  });

  it("F7 opens its cards when nothing is open, and hides them when they are showing", () => {
    expect(after(overlay(false, "lobby"), "detail")).toBe("detail");
    expect(after(overlay(true, "detail"), "detail")).toBe("hidden");
  });

  it("F7 opens its cards over the list and over an F6 card", () => {
    expect(after(overlay(true, "lobby"), "detail")).toBe("detail");
    expect(after(overlay(true, "player"), "detail")).toBe("detail");
  });

  it("a view left in a hidden overlay doesn't count as showing", () => {
    expect(after(overlay(false, "detail"), "detail")).toBe("detail");
  });

  it("leaves everything else alone, the card the F6 walk is on included", () => {
    expect(pressViewKey(overlay(true, "player"), "lobby")).toEqual({ ...overlay(true, "player"), view: "lobby" });
  });
});
