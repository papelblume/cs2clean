import { describe, expect, it } from "vitest";
import { checkForUpdate, parseVersion } from "../src/main/update-checker";

describe("parseVersion", () => {
  it("parses a valid tag into [major, minor, patch]", () => {
    expect(parseVersion("cs2clean-v1.2.3")).toEqual([1, 2, 3]);
  });

  it("parses v0.0.1", () => {
    expect(parseVersion("cs2clean-v0.0.1")).toEqual([0, 0, 1]);
  });

  it("returns null for missing v prefix", () => {
    expect(parseVersion("cs2clean-1.2.3")).toBeNull();
  });

  it("returns null for malformed tags", () => {
    expect(parseVersion("cs2clean-v1.2")).toBeNull();
    expect(parseVersion("cs2clean-v1.2.3.4")).toBeNull();
    expect(parseVersion("cs2clean-v1.a.3")).toBeNull();
    expect(parseVersion("other-v1.2.3")).toBeNull();
  });
});

/** A GitHub that answers with this tag as the latest release. */
const latest = (tag: unknown) => async () => ({ ok: true, json: async () => ({ tag_name: tag }) });

describe("checkForUpdate", () => {
  it("says it is up to date when the remote version is older", async () => {
    expect(await checkForUpdate("1.0.0", latest("cs2clean-v0.9.0") as any)).toEqual({ status: "current" });
  });

  it("says it is up to date when versions are equal", async () => {
    expect(await checkForUpdate("1.0.0", latest("cs2clean-v1.0.0") as any)).toEqual({ status: "current" });
  });

  it("returns the version when the remote version is newer", async () => {
    expect(await checkForUpdate("1.0.0", latest("cs2clean-v1.1.0") as any)).toEqual({ status: "available", remoteVersion: "1.1.0" });
  });

  it("returns the version when only the patch version differs", async () => {
    expect(await checkForUpdate("1.0.0", latest("cs2clean-v1.0.1") as any)).toEqual({ status: "available", remoteVersion: "1.0.1" });
  });

  it("returns the version when the major version differs", async () => {
    expect(await checkForUpdate("1.0.0", latest("cs2clean-v2.0.0") as any)).toEqual({ status: "available", remoteVersion: "2.0.0" });
  });

  it("compares numbers, not text", async () => {
    expect(await checkForUpdate("1.9.0", latest("cs2clean-v1.10.0") as any)).toEqual({ status: "available", remoteVersion: "1.10.0" });
    expect(await checkForUpdate("1.10.0", latest("cs2clean-v1.9.0") as any)).toEqual({ status: "current" });
  });

  describe("when it can't tell, it says so instead of claiming to be up to date", () => {
    it("fails when fetch fails", async () => {
      const mockFetch = async (_url: string, _opts?: unknown) => { throw new TypeError("fetch failed"); };
      expect(await checkForUpdate("1.0.0", mockFetch as any)).toEqual({ status: "failed", reason: "can't reach GitHub (fetch failed)" });
    });

    it("fails when the API returns non-200 (404, or a 403 rate limit)", async () => {
      expect(await checkForUpdate("1.0.0", (async () => ({ ok: false, status: 404 })) as any)).toEqual({ status: "failed", reason: "GitHub answered HTTP 404" });
      expect(await checkForUpdate("1.0.0", (async () => ({ ok: false, status: 403 })) as any)).toEqual({ status: "failed", reason: "GitHub answered HTTP 403" });
    });

    it("fails when the answer isn't JSON", async () => {
      const mockFetch = async () => ({ ok: true, json: async () => { throw new SyntaxError("Unexpected token <"); } });
      expect(await checkForUpdate("1.0.0", mockFetch as any)).toEqual({ status: "failed", reason: "GitHub's answer couldn't be read" });
    });

    it("fails when the answer has no release tag", async () => {
      for (const body of [{}, null, { tag_name: 5 }])
        expect(await checkForUpdate("1.0.0", (async () => ({ ok: true, json: async () => body })) as any))
          .toEqual({ status: "failed", reason: "GitHub's answer has no release tag" });
    });

    it("fails when the latest release's tag isn't a version", async () => {
      expect(await checkForUpdate("1.0.0", latest("v2.0.0") as any)).toEqual({ status: "failed", reason: `the latest release's tag "v2.0.0" isn't a version` });
    });

    it("fails, without asking GitHub, when its own version can't be compared", async () => {
      let asked = 0;
      const mockFetch = async () => { asked++; return { ok: true, json: async () => ({ tag_name: "cs2clean-v9.9.9" }) }; };
      expect(await checkForUpdate("1.0", mockFetch as any)).toEqual({ status: "failed", reason: `this app's version "1.0" isn't one it can compare` });
      expect(asked).toBe(0);
    });
  });
});
