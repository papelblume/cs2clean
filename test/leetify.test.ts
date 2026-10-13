import { describe, expect, it } from "vitest";
import { LeetifyClient, LeetifyError, lookupLobby, type LeetifyProfile } from "../src/main/leetify";
import { HERO_READY, type HeroProblem, type HeroScrape, type HeroStatus } from "../src/main/leetify-hero";
import { AVERAGE, HIGH } from "./profiles";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/** A fake Leetify: `answers[steamId]` is a profile or a ready Response. */
function fake(answers: Record<string, unknown>, o: { key?: string; delayMs?: number } = {}) {
  const log = { urls: [] as string[], headers: [] as Headers[], inFlight: 0, maxInFlight: 0 };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    log.urls.push(url);
    const h = new Headers(init?.headers);
    log.headers.push(h);
    log.maxInFlight = Math.max(log.maxInFlight, ++log.inFlight);
    try {
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      const u = new URL(url);
      const sent = h.get("_leetify_key") ?? h.get("Authorization")?.replace("Bearer ", "");
      if (o.key && sent !== o.key) return json(401, { error: "unauthorized" });
      if (u.pathname === "/api-key/validate") return json(200, {});
      const a = answers[u.searchParams.get("steam64_id") ?? ""];
      if (a instanceof Response) return a.clone();
      return a ? json(200, a) : json(404, { error: "not found" });
    } finally {
      log.inFlight--;
    }
  }) as typeof fetch;
  return { fetchImpl, log };
}

const ID = (n: number) => String(76561198000000000n + BigInt(n));

/** A stand-in for the csst.at fallback: `found` are the profiles it returns, `status` how the fallback itself fared. */
function scraper(found: Record<string, LeetifyProfile>, status: HeroStatus = HERO_READY, failed: Record<string, string> = {}) {
  const calls: string[][] = [];
  const scrape = async (ids: string[]): Promise<HeroScrape> => {
    calls.push(ids);
    return {
      profiles: new Map(Object.entries(found).filter(([id]) => ids.includes(id))),
      status,
      failed: new Map(Object.entries(failed).filter(([id]) => ids.includes(id))),
    };
  };
  return { scrape, calls };
}

const broken = (problem: HeroProblem, reason: string): HeroStatus => ({ state: "unavailable", problem, reason, detail: null });

describe("LeetifyClient", () => {
  it("asks for /v3/profile with the SteamID64 and sends the key both ways", async () => {
    const f = fake({ [ID(1)]: AVERAGE() }, { key: "secret" });
    const p = await new LeetifyClient("secret", f.fetchImpl).profile(ID(1));
    expect(p.name).toBe("player");
    expect(f.log.urls[0]).toBe(`https://api-public.cs-prod.leetify.com/v3/profile?steam64_id=${ID(1)}`);
    expect(f.log.headers[0].get("Authorization")).toBe("Bearer secret");
    expect(f.log.headers[0].get("_leetify_key")).toBe("secret");
  });

  it("sends no key header without a key", async () => {
    const f = fake({ [ID(1)]: AVERAGE() });
    await new LeetifyClient(null, f.fetchImpl).profile(ID(1));
    expect(f.log.headers[0].has("Authorization")).toBe(false);
    expect(f.log.headers[0].has("_leetify_key")).toBe(false);
  });

  it("names the kind of failure", async () => {
    const kind = async (res: Response | Error) => {
      const fetchImpl = (async () => { if (res instanceof Error) throw res; return res; }) as typeof fetch;
      return new LeetifyClient("k", fetchImpl).profile(ID(1)).then(() => "ok", (e: LeetifyError) => `${e.kind}:${e.retryAfterMs}`);
    };
    expect(await kind(json(401, {}))).toBe("invalid-key:null");
    expect(await kind(json(404, {}))).toBe("not-found:null");
    expect(await kind(json(403, {}))).toBe("not-found:null");
    expect(await kind(json(429, {}, { "Retry-After": "7" }))).toBe("rate-limited:7000");
    expect(await kind(json(429, {}))).toBe("rate-limited:null");
    expect(await kind(json(500, {}))).toBe("server:null");
    expect(await kind(new Response("<html>", { status: 200 }))).toBe("bad-response:null");
    expect(await kind(new TypeError("fetch failed"))).toBe("network:null");
    expect(await kind(Object.assign(new Error("t"), { name: "TimeoutError" }))).toBe("timeout:null");
  });

  it("validates a key", async () => {
    const f = fake({}, { key: "good" });
    expect(await new LeetifyClient("good", f.fetchImpl).validateKey()).toBe(true);
    expect(await new LeetifyClient("bad", f.fetchImpl).validateKey()).toBe(false);
  });
});

