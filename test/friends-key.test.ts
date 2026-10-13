import { beforeEach, describe, expect, test, vi } from "vitest";

// Instant pauses that remember how long they were asked to be: fast tests that can say what was waited for.
const pauses = vi.hoisted(() => [] as number[]);
vi.mock("node:timers/promises", () => ({ setTimeout: async (ms: number) => { pauses.push(ms); } }));

const mockFetch = vi.fn();
global.fetch = mockFetch;

const forbidden = () => ({ ok: false, status: 403, text: () => Promise.resolve("<html><body>Forbidden</body></html>") });
const ok = (friends: string[] = []) =>
  ({ ok: true, status: 200, json: () => Promise.resolve({ friendslist: { friends: friends.map((steamid) => ({ steamid })) } }) });

describe("Steam rejects the API key (403)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    pauses.length = 0;
  });

  test("grouping fails at once: one request, no retries, no pause", async () => {
    const { groupPlayers } = await import("../src/main/steam/friends");
    mockFetch.mockResolvedValue(forbidden());
    await expect(groupPlayers(["a", "b"], "bad-key")).rejects.toThrow(/^Steam API key invalid or missing: .*Forbidden/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(pauses).toEqual([]);
  });

  test("the other players are not asked about", async () => {
    const { groupPlayers } = await import("../src/main/steam/friends");
    mockFetch.mockResolvedValue(forbidden());
    await expect(groupPlayers(["a", "b", "c", "d", "e"], "bad-key")).rejects.toThrow(/key invalid/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("it also fails when the first players were answered fine", async () => {
    const { groupPlayers } = await import("../src/main/steam/friends");
    mockFetch.mockResolvedValueOnce(ok(["b"])).mockResolvedValue(forbidden());
    await expect(groupPlayers(["a", "b", "c"], "bad-key")).rejects.toThrow(/key invalid/);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("other failures are still retried and only reported", async () => {
    const { groupPlayers } = await import("../src/main/steam/friends");
    mockFetch.mockResolvedValue({ ok: false, status: 429 });
    const result = await groupPlayers(["a"], "good-key");
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result.errors).toEqual(["a"]);
  });
});
