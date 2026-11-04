import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLICK_THROUGH_RETRIES_MS, keepClickThrough } from "../src/main/click-through";

function fakeWindow() {
  const w = { destroyed: false, setIgnoreMouseEvents: vi.fn((_ignore: boolean) => {}), isDestroyed: () => w.destroyed };
  return w;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("keeping the overlay click-through", () => {
  it("makes the window click-through at once", () => {
    const w = fakeWindow();
    keepClickThrough(w, "linux");
    expect(w.setIgnoreMouseEvents).toHaveBeenCalledTimes(1);
    expect(w.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
  });

  it("does it again at each delay on Linux, where the window manager can undo it as it maps the window", () => {
    const w = fakeWindow();
    keepClickThrough(w, "linux");
    let elapsed = 0;
    CLICK_THROUGH_RETRIES_MS.forEach((ms, i) => {
      vi.advanceTimersByTime(ms - elapsed - 1);
      expect(w.setIgnoreMouseEvents).toHaveBeenCalledTimes(1 + i); // not yet
      vi.advanceTimersByTime(1);
      expect(w.setIgnoreMouseEvents).toHaveBeenCalledTimes(2 + i); // now
      elapsed = ms;
    });
    for (const call of w.setIgnoreMouseEvents.mock.calls) expect(call).toEqual([true]);
  });

  it("repeats at the times it says, from soon after the show to a few seconds later", () => {
    const w = fakeWindow();
    const scheduled: number[] = [];
    keepClickThrough(w, "linux", (_fn, ms) => scheduled.push(ms));
    expect(scheduled).toEqual(CLICK_THROUGH_RETRIES_MS);
    expect([...scheduled].sort((a, b) => a - b)).toEqual(scheduled); // in order, so the quickest comes first
    expect(scheduled[0]).toBeLessThanOrEqual(100);
    expect(scheduled.at(-1)).toBeGreaterThanOrEqual(2000);
  });

  it("is one call on Windows and macOS, which keep what they set", () => {
    for (const platform of ["win32", "darwin"]) {
      const w = fakeWindow();
      keepClickThrough(w, platform);
      vi.runAllTimers();
      expect(w.setIgnoreMouseEvents).toHaveBeenCalledTimes(1);
    }
  });

  it("stops quietly once the window is destroyed", () => {
    const w = fakeWindow();
    keepClickThrough(w, "linux");
    vi.advanceTimersByTime(CLICK_THROUGH_RETRIES_MS[0]);
    w.destroyed = true;
    expect(() => vi.runAllTimers()).not.toThrow();
    expect(w.setIgnoreMouseEvents.mock.calls.length).toBeLessThan(1 + CLICK_THROUGH_RETRIES_MS.length);
  });

  it("gives every show its own series", () => {
    const w = fakeWindow();
    keepClickThrough(w, "linux");
    vi.runAllTimers();
    keepClickThrough(w, "linux"); // shown again
    vi.runAllTimers();
    expect(w.setIgnoreMouseEvents).toHaveBeenCalledTimes(2 * (1 + CLICK_THROUGH_RETRIES_MS.length));
  });
});
