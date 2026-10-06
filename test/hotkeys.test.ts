import { describe, expect, it } from "vitest";
import { cleanHotkeys, duplicateHotkey, hotkeyFromEvent, hotkeyProblem } from "../src/shared/hotkeys";

const ev = (code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ code, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

const defaults = { lobby: "Shift+F2", detail: "F7", cycle: "F6" };

describe("hotkeys", () => {
  it("turns key presses into accelerators", () => {
    expect(hotkeyFromEvent(ev("F7"))).toBe("F7");
    expect(hotkeyFromEvent(ev("F2", { shiftKey: true }))).toBe("Shift+F2");
    expect(hotkeyFromEvent(ev("KeyK", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+K");
    expect(hotkeyFromEvent(ev("Numpad5", { altKey: true }))).toBe("Alt+num5");
    expect(hotkeyFromEvent(ev("ShiftLeft", { shiftKey: true }))).toBeNull();
    expect(hotkeyFromEvent(ev("Space"))).toBeNull();
  });

  it("only accepts keys that don't get in the way of typing", () => {
    for (const ok of ["F7", "Shift+F2", "Insert", "Ctrl+K", "Alt+5", "Ctrl+Shift+PageUp"]) expect(hotkeyProblem(ok)).toBeNull();
    for (const bad of ["K", "Shift+K", "5", "Win+F7", "Ctrl+Ctrl+F7", "Space", ""]) expect(hotkeyProblem(bad)).not.toBeNull();
  });

  it("cleans stored hotkeys", () => {
    expect(cleanHotkeys(undefined)).toEqual(defaults);
    expect(cleanHotkeys({ lobby: "F8", detail: "K" })).toEqual({ ...defaults, lobby: "F8" });
    expect(cleanHotkeys({ lobby: "F7" })).toEqual(defaults);
    expect(cleanHotkeys({ lobby: "F7", detail: "F7" })).toEqual(defaults);
  });

  it("knows the cycle hotkey, and settings saved before it existed keep working", () => {
    expect(cleanHotkeys({ lobby: "F8", detail: "F9" })).toEqual({ lobby: "F8", detail: "F9", cycle: "F6" }); // old file: no cycle
    expect(cleanHotkeys({ lobby: "F8", detail: "F9", cycle: "Ctrl+Alt+K" }).cycle).toBe("Ctrl+Alt+K");
    expect(cleanHotkeys({ lobby: "F8", detail: "F9", cycle: "F8" }).cycle).toBe("F6");   // taken by another hotkey
    expect(cleanHotkeys({ lobby: "F6" })).toEqual(defaults);                              // default cycle would clash: all defaults
  });

  it("finds a key used twice", () => {
    expect(duplicateHotkey({ lobby: "F1", detail: "F2", cycle: "F3" })).toBeNull();
    expect(duplicateHotkey({ lobby: "F1", detail: "F2", cycle: "F1" })).toBe("F1");
    expect(duplicateHotkey({ lobby: "F1", detail: "F2", cycle: "F2" })).toBe("F2");
  });
});
