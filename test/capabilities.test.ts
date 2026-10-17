import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CEF_FLAG_FILE, cefHint, debugPortFromArgs, describeCapabilities, detectCef, detectConsoleLog, findCs2ConsoleLog,
  scanSteamProcesses, systemConsoleLog, type CefIo, type CefState, type SteamProcesses,
} from "../src/main/steam/capabilities";

// Steam's web helper command line, as read from /proc on Linux Mint (shortened: the parts that matter).
const HELPER = ["./steamwebhelper", "-nocrashdialog", "-lang=en_US", "-uimode=7", "--valve-enable-site-isolation", "--enable-smooth-scrolling", "--password-store=basic"];
const WITH_PORT = [...HELPER.slice(0, 5), "--remote-allow-origins=*", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=8080", ...HELPER.slice(5)];

describe("the debug port in Steam's command line", () => {
  it("reads the port, and only a real one", () => {
    expect(debugPortFromArgs(WITH_PORT)).toBe(8080);
    expect(debugPortFromArgs(["--remote-debugging-port=9222"])).toBe(9222);
    expect(debugPortFromArgs(HELPER)).toBeNull();
    expect(debugPortFromArgs(["--remote-debugging-address=127.0.0.1"])).toBeNull();
    for (const bad of ["--remote-debugging-port=0", "--remote-debugging-port=99999", "--remote-debugging-port=", "--remote-debugging-port=80a"])
      expect(debugPortFromArgs([bad]), bad).toBeNull();
  });
});

describe("looking for Steam in /proc", () => {
  let proc: string;
  beforeEach(() => { proc = mkdtempSync(join(tmpdir(), "cs2clean-proc-")); });
  afterEach(() => rmSync(proc, { recursive: true, force: true }));

  const add = (pid: string, args: string[] | null) => {
    mkdirSync(join(proc, pid));
    if (args) writeFileSync(join(proc, pid, "cmdline"), args.join("\0") + "\0");
  };

  it("finds the helper and its port", () => {
    add("100", ["/usr/bin/bash"]);
    add("200", WITH_PORT);
    add("300", ["./steamwebhelper", "--type=renderer"]); // Steam's other helper processes don't carry the flag
    mkdirSync(join(proc, "self"));
    add("400", null);                                     // a process we can't read
    expect(scanSteamProcesses(proc)).toEqual({ steamRunning: true, debugPort: 8080 });
  });

  it("sees Steam running without the flag, and Steam not running", () => {
    add("200", HELPER);
    expect(scanSteamProcesses(proc)).toEqual({ steamRunning: true, debugPort: null });
    rmSync(join(proc, "200"), { recursive: true });
    add("201", ["/usr/bin/steam-runtime-launcher-service"]);
    expect(scanSteamProcesses(proc)).toEqual({ steamRunning: false, debugPort: null });
  });

  it("is null where there is no /proc", () => {
    expect(scanSteamProcesses(join(proc, "nope"))).toBeNull();
  });
});

describe("what the debug port allows", () => {
  function io(o: { reachable?: boolean; friendsWindow?: boolean; procs?: SteamProcesses | null; flagFile?: boolean; envPort?: number | null } = {}) {
    const probed: number[] = [];
    const c: CefIo = {
      probe: async (port) => (probed.push(port), { reachable: o.reachable ?? false, friendsWindow: o.friendsWindow ?? false }),
      processes: () => (o.procs === undefined ? null : o.procs),
      flagFile: () => o.flagFile ?? false,
      envPort: o.envPort,
    };
    return { c, probed };
  }
  const running = (debugPort: number | null): SteamProcesses => ({ steamRunning: true, debugPort });

  it("is reachable when the port answers, and says whether the friends window is open", async () => {
    expect(await detectCef(io({ reachable: true, friendsWindow: true, procs: running(8080) }).c)).toEqual({ state: "reachable", port: 8080, friendsWindow: true });
    expect(await detectCef(io({ reachable: true, friendsWindow: false }).c)).toMatchObject({ state: "reachable", friendsWindow: false });
  });

  it("explains a closed port on Linux", async () => {
    const state = async (o: Parameters<typeof io>[0]): Promise<CefState> => (await detectCef(io(o).c)).state;
    expect(await state({ procs: { steamRunning: false, debugPort: null } })).toBe("steam-not-running");
    expect(await state({ procs: running(null), flagFile: false })).toBe("off");
    expect(await state({ procs: running(null), flagFile: true })).toBe("restart-steam");
    expect(await state({ procs: running(8080) })).toBe("unknown");   // asks for a port that doesn't answer
  });

  it("can't explain a closed port where Steam's command line isn't readable", async () => {
    expect(await detectCef(io({ procs: null, flagFile: true }).c)).toMatchObject({ state: "unknown", friendsWindow: null });
  });

  it("probes the port from Steam's command line first, then the environment's, then 8080", async () => {
    const a = io({ procs: running(9222), envPort: 7000 }); await detectCef(a.c);
    const b = io({ procs: running(null), envPort: 7000 }); await detectCef(b.c);
    const c = io({ procs: null }); await detectCef(c.c);
    expect([a.probed, b.probed, c.probed]).toEqual([[9222], [7000], [8080]]);
  });
});

describe("CS2's console.log", () => {
  it("is found next to CS2's cfg folder", () => {
    expect(findCs2ConsoleLog(join("lib", "game", "csgo", "cfg"))).toBe(join("lib", "game", "csgo", "console.log"));
    expect(findCs2ConsoleLog(null)).toBeNull();
  });

  it("is active only when written to since this CS2 session began", () => {
    const path = "/x/console.log";
    expect(detectConsoleLog({ path: null, mtimeMs: null, sessionStartMs: 1 })).toEqual({ state: "not-found", path: null });
    expect(detectConsoleLog({ path, mtimeMs: null, sessionStartMs: 1 })).toEqual({ state: "missing", path });
    expect(detectConsoleLog({ path, mtimeMs: 1000, sessionStartMs: 2000 })).toEqual({ state: "inactive", path });
    expect(detectConsoleLog({ path, mtimeMs: 2000, sessionStartMs: 2000 })).toEqual({ state: "active", path });
    expect(detectConsoleLog({ path, mtimeMs: 3000, sessionStartMs: 2000 })).toEqual({ state: "active", path });
    expect(detectConsoleLog({ path, mtimeMs: 3000, sessionStartMs: null })).toEqual({ state: "inactive", path }); // CS2 isn't running
  });

  it("is read from the real file's modification time", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs2clean-log-"));
    try {
      const path = join(dir, "console.log");
      expect(systemConsoleLog(1000, path).state).toBe("missing");
      writeFileSync(path, "x");
      utimesSync(path, new Date(5_000_000), new Date(5_000_000));
      expect(systemConsoleLog(4_000_000, path).state).toBe("active");
      expect(systemConsoleLog(6_000_000, path).state).toBe("inactive");
      expect(systemConsoleLog(1000, null).state).toBe("not-found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("wording", () => {
  const cef = (state: CefState, friendsWindow: boolean | null = null) => ({ state, port: 8080, friendsWindow });

  it("has a line for each reason the friends list can't be read, and none when it can", () => {
    expect(cefHint(cef("off"), true)).toContain(CEF_FLAG_FILE);
    expect(cefHint(cef("restart-steam"), true)).toMatch(/Quit Steam/);
    expect(cefHint(cef("steam-not-running"), true)).toMatch(/isn't running/);
    expect(cefHint(cef("unknown"), true)).toContain("127.0.0.1:8080");
    expect(cefHint(cef("reachable", true), false)).toBeNull();
  });

  it("only asks the user to open the window when the app won't", () => {
    expect(cefHint(cef("reachable", false), true)).toBeNull();
    expect(cefHint(cef("reachable", false), false)).toMatch(/friends list window is closed/);
  });

  it("lists both capabilities for the diagnostics", () => {
    const lines = describeCapabilities(cef("reachable", false), { state: "missing", path: "/s/console.log" }, true);
    expect(lines[0]).toMatch(/reachable, friends list window closed/);
    expect(lines.join("\n")).toContain("/s/console.log): missing");
    expect(lines.join("\n")).toContain("-condebug");
  });
});