describe("lookupLobby", () => {
  it("classifies every player and keeps their order", async () => {
    const f = fake({ [ID(1)]: HIGH(), [ID(2)]: AVERAGE() });
    const out = await lookupLobby(new LeetifyClient("k", f.fetchImpl), [ID(2), ID(1)]);
    expect(out.map((a) => [a.steamId, a.classification])).toEqual([[ID(2), "NORMAL"], [ID(1), "HIGH"]]);
    expect(out[1].detail?.score).toBeGreaterThan(60);
    expect(out[1].totalMatches).toBe(30);
  });

  it("treats a player without a public profile as an answer, not a failure", async () => {
    const out = await lookupLobby(new LeetifyClient("k", fake({}).fetchImpl), [ID(1)], { scrape: scraper({}).scrape });
    expect(out[0]).toMatchObject({ classification: "INSUFFICIENT_DATA", note: "Not on Leetify, or the profile isn't public" });
    expect(out[0].transient).toBeUndefined();
  });

  it("marks rate limits and network problems as temporary, with Retry-After", async () => {
    const f = fake({ [ID(1)]: json(429, {}, { "Retry-After": "12" }), [ID(2)]: HIGH() });
    const out = await lookupLobby(new LeetifyClient("k", f.fetchImpl), [ID(1), ID(2)]);
    expect(out[0]).toMatchObject({ classification: null, transient: true, retryAfterMs: 12_000 });
    expect(out[1].classification).toBe("HIGH");
  });

  it("stops and throws when the key is rejected", async () => {
    const f = fake({ [ID(1)]: HIGH() }, { key: "good" });
    const ids = [1, 2, 3, 4, 5, 6].map(ID);
    await expect(lookupLobby(new LeetifyClient("bad", f.fetchImpl), ids, { concurrency: 1 })).rejects.toThrow(/rejected the API key/);
    expect(f.log.urls).toHaveLength(1); // no point asking the other five
  });

  it("limits the requests in flight", async () => {
    const answers = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [ID(n), AVERAGE()]));
    const f = fake(answers, { delayMs: 5 });
    const out = await lookupLobby(new LeetifyClient("k", f.fetchImpl), Object.keys(answers), { concurrency: 3 });
    expect(out).toHaveLength(8);
    expect(f.log.maxInFlight).toBe(3);
  });

  describe("the csst.at fallback", () => {
    it("is asked only about players Leetify doesn't know, and its profile becomes the answer", async () => {
      const sc = scraper({ [ID(2)]: AVERAGE() });
      const sources: [string, string | null][] = [];
      const out = await lookupLobby(new LeetifyClient("k", fake({ [ID(1)]: HIGH() }).fetchImpl), [ID(1), ID(2)], {
        scrape: sc.scrape,
        onSource: (id, s) => sources.push([id, s]),
      });
      expect(sc.calls).toEqual([[ID(2)]]);
      expect(out[0].classification).toBe("HIGH");
      expect(out[1]).toMatchObject({ classification: "NORMAL", note: expect.stringMatching(/csst\.at/) });
      expect(sources).toContainEqual([ID(2), "scrape"]);
    });

    it("is not asked at all when Leetify knows everybody", async () => {
      const sc = scraper({});
      await lookupLobby(new LeetifyClient("k", fake({ [ID(1)]: HIGH() }).fetchImpl), [ID(1)], { scrape: sc.scrape });
      expect(sc.calls).toEqual([]);
    });

    it("says why when it is broken for good, instead of guessing the profile is private", async () => {
      const reason = "A native module was built for a different Node version (module ABI 127; the Node that runs it needs 137).";
      const sc = scraper({}, broken("abi-mismatch", reason));
      const out = await lookupLobby(new LeetifyClient("k", fake({}).fetchImpl), [ID(1)], { scrape: sc.scrape });
      expect(out[0]).toMatchObject({ classification: "INSUFFICIENT_DATA" });
      expect(out[0].note).toContain("The csst.at fallback couldn't check");
      expect(out[0].note).toContain(reason);
      expect(out[0].transient).toBeUndefined(); // settled: asking again in a minute wouldn't change a build problem
      expect(out[0].recheckAfterMs).toBe(5 * 60_000); // but not for the cache's six hours either: a fix made meanwhile is noticed
    });

    it.each<HeroProblem>(["crashed", "bad-output"])(
      "settles the answer but looks again in five minutes when the fallback broke without saying why (%s)", async (problem) => {
        const sc = scraper({}, broken(problem, "stopped unexpectedly"));
        const out = await lookupLobby(new LeetifyClient("k", fake({}).fetchImpl), [ID(1)], { scrape: sc.scrape });
        expect(out[0]).toMatchObject({ classification: "INSUFFICIENT_DATA", recheckAfterMs: 5 * 60_000 });
        expect(out[0].transient).toBeUndefined(); // a transient answer would hold the rest of the lobby back
        expect(out[0].note).toContain("stopped unexpectedly");
      });

    it.each<HeroProblem>(["browser-missing", "site-unreachable", "timeout"])(
      "asks again later when the problem can clear up by itself (%s)", async (problem) => {
        const sc = scraper({}, broken(problem, "try later"));
        const out = await lookupLobby(new LeetifyClient("k", fake({}).fetchImpl), [ID(1)], { scrape: sc.scrape });
        expect(out[0]).toMatchObject({ classification: null, transient: true, retryAfterMs: 60_000 });
        expect(out[0].note).toContain("try later");
      });

    it("keeps the plain answer when the fallback works and csst.at has nothing on the player", async () => {
      const out = await lookupLobby(new LeetifyClient("k", fake({}).fetchImpl), [ID(1)], { scrape: scraper({}).scrape });
      expect(out[0].note).toBe("Not on Leetify, or the profile isn't public");
      expect(out[0].recheckAfterMs).toBeUndefined(); // a real "nothing there" keeps the usual cache time
    });

    it("asks again soon about a player csst.at failed for, not about the ones it has nothing on", async () => {
      const sc = scraper({ [ID(2)]: AVERAGE() }, HERO_READY, { [ID(3)]: "HTTP 503\n    at somewhere" });
      const out = await lookupLobby(new LeetifyClient("k", fake({}).fetchImpl), [ID(1), ID(2), ID(3)], { scrape: sc.scrape });
      expect(out[0]).toMatchObject({ classification: "INSUFFICIENT_DATA", note: "Not on Leetify, or the profile isn't public" });
      expect(out[1].classification).toBe("NORMAL");
      expect(out[2]).toMatchObject({ classification: null, transient: true, retryAfterMs: 60_000 });
      expect(out[2].note).toBe("Not on Leetify, and csst.at couldn't answer for this player: HTTP 503");
    });
  });

  describe("one player's data can't break the others", () => {
    const unreadable = { ...AVERAGE(), bans: "none" } as unknown as LeetifyProfile; // bans has to be a list

    it("gives a profile the analysis can't read its own answer, and the others keep theirs", async () => {
      const seen: [string, string | null][] = [];
      const f = fake({ [ID(1)]: HIGH(), [ID(2)]: unreadable, [ID(3)]: AVERAGE() });
      const out = await lookupLobby(new LeetifyClient("k", f.fetchImpl), [ID(1), ID(2), ID(3)], { onSource: (id, source) => seen.push([id, source]) });
      expect(out.map((a) => [a.steamId, a.classification])).toEqual([[ID(1), "HIGH"], [ID(2), "INSUFFICIENT_DATA"], [ID(3), "NORMAL"]]);
      expect(out[1].note).toBe("Leetify sent a profile the app couldn't read");
      expect(out[1].transient).toBeUndefined(); // settled: the same data would fail the same way in 15 s
      expect(seen).toContainEqual([ID(2), null]);
      expect(seen).not.toContainEqual([ID(2), "api"]);
    });

    it("does the same for a scraped profile", async () => {
      const sc = scraper({ [ID(2)]: unreadable, [ID(3)]: HIGH() });
      const out = await lookupLobby(new LeetifyClient("k", fake({ [ID(1)]: AVERAGE() }).fetchImpl), [ID(1), ID(2), ID(3)], { scrape: sc.scrape });
      expect(out.map((a) => a.classification)).toEqual(["NORMAL", "INSUFFICIENT_DATA", "HIGH"]);
      expect(out[1].note).toBe("csst.at sent a profile the app couldn't read");
      expect(out[1].transient).toBeUndefined();
    });

    it("keeps the others' answers when the fallback itself throws", async () => {
      const scrape = async (): Promise<HeroScrape> => { throw new Error("boom"); };
      const out = await lookupLobby(new LeetifyClient("k", fake({ [ID(1)]: HIGH() }).fetchImpl), [ID(1), ID(2)], { scrape });
      expect(out[0].classification).toBe("HIGH");
      expect(out[1]).toMatchObject({ classification: "INSUFFICIENT_DATA" });
      expect(out[1].note).toContain("The csst.at fallback couldn't check");
      expect(out[1].note).toContain("boom");
      expect(out[1].transient).toBeUndefined();
    });

    it("makes an unexpected error while fetching one profile that player's temporary failure", async () => {
      const client = new LeetifyClient("k", fake({ [ID(1)]: HIGH(), [ID(2)]: AVERAGE() }).fetchImpl);
      const real = client.profile.bind(client);
      client.profile = async (id: string) => { if (id === ID(2)) throw new TypeError("boom"); return real(id); };
      const out = await lookupLobby(client, [ID(1), ID(2)]);
      expect(out[0].classification).toBe("HIGH");
      expect(out[1]).toMatchObject({ classification: null, transient: true });
      expect(out[1].note).toContain("boom");
    });
  });

  it("reports whether Leetify could be reached", async () => {
    const seen: boolean[] = [];
    const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await lookupLobby(new LeetifyClient("k", down), [ID(1)], { onReach: (ok) => seen.push(ok) });
    await lookupLobby(new LeetifyClient("k", fake({ [ID(1)]: AVERAGE() }).fetchImpl), [ID(1)], { onReach: (ok) => seen.push(ok) });
    expect(seen).toEqual([false, true]);
  });
});
