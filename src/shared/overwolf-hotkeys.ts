// The overlay hotkeys as Overwolf's overlay registers them. Overwolf keeps the default hotkeys (they can't be changed in
// Settings there), and each one is worked out from DEFAULT_HOTKEYS, so the key that is registered is always the key the
// window shows. (Shift+F6 used to be registered as F5, by a hand-written copy of the key.)

import { DEFAULT_HOTKEYS, type HotkeyName } from "./hotkeys";

export interface OverwolfHotkey {
  /** The key as the window shows it. */
  label: string;
  /**
   * Overwolf's keyCode: a KeyboardEvent.code. For the F-keys the defaults use, that is the accelerator's key itself
   * ("F6"); a letter or digit would need its own mapping ("KeyK", "Digit5").
   */
  code: string;
  /** The same key as an Electron accelerator. Overwolf is told to hold Shift when it starts with "Shift+". */
  accelerator: string;
}

function overwolfHotkey(accelerator: string): OverwolfHotkey {
  return { label: accelerator, code: accelerator.split("+").pop() ?? accelerator, accelerator };
}

export const OVERWOLF_HOTKEYS: Record<HotkeyName, OverwolfHotkey> = {
  lobby: overwolfHotkey(DEFAULT_HOTKEYS.lobby),
  detail: overwolfHotkey(DEFAULT_HOTKEYS.detail),
  cycle: overwolfHotkey(DEFAULT_HOTKEYS.cycle),
  previous: overwolfHotkey(DEFAULT_HOTKEYS.previous),
};
