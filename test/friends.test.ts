import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

// Mock fetch before importing the module that uses it.
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("friends grouping", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("UnionFind", () => {
    test("single items form single-element groups", async () => {
      const { groupPlayers } = await import("../src/main/steam/friends");
      // No friends for anyone - need one mock per player
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [] } }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [] } }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [] } }),
        });

      const result = await groupPlayers(["a", "b", "c"], "fake-key");
      expect(result.groups).toHaveLength(3);
      expect(result.groups[0]).toEqual(["a"]);
      expect(result.groups[1]).toEqual(["b"]);
      expect(result.groups[2]).toEqual(["c"]);
    });

    test("direct friends are grouped together", async () => {
      const { groupPlayers } = await import("../src/main/steam/friends");
      // a has b as friend, b has a as friend, c is solo
      mockFetch
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [{ steamid: "b" }] } }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [{ steamid: "a" }] } }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [] } }),
        });

      const result = await groupPlayers(["a", "b", "c"], "fake-key");
      expect(result.groups).toHaveLength(2);
      expect(result.groups[0]).toEqual(expect.arrayContaining(["a", "b"]));
      expect(result.groups[1]).toEqual(["c"]);
    });

    test("transitive friendships create larger groups", async () => {
      const { groupPlayers } = await import("../src/main/steam/friends");
      // a-b, b-c => a, b, c all in one group
      mockFetch
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [{ steamid: "b" }] } }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [{ steamid: "a" }, { steamid: "c" }] } }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [{ steamid: "b" }] } }),
        });

      const result = await groupPlayers(["a", "b", "c"], "fake-key");
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]).toEqual(expect.arrayContaining(["a", "b", "c"]));
    });

    test("multiple separate groups", async () => {
      const { groupPlayers } = await import("../src/main/steam/friends");
      // a-b, c-d, e solo
      mockFetch
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [{ steamid: "b" }] } }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [{ steamid: "a" }] } }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [{ steamid: "d" }] } }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [{ steamid: "c" }] } }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [] } }),
        });

      const result = await groupPlayers(["a", "b", "c", "d", "e"], "fake-key");
      // a-b is one group (2), c-d is one group (2), e is solo (1) = 3 groups
      expect(result.groups).toHaveLength(3);
      // Groups should be sorted by size (largest first)
      expect(result.groups[0].length).toBeGreaterThanOrEqual(result.groups[1].length);
      expect(result.groups[1].length).toBeGreaterThanOrEqual(result.groups[2].length);
    });

    test("private friends list returns null and player is in private list", async () => {
      const { groupPlayers } = await import("../src/main/steam/friends");
      // b is private
      mockFetch
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [{ steamid: "b" }] } }),
        })
        .mockResolvedValueOnce({
          ok: false, status: 401,
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [] } }),
        });

      const result = await groupPlayers(["a", "b", "c"], "fake-key");
      expect(result.private).toContain("b");
      // a's list shows b as friend, so a-b edge exists even though b is private
      expect(result.groups).toHaveLength(2); // [a, b] and [c]
      expect(result.groups[0]).toEqual(expect.arrayContaining(["a", "b"]));
    });

    test("non-lobby friends are ignored", async () => {
      const { groupPlayers } = await import("../src/main/steam/friends");
      // a has b (in lobby) and x (not in lobby) as friends
      mockFetch
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [{ steamid: "b" }, { steamid: "x" }] } }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [{ steamid: "a" }] } }),
        });

      const result = await groupPlayers(["a", "b"], "fake-key");
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]).toEqual(expect.arrayContaining(["a", "b"]));
    });

    test("groups are sorted largest first", async () => {
      const { groupPlayers } = await import("../src/main/steam/friends");
      // a-b-c (3), d-e (2), f (1)
      mockFetch
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [{ steamid: "b" }, { steamid: "c" }] } }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [{ steamid: "a" }, { steamid: "c" }] } }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [{ steamid: "a" }, { steamid: "b" }] } }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [{ steamid: "e" }] } }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [{ steamid: "d" }] } }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ friendslist: { friends: [] } }),
        });

      const result = await groupPlayers(["a", "b", "c", "d", "e", "f"], "fake-key");
      expect(result.groups.map((g) => g.length)).toEqual([3, 2, 1]);
    });

    test("deduplicates lobby IDs", async () => {
      const { groupPlayers } = await import("../src/main/steam/friends");
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ friendslist: { friends: [] } }),
      });

      const result = await groupPlayers(["a", "a", "a"], "fake-key");
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]).toEqual(["a"]);
      // Should only have made 1 fetch call despite 3 IDs
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test("empty lobby returns empty groups", async () => {
      const { groupPlayers } = await import("../src/main/steam/friends");
      const result = await groupPlayers([], "fake-key");
      expect(result.groups).toEqual([]);
      expect(result.private).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
