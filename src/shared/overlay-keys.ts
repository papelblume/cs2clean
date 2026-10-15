// What the lobby key (Shift+F2) and the detail key (F7) do to the overlay. The controller and the browser simulation
// in renderer/bridge.ts both take their answer from here, so the simulation can't behave differently from the app.

import type { AppState } from "./types";

type Overlay = AppState["overlay"];

/**
 * One press of the lobby key (view "lobby") or the detail key (view "detail"). That view comes up; the overlay hides
 * only when that very view is the one showing. A press while another view is open (the F6 card, say) switches to the
 * pressed key's view instead of closing the overlay.
 */
export function pressViewKey(o: Overlay, view: "lobby" | "detail"): Overlay {
  const hide = o.visible && o.view === view;
  return { ...o, visible: !hide, view };
}
