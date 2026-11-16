// Resizing the overlay window to its page (see shared/overlay-layout.ts for why the window has to follow the page).

import { overlaySize } from "../shared/overlay-layout";

/** The part of BrowserWindow this needs, so a test can stand in for it. */
export interface ResizableWindow {
  getContentSize(): number[];
  setContentSize(width: number, height: number): void;
  setResizable(resizable: boolean): void;
  isDestroyed(): boolean;
}

/**
 * Makes the window as big as the page says it needs (the page's box and margin, CSS pixels), but no bigger than the
 * work area leaves room for. Returns whether the window changed size. A size that isn't a positive number (the page is
 * not trusted with more than numbers) changes nothing.
 *
 * The overlay is made non-resizable so nobody drags it. Some Linux window managers then hold it to its size and
 * ignore the app's resize too (openbox doesn't; not every one has been tried), so on Linux it is made resizable for
 * the moment of the call, which is harmless where it isn't needed.
 */
export function resizeOverlay(
  win: ResizableWindow,
  content: { width: unknown; height: unknown },
  area: { width: number; height: number },
  platform: string = process.platform,
): boolean {
  const { width, height } = content;
  if (win.isDestroyed() || typeof width !== "number" || typeof height !== "number") return false;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  const size = overlaySize({ width, height }, area);
  const [w, h] = win.getContentSize();
  if (w === size.width && h === size.height) return false;
  if (platform === "linux") win.setResizable(true);
  try {
    win.setContentSize(size.width, size.height);
  } finally {
    if (platform === "linux") win.setResizable(false);
  }
  return true;
}
