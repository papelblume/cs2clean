import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CSST_READY,
  checkCsst,
  classifyHttp,
  classifyRequestError,
  configureCsst,
  onCsstStatus,
  resetCsstState,
  scrapeCsstAtProfiles,
  unexpectedCsstFailure,
  type CsstStatus,
} from "../src/main/csst-scrape";

const ID = (n: number) => String(76561198000000000n + BigInt(n));

/** The part of csst.at's answer the parser needs: a couple of stats for this player. */
const page = (id: string) =>
  `<span id="leetify-extra-meta-${id}" hidden></span>\n` +
  `<p id="leetify-aim-${id}" hx-swap-oob="true" class="text-white">41.3</p>\n` +
  `<span id="leetify-games-${id}" hx-swap-oob="outerHTML">30</span>\n`;

// A local server that stands in for csst.at. `handler` decides each answer; every request is recorded.
let server: Server;
let origin: string;
let requests: IncomingMessage[] = [];
let handler: (req: IncomingMessage, res: ServerResponse, id: string) => void = () => {};

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req);
    const id = /^\/(\d{17})\/leetify-extra$/.exec(req.url ?? "")?.[1] ?? "";
    handler(req, res, id);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let dataDir: string;
const savedOrigin = process.env.CS2CLEAN_CSST_ORIGIN;

beforeEach(() => {
  requests = [];
  handler = (_req, res, id) => void res.writeHead(200, { "content-type": "text/html" }).end(page(id));
  dataDir = mkdtempSync(join(tmpdir(), "cs2c-csst-"));
  configureCsst({ dataDir });
  resetCsstState();
  process.env.CS2CLEAN_CSST_ORIGIN = origin;
});
afterEach(() => {
  process.env.CS2CLEAN_CSST_ORIGIN = savedOrigin;
  rmSync(dataDir, { recursive: true, force: true });
});

const headers = { get: (_: string): string | null => null };
const withHeader = (name: string, value: string) => ({ get: (n: string) => (n.toLowerCase() === name ? value : null) });

describe("classifyRequestError", () => {
  it("calls a timeout a timeout, whatever the library's wording", () => {
    for (const text of ["request timed out", "operation timeout", "deadline has elapsed", "Timed-out"])
      expect(classifyRequestError(new Error(text), true)).toMatchObject({ problem: "timeout", siteWide: true });
  });

  it.each([
    ["error sending request for uri (https://csst.at/x): dns error: no such host", "DNS lookup failed"],
    ["client error (Connect): tcp connect error: Connection refused (os error 111)", "connection refused"],
    ["connection reset by peer", "connection reset"],
    ["invalid peer certificate: UnknownIssuer", "TLS handshake failed"],
    ["something else entirely", "connection failed"],
  ])("calls any other failure of the request the site being unreachable, naming the cause in few words (%s)", (text, cause) => {
    const f = classifyRequestError(new Error(text), true);
    expect(f).toMatchObject({ problem: "site-unreachable", siteWide: true, message: `csst.at couldn't be reached (${cause}).` });
    expect(f.detail).toBe(text); // the library's own words go to the log
  });

  it("blames the app, not the site, for an error the library doesn't own", () => {
    const f = classifyRequestError(new TypeError("x is not a function"), false);
    expect(f).toMatchObject({ problem: "crashed", siteWide: false });
    expect(f.detail).toContain("x is not a function");
  });
});

describe("classifyHttp", () => {
  it.each([403, 503])("takes %i to be the site turning the request away", (status) => {
    expect(classifyHttp(status, headers)).toMatchObject({ problem: "blocked", siteWide: true });
  });

  it("recognises a rate limit", () => {
    const f = classifyHttp(429, headers);
    expect(f).toMatchObject({ problem: "blocked", siteWide: true });
    expect(f.message).toContain("rate-limiting");
  });

  it("recognises a Cloudflare check by its header, and by its page", () => {
    const byHeader = classifyHttp(403, withHeader("cf-mitigated", "challenge"));
    expect(byHeader.message).toContain("browser check");
    const byPage = classifyHttp(200, headers, "<title>Just a moment...</title>");
    expect(byPage).toMatchObject({ problem: "blocked", siteWide: true });
    expect(byPage.detail).toContain("Just a moment");
  });

  it("treats any other status as that one player's request failing, not the site's", () => {
    expect(classifyHttp(500, headers)).toMatchObject({ problem: "site-unreachable", message: "HTTP 500", siteWide: false });
  });
});

describe("unexpectedCsstFailure", () => {
  it("turns a bug into a status instead of an exception", () => {
    const s = unexpectedCsstFailure(new Error("kaboom"));
    expect(s).toMatchObject({ state: "unavailable", problem: "crashed" });
    expect(s.reason).toContain("kaboom");
  });
});

describe("checkCsst", () => {
  it("loads wreq-js and says the fallback is ready, to whoever is listening", () => {
    const seen: CsstStatus[] = [];
    const stop = onCsstStatus((s) => seen.push(s));
    expect(checkCsst()).toEqual(CSST_READY);
    stop();
    expect(seen).toEqual([CSST_READY]);
  });
});

