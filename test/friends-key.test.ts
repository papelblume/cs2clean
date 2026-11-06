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

describe("validateSteamKey", () => {
  beforeEach(() => mockFetch.mockReset());
  const answer = (status: number, body = "") => ({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body) });

  test("accepts a key Steam answers for, whether the test account's friends list is public (200) or private (401)", async () => {
    const { validateSteamKey } = await import("../src/main/steam/friends");
    mockFetch.mockResolvedValueOnce(answer(200, '{"friendslist":{"friends":[]}}'));
    expect(await validateSteamKey("good-key")).toBe(true);
    mockFetch.mockResolvedValueOnce(answer(401, "<html><body>Unauthorized</body></html>"));
    expect(await validateSteamKey("good-key")).toBe(true);
  });

  test("rejects a key Steam turns down (403), whatever the body looks like", async () => {
    const { validateSteamKey } = await import("../src/main/steam/friends");
    mockFetch.mockResolvedValueOnce(answer(403, "<html><body>Forbidden</body></html>"));
    expect(await validateSteamKey("bad-key")).toBe(false);
    mockFetch.mockResolvedValueOnce(answer(403, "{}"));
    expect(await validateSteamKey("bad-key")).toBe(false);
  });

  test("doesn't call the key invalid when Steam can't answer: a rate limit, an outage or an odd status throws", async () => {
    const { validateSteamKey } = await import("../src/main/steam/friends");
    for (const status of [429, 500, 503, 400]) {
      mockFetch.mockResolvedValueOnce(answer(status, "<html><body>Service Unavailable</body></html>"));
      await expect(validateSteamKey("good-key")).rejects.toThrow(`Steam answered HTTP ${status}`);
    }
  });

  test("lets a network failure through, for the caller to report as 'couldn't check'", async () => {
    const { validateSteamKey } = await import("../src/main/steam/friends");
    mockFetch.mockRejectedValueOnce(new Error("fetch failed"));
    await expect(validateSteamKey("good-key")).rejects.toThrow("fetch failed");
  });

  test("sends the key it was given, URL-encoded", async () => {
    const { validateSteamKey } = await import("../src/main/steam/friends");
    mockFetch.mockResolvedValueOnce(answer(200));
    await validateSteamKey("a b&c");
    expect(String(mockFetch.mock.calls[0][0])).toContain("key=a%20b%26c");
  });
});
