// The geometry of the in-game overlay: how the F7 cards are laid out, and how big the overlay window has to be.
//
// The overlay window is see-through and click-through, so nothing in it can be scrolled: the page has to be as big as
// its content and the window has to follow the page. The page measures itself and tells the main process
// (Bridge.setOverlaySize); the main process makes the window that size (overlaySize() below keeps it on the screen).
//
// Pure functions with no Electron or React in them, so both sides use the same numbers and the tests can reach them.

/** Where the overlay window sits on the primary display's work area. Its top-left corner stays put; it grows right and down. */
export const OVERLAY_ORIGIN = { x: 24, y: 120 } as const;

/** The window's size before the page has measured itself, and the page's width for the list and the one-player card. */
export const OVERLAY_SIZE = { width: 380, height: 640 } as const;

/** The page's margin around the overlay's box (`.ov` in style.css): the window is this much bigger than the box. */
export const OVERLAY_MARGIN = 6;

/** F7: the width of a card, the space between cards, and the padding around them (`.ov-cards` in style.css). */
export const CARD_WIDTH = 352;
export const CARD_GAP = 8;
export const CARDS_PADDING = 8;

/** F7: cards go two to a column, and a new column starts to the right when there are more than two players. */
export const CARDS_PER_COLUMN = 2;

export interface DetailLayout {
  /** Columns of cards. */
  columns: number;
  /** Rows in the tallest column (1 or 2). */
  rows: number;
  /** How many cards fit on the screen: the first this many are shown. */
  shown: number;
  /** Cards that don't fit, and are only counted ("+2 more flagged players"). */
  more: number;
}

/**
 * The F7 layout for `count` flagged players, on a screen `availWidth` wide (CSS pixels): two cards to a column,
 * columns added to the right, as many as the screen holds. Cards run down the first column, then down the next:
 *
 *   1 player:  [1]            3 players: [1] [3]          4 players: [1] [3]
 *   2 players: [1]                       [2]                         [2] [4]
 *              [2]
 */
export function detailLayout(count: number, availWidth: number, origin = OVERLAY_ORIGIN): DetailLayout {
  const room = availWidth - origin.x - 2 * OVERLAY_MARGIN - 2 * CARDS_PADDING;
  const fit = Math.max(1, Math.floor((room + CARD_GAP) / (CARD_WIDTH + CARD_GAP)));
  const columns = Math.max(1, Math.min(Math.ceil(count / CARDS_PER_COLUMN), fit));
  const shown = Math.min(count, columns * CARDS_PER_COLUMN);
  return { columns, rows: Math.min(shown, CARDS_PER_COLUMN), shown, more: count - shown };
}

/** The width of the overlay's box (without its margin) for that many columns of cards. One column is 368: the list's width. */
export function detailWidth(columns: number): number {
  return columns * CARD_WIDTH + (columns - 1) * CARD_GAP + 2 * CARDS_PADDING;
}

/**
 * The window size for a page that measured itself at `content` (the box and its margin, CSS pixels): whole pixels,
 * and no bigger than what is left of the work area from the window's corner to its edges. A page that is bigger than
 * the screen is cut off there (nothing in the overlay can scroll) instead of making a window that leaves the screen.
 */
export function overlaySize(
  content: { width: number; height: number },
  area: { width: number; height: number },
  origin = OVERLAY_ORIGIN,
): { width: number; height: number } {
  const fit = (want: number, room: number) => Math.max(1, Math.min(Math.ceil(want), Math.floor(room)));
  return { width: fit(content.width, area.width - origin.x), height: fit(content.height, area.height - origin.y) };
}
