import { describe, expect, it } from "vitest";
import { DEFAULT_HOTKEYS, HOTKEY_NAMES, keyFromCode } from "../src/shared/hotkeys";
import { OVERWOLF_HOTKEYS } from "../src/shared/overwolf-hotkeys";

// main.ts registers each of these with Overwolf as { keyCode: code, modifiers: { shift: accelerator starts with "Shift+" } }.
const shift = (h: { accelerator: string }) => h.accelerator.startsWith("Shift+");

describe("the hotkeys Overwolf registers", () => {
  it("are the ones the window shows", () => {
    for (const name of HOTKEY_NAMES) {
      expect(OVERWOLF_HOTKEYS[name].label, name).toBe(DEFAULT_HOTKEYS[name]);
      expect(OVERWOLF_HOTKEYS[name].accelerator, name).toBe(DEFAULT_HOTKEYS[name]);
    }
  });

  it("register Shift+F6 for the previous player, not F5", () => {
    expect(OVERWOLF_HOTKEYS.previous).toEqual({ label: "Shift+F6", code: "F6", accelerator: "Shift+F6" });
    expect(shift(OVERWOLF_HOTKEYS.previous)).toBe(true);
    expect(shift(OVERWOLF_HOTKEYS.cycle)).toBe(false); // the next player stays on plain F6
  });

  it("press the key that is shown, as a KeyboardEvent.code Overwolf understands", () => {
    for (const name of HOTKEY_NAMES) {
      const shownKey = DEFAULT_HOTKEYS[name].split("+").pop();
      expect(keyFromCode(OVERWOLF_HOTKEYS[name].code), name).toBe(shownKey);
    }
  });

  it("are four different key presses", () => {
    const presses = HOTKEY_NAMES.map((n) => `${shift(OVERWOLF_HOTKEYS[n]) ? "Shift+" : ""}${OVERWOLF_HOTKEYS[n].code}`);
    expect(new Set(presses).size).toBe(HOTKEY_NAMES.length);
  });
});
