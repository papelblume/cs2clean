import { describe, expect, it, vi } from "vitest";
import {
  CARD_WIDTH,
  detailLayout,
  detailWidth,
  OVERLAY_MARGIN,
  OVERLAY_SIZE,
  overlaySize,
} from "../src/shared/overlay-layout";
import { resizeOverlay, type ResizableWindow } from "../src/main/overlay-window";

describe("detailLayout: two cards to a column, a column added to the right for every two more", () => {
  const wide = 1920;

  it.each([
    // players, columns, rows in the tallest column
    [0, 1, 0],
    [1, 1, 1],
    [2, 1, 2],
    [3, 2, 2],
    [4, 2, 2],
    [5, 3, 2],
    [6, 3, 2],
    [10, 5, 2],
  ])("%i flagged players: %i column(s), %i row(s), every card shown", (count, columns, rows) => {
    expect(detailLayout(count, wide)).toEqual({ columns, rows, shown: count, more: 0 });
  });

  it("limits the columns to what the screen holds, and counts the players that don't fit", () => {
    // 1366 pixels wide: room for three columns of cards beside the window's corner offset.
    expect(detailLayout(10, 1366)).toEqual({ columns: 3, rows: 2, shown: 6, more: 4 });
    expect(detailLayout(7, 1366)).toEqual({ columns: 3, rows: 2, shown: 6, more: 1 });
    expect(detailLayout(6, 1366)).toEqual({ columns: 3, rows: 2, shown: 6, more: 0 });
  });

  it("always has one column, however narrow the screen", () => {
    expect(detailLayout(4, 300)).toEqual({ columns: 1, rows: 2, shown: 2, more: 2 });
  });

  it("never lets the columns run off the screen", () => {
    for (const availWidth of [800, 1280, 1366, 1600, 1920, 2560, 3840]) {
      const { columns } = detailLayout(99, availWidth);
      const right = 24 + OVERLAY_MARGIN + detailWidth(columns) + OVERLAY_MARGIN;
      expect(right <= availWidth || columns === 1).toBe(true);
    }
  });
});

describe("detailWidth", () => {
  it("is the list's width for one column, and a card and its gap wider for each column after", () => {
    expect(detailWidth(1)).toBe(OVERLAY_SIZE.width - 2 * OVERLAY_MARGIN); // 368: the same box as the list and the F6 card
    expect(detailWidth(2)).toBe(detailWidth(1) + CARD_WIDTH + 8);
    expect(detailWidth(3)).toBe(detailWidth(2) + CARD_WIDTH + 8);
  });
});

describe("overlaySize", () => {
  const area = { width: 1920, height: 1040 };

  it("is the page's size in whole pixels", () => {
    expect(overlaySize({ width: 380, height: 661.2 }, area)).toEqual({ width: 380, height: 662 });
  });

  it("keeps the window on the screen: no bigger than the work area leaves from the window's corner", () => {
    expect(overlaySize({ width: 5000, height: 5000 }, area)).toEqual({ width: 1920 - 24, height: 1040 - 120 });
  });

  it("is never smaller than a pixel", () => {
    expect(overlaySize({ width: 100, height: 100 }, { width: 10, height: 10 })).toEqual({ width: 1, height: 1 });
  });
});

describe("resizeOverlay", () => {
  const area = { width: 1920, height: 1040 };
  function fake(size = [380, 640], destroyed = false) {
    const calls: string[] = [];
    const win: ResizableWindow = {
      getContentSize: () => size,
      setContentSize: vi.fn((w: number, h: number) => void calls.push(`size ${w}x${h}`)),
      setResizable: vi.fn((r: boolean) => void calls.push(`resizable ${r}`)),
      isDestroyed: () => destroyed,
    };
    return { win, calls };
  }

  it("makes the window the page's size", () => {
    const { win, calls } = fake();
    expect(resizeOverlay(win, { width: 740, height: 800 }, area, "win32")).toBe(true);
    expect(calls).toEqual(["size 740x800"]);
  });

  it("leaves a window that is the right size alone", () => {
    const { win, calls } = fake([740, 800]);
    expect(resizeOverlay(win, { width: 740, height: 800 }, area, "win32")).toBe(false);
    expect(calls).toEqual([]);
  });

  it("on Linux lets the window be resized for the moment of the call, and fixes it again", () => {
    const { win, calls } = fake();
    resizeOverlay(win, { width: 740, height: 800 }, area, "linux");
    expect(calls).toEqual(["resizable true", "size 740x800", "resizable false"]);
  });

  it("fixes the window again on Linux even when the resize throws", () => {
    const { win, calls } = fake();
    (win.setContentSize as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("no");
    });
    expect(() => resizeOverlay(win, { width: 740, height: 800 }, area, "linux")).toThrow("no");
    expect(calls).toEqual(["resizable true", "resizable false"]);
  });

  it.each([
    [{ width: "740", height: 800 }],
    [{ width: 740, height: undefined }],
    [{ width: NaN, height: 800 }],
    [{ width: Infinity, height: 800 }],
    [{ width: 0, height: 800 }],
    [{ width: 740, height: -5 }],
    [{ width: null, height: null }],
  ])("takes nothing but positive numbers from the page (%j)", (content) => {
    const { win, calls } = fake();
    expect(resizeOverlay(win, content, area, "win32")).toBe(false);
    expect(calls).toEqual([]);
  });

  it("does nothing to a window that is gone", () => {
    const { win, calls } = fake([380, 640], true);
    expect(resizeOverlay(win, { width: 740, height: 800 }, area, "win32")).toBe(false);
    expect(calls).toEqual([]);
  });
});