describe("scrapeCsstAtProfiles", () => {
  it("does nothing, and says the fallback is fine, when there is nobody to look up", async () => {
    expect(await scrapeCsstAtProfiles([], 0)).toEqual({ profiles: new Map(), status: CSST_READY });
    expect(requests).toHaveLength(0);
  });

  it("asks the way csst.at's own page does, and parses the answer", async () => {
    const r = await scrapeCsstAtProfiles([ID(1)], 0);
    expect(r.status).toEqual(CSST_READY);
    expect(r.profiles.get(ID(1))).toMatchObject({ steam64_id: ID(1), source: "csst.at", total_matches: 30, rating: { aim: 41.3 } });

    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`/${ID(1)}/leetify-extra`);
    expect(req.headers["hx-request"]).toBe("true");
    expect(req.headers["hx-trigger"]).toBe(`leetify-extra-meta-${ID(1)}`);
    expect(req.headers["hx-target"]).toBe(`leetify-extra-meta-${ID(1)}`);
    expect(req.headers["hx-current-url"]).toBe(`${origin}/profile/${ID(1)}`);
    expect(req.headers.referer).toBe(`${origin}/profile/${ID(1)}`);
    // No cookie is needed: csst.at only checks the connection looks like Chrome's.
    expect(req.headers.cookie).toBeUndefined();
    // The impersonated browser's own headers come with it.
    expect(req.headers["user-agent"]).toMatch(/Chrome\/\d+/);
  });

  it("looks players up one after the other, in order", async () => {
    const r = await scrapeCsstAtProfiles([ID(1), ID(2), ID(3)], 0);
    expect([...r.profiles.keys()]).toEqual([ID(1), ID(2), ID(3)]);
    expect(requests.map((q) => q.url)).toEqual([ID(1), ID(2), ID(3)].map((id) => `/${id}/leetify-extra`));
  });

  it("pauses between players, not after the last one", async () => {
    const t0 = Date.now();
    await scrapeCsstAtProfiles([ID(1), ID(2)], 300);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    const t1 = Date.now();
    await scrapeCsstAtProfiles([ID(3)], 5000);
    expect(Date.now() - t1).toBeLessThan(2000);
  });

  it("treats a 404, and an answer with nothing in it, as csst.at having no data: no profile, no failure", async () => {
    handler = (_req, res, id) => {
      if (id === ID(1)) return void res.writeHead(404).end("not found");
      res.writeHead(200).end("<div>no stats here</div>");
    };
    const r = await scrapeCsstAtProfiles([ID(1), ID(2)], 0);
    expect(r.profiles.size).toBe(0);
    expect(r.status).toEqual(CSST_READY);
    expect(r.failed?.size ?? 0).toBe(0);
  });

  it("reports the players csst.at failed for while it answered for others, and the fallback stays ready", async () => {
    handler = (_req, res, id) => {
      if (id === ID(2)) return void res.writeHead(500).end("boom");
      res.writeHead(200).end(page(id));
    };
    const r = await scrapeCsstAtProfiles([ID(1), ID(2), ID(3)], 0);
    expect([...r.profiles.keys()]).toEqual([ID(1), ID(3)]);
    expect(r.status).toEqual(CSST_READY);
    expect(r.failed).toEqual(new Map([[ID(2), "HTTP 500"]]));
  });

  it("says the site turned the request away when it does so for everybody, and stops knocking after the first", async () => {
    handler = (_req, res) => void res.writeHead(403, { "cf-mitigated": "challenge" }).end("<title>Just a moment...</title>");
    const r = await scrapeCsstAtProfiles([ID(1), ID(2), ID(3)], 0);
    expect(r.profiles.size).toBe(0);
    expect(r.status).toMatchObject({ state: "unavailable", problem: "blocked" });
    expect(r.status.reason).toContain("browser check");
    expect(requests).toHaveLength(1);
  });

  it("keeps what it found before the site turned it away, and marks the rest to be asked again", async () => {
    handler = (_req, res, id) => {
      if (id === ID(1)) return void res.writeHead(200).end(page(id));
      res.writeHead(429).end("slow down");
    };
    const r = await scrapeCsstAtProfiles([ID(1), ID(2), ID(3)], 0);
    expect([...r.profiles.keys()]).toEqual([ID(1)]);
    expect(r.status).toEqual(CSST_READY);
    expect([...(r.failed ?? new Map()).keys()]).toEqual([ID(2), ID(3)]);
    expect(r.failed!.get(ID(3))).toContain("rate-limiting");
    expect(requests).toHaveLength(2);
  });

  it("calls an unreachable csst.at unreachable, and doesn't try every player", async () => {
    process.env.CS2CLEAN_CSST_ORIGIN = "http://127.0.0.1:1"; // nothing listens there
    const r = await scrapeCsstAtProfiles([ID(1), ID(2)], 0);
    expect(r.status).toMatchObject({ state: "unavailable", problem: "site-unreachable" });
    expect(r.status.reason).toContain("couldn't be reached");
    expect(r.profiles.size).toBe(0);
  });

  it("logs a problem in the data folder once, and says when it is over", async () => {
    handler = (_req, res) => void res.writeHead(503).end("down");
    await scrapeCsstAtProfiles([ID(1)], 0);
    await scrapeCsstAtProfiles([ID(1)], 0); // the same problem again: not logged twice
    handler = (_req, res, id) => void res.writeHead(200).end(page(id));
    await scrapeCsstAtProfiles([ID(1)], 0);

    const log = readFileSync(join(dataDir, "csst.log"), "utf8");
    expect(log.match(/\[blocked\]/g)).toHaveLength(1);
    expect(log).toContain("HTTP 503");
    expect(log).toContain("the csst.at fallback is working");
  });

  it("tells every listener when the status changes", async () => {
    const seen: CsstStatus[] = [];
    const stop = onCsstStatus((s) => seen.push(s));
    handler = (_req, res) => void res.writeHead(503).end("down");
    await scrapeCsstAtProfiles([ID(1)], 0);
    handler = (_req, res, id) => void res.writeHead(200).end(page(id));
    await scrapeCsstAtProfiles([ID(1)], 0);
    stop();
    expect(seen.map((s) => s.problem)).toEqual(["blocked", null]);
  });
});
