// Click-through for the overlay window (BrowserWindow.setIgnoreMouseEvents).
//
// On Linux the call makes the window's X11 input region one pixel big, so clicks land on what is behind it. Under
// Cinnamon's window manager (Muffin) that region is lost again in the moments after the window is mapped (shown): a call
// made before the window is shown, or right after showInactive(), is wiped out, and only a call made once the window
// has settled sticks. Nothing tells the app when that is (bounds events don't, and repeating the call on them doesn't
// help), so the call is repeated for a few seconds after every show. Windows keeps the window style Electron sets, and
// one call is enough there.

/** When to repeat the call after a show, in ms. The first ones catch a quick window manager, the later ones a slow one. */
export const CLICK_THROUGH_RETRIES_MS = [50, 150, 400, 1000, 2500];

export interface ClickThroughWindow {
  setIgnoreMouseEvents(ignore: boolean): void;
  isDestroyed(): boolean;
}

/** Makes the window click-through now, and on Linux again shortly after, for when it was just shown. */
export function keepClickThrough(
  win: ClickThroughWindow,
  platform: string = process.platform,
  later: (fn: () => void, ms: number) => unknown = setTimeout,
): void {
  win.setIgnoreMouseEvents(true);
  if (platform !== "linux") return;
  for (const ms of CLICK_THROUGH_RETRIES_MS) {
    later(() => {
      if (!win.isDestroyed()) win.setIgnoreMouseEvents(true);
    }, ms);
  }
}
