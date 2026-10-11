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

describe("checkForUpdate", () => {
  it("returns null when fetch fails", async () => {
    const mockFetch = async (_url: string, _opts?: unknown) => { throw new Error("network"); };
    const result = await checkForUpdate("1.0.0", mockFetch as any);
    expect(result).toBeNull();
  });

  it("returns null when API returns non-200", async () => {
    const mockFetch = async () => ({ ok: false, status: 404 });
    const result = await checkForUpdate("1.0.0", mockFetch as any);
    expect(result).toBeNull();
  });

  it("returns null when remote version is older", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ tag_name: "cs2clean-v0.9.0" }),
    });
    const result = await checkForUpdate("1.0.0", mockFetch as any);
    expect(result).toBeNull();
  });

  it("returns null when versions are equal", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ tag_name: "cs2clean-v1.0.0" }),
    });
    const result = await checkForUpdate("1.0.0", mockFetch as any);
    expect(result).toBeNull();
  });

  it("returns result when remote version is newer", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ tag_name: "cs2clean-v1.1.0" }),
    });
    const result = await checkForUpdate("1.0.0", mockFetch as any);
    expect(result).toEqual({ available: true, remoteVersion: "1.1.0" });
  });

  it("returns result when only patch version differs", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ tag_name: "cs2clean-v1.0.1" }),
    });
    const result = await checkForUpdate("1.0.0", mockFetch as any);
    expect(result).toEqual({ available: true, remoteVersion: "1.0.1" });
  });

  it("returns result when major version differs", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ tag_name: "cs2clean-v2.0.0" }),
    });
    const result = await checkForUpdate("1.0.0", mockFetch as any);
    expect(result).toEqual({ available: true, remoteVersion: "2.0.0" });
  });
});
