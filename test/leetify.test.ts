import { describe, expect, it } from "vitest";
import { LeetifyClient, LeetifyError, lookupLobby } from "../src/main/leetify";
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
    expect(out[1].matchesAnalyzed).toBe(30);
  });

  it("treats a player without a public profile as an answer, not a failure", async () => {
    const out = await lookupLobby(new LeetifyClient("k", fake({}).fetchImpl), [ID(1)]);
    expect(out[0]).toMatchObject({ classification: "INSUFFICIENT_DATA", note: expect.stringMatching(/Not on Leetify/) });
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

  it("reports whether Leetify could be reached", async () => {
    const seen: boolean[] = [];
    const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await lookupLobby(new LeetifyClient("k", down), [ID(1)], { onReach: (ok) => seen.push(ok) });
    await lookupLobby(new LeetifyClient("k", fake({ [ID(1)]: AVERAGE() }).fetchImpl), [ID(1)], { onReach: (ok) => seen.push(ok) });
    expect(seen).toEqual([false, true]);
  });
});
