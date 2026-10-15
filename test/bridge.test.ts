import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/shared/types";

// The browser simulation of the app's API (`npm run dev:ui`): its overlay hotkeys have to do what the real
// controller's do, or the overlay looks different in the browser than it behaves in the app.

/** A fresh simulation, as the page `?screen=...` shows it. */
async function simulation(screen = "lobby"): Promise<Bridge> {
  vi.resetModules();
  vi.stubGlobal("window", {}); // no preload script: the simulation stands in
  vi.stubGlobal("location", { search: `?screen=${screen}` });
  return (await import("../src/renderer/bridge")).bridge;
}
afterEach(() => vi.unstubAllGlobals());

/** What the overlay shows: its view, or "hidden". */
async function shown(b: Bridge) {
  const { visible, view } = (await b.getState()).overlay;
  return visible ? view : "hidden";
}

describe("the simulated overlay hotkeys", () => {
  it("Shift+F2 opens the list over an open F6 card, instead of closing the overlay", async () => {
    const b = await simulation();
    await b.cyclePlayer(); // F6
    expect(await shown(b)).toBe("player");
    await b.toggleOverlay(); // Shift+F2
    expect(await shown(b)).toBe("lobby");
  });

  it("Shift+F2 opens the list over an open F7 card, too", async () => {
    const b = await simulation();
    await b.toggleDetail(); // F7
    expect(await shown(b)).toBe("detail");
    await b.toggleOverlay();
    expect(await shown(b)).toBe("lobby");
  });

  it("Shift+F2 opens the list when nothing is open, and hides it when the list is showing", async () => {
    const b = await simulation();
    await b.toggleOverlay();
    expect(await shown(b)).toBe("lobby");
    await b.toggleOverlay();
    expect(await shown(b)).toBe("hidden");
  });

  it("F7 hides its own cards, as in the app, and opens over the list and over an F6 card", async () => {
    const b = await simulation();
    await b.toggleOverlay();
    await b.toggleDetail();
    expect(await shown(b)).toBe("detail");
    await b.toggleDetail();
    expect(await shown(b)).toBe("hidden");
    await b.cyclePlayer();
    await b.toggleDetail();
    expect(await shown(b)).toBe("detail");
  });
});
