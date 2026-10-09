// Overlay hotkeys, written as Electron accelerators ("Shift+F2", "Ctrl+Alt+K"). Used by the Settings page
// (to turn a key press into a hotkey) and by the main process (to check one before registering it).

/**
 * lobby: the player list; detail: the cards of flagged players; cycle: the next player's card, one at a time for
 * every player; previous: the previous player's card.
 */
export const DEFAULT_HOTKEYS = { lobby: "Shift+F2", detail: "F7", cycle: "F6", previous: "Shift+F6" } as const;

export type HotkeyName = keyof typeof DEFAULT_HOTKEYS;
export type Hotkeys = Record<HotkeyName, string>;
export const HOTKEY_NAMES = Object.keys(DEFAULT_HOTKEYS) as HotkeyName[];

const MODIFIERS = ["Ctrl", "Alt", "Shift"] as const;
/** Keys that don't type anything, so they may be used alone or with Shift. */
const QUIET_KEYS = new Set(["Insert", "Delete", "Home", "End", "PageUp", "PageDown"]);
const isFKey = (k: string) => /^F([1-9]|1\d|2[0-4])$/.test(k);
const isTypingKey = (k: string) => /^[A-Z0-9]$/.test(k) || /^num[0-9]$/.test(k);

/** The key part of a KeyboardEvent.code, as an accelerator key name; null for keys we don't offer. */
export function keyFromCode(code: string): string | null {
  if (isFKey(code)) return code;
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (m) return code.startsWith("Numpad") ? `num${m[1]}` : m[1];
  return QUIET_KEYS.has(code) ? code : null;
}

/** A key press as an accelerator, or null while only modifiers are held or the key isn't offered. */
export function hotkeyFromEvent(e: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): string | null {
  const key = keyFromCode(e.code);
  if (!key) return null;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
  return [...mods, key].join("+");
}

/** Why a hotkey can't be used, in plain words; null when it's fine. */
export function hotkeyProblem(hotkey: string): string | null {
  const parts = hotkey.split("+");
  const key = parts.pop() ?? "";
  if (parts.some((p) => !(MODIFIERS as readonly string[]).includes(p)) || new Set(parts).size !== parts.length)
    return `${hotkey} isn't a key combination the app can use.`;
  if (!isFKey(key) && !QUIET_KEYS.has(key) && !isTypingKey(key)) return `${hotkey} isn't a key the app can use.`;
  // A hotkey is taken from every program while the app runs, so a typing key needs Ctrl or Alt.
  if (isTypingKey(key) && !parts.includes("Ctrl") && !parts.includes("Alt"))
    return "Letters and digits need Ctrl or Alt, or you couldn't type them anywhere while the app runs.";
  return null;
}

/** The first key that two of the hotkeys share, or null when they are all different. */
export function duplicateHotkey(h: Hotkeys): string | null {
  const seen = new Set<string>();
  for (const name of HOTKEY_NAMES) {
    if (seen.has(h[name])) return h[name];
    seen.add(h[name]);
  }
  return null;
}

/**
 * Stored hotkeys, falling back to the defaults for anything missing, unusable or already taken by an earlier
 * hotkey. If a default then collides with a custom key (say lobby is saved as F6), everything is reset.
 */
export function cleanHotkeys(h: Partial<Hotkeys> | undefined): Hotkeys {
  const out = { ...DEFAULT_HOTKEYS } as Hotkeys;
  const used = new Set<string>();
  for (const name of HOTKEY_NAMES) {
    const k = h?.[name];
    out[name] = k && !hotkeyProblem(k) && !used.has(k) ? k : DEFAULT_HOTKEYS[name];
    used.add(out[name]);
  }
  return duplicateHotkey(out) ? { ...DEFAULT_HOTKEYS } : out;
}
