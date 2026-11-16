// Checks that the csst.at fallback's network library, wreq-js, works in a PACKAGED app: the app's own Electron
// binary, running as plain Node (ELECTRON_RUN_AS_NODE), loads wreq-js from inside app.asar (its native library from
// app.asar.unpacked) and makes a request to a throwaway local server. That covers what a unit test can't: the
// asarUnpack entries in package.json, the platform's native library being in the package, and Electron's own ABI.
//
//   node tools/check-wreq.mjs [resources-dir]
//   npm run check:wreq -- release/linux-unpacked/resources
//   npm run check:wreq -- release/win-unpacked/resources
//
// With no argument it takes the unpacked build of the current platform.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const win = process.platform === "win32";
const resources = resolve(process.argv[2] ?? (win ? "release/win-unpacked/resources" : "release/linux-unpacked/resources"));

function die(msg) {
  console.error(`check-wreq: ${msg}`);
  process.exit(1);
}

if (!existsSync(join(resources, "app.asar"))) die(`no app.asar in ${resources} (build one first: npm run check:package)`);

// The app's executable sits next to the resources folder: CS2Clean.exe on Windows, CS2Clean or cs2clean on Linux.
const appDir = dirname(resources);
const names = win ? ["CS2Clean.exe"] : ["CS2Clean", "cs2clean"];
const exe = names.map((n) => join(appDir, n)).find((f) => existsSync(f));
if (!exe) die(`no ${names.join(" or ")} in ${appDir} (found: ${readdirSync(appDir).join(", ")})`);

// What runs inside Electron.
const probe = String.raw`
const http = require("node:http");
const path = require("node:path");
const wreq = require(path.join(process.argv[2], "app.asar", "node_modules", "wreq-js"));
if (!wreq.getProfiles().includes("chrome_142")) throw new Error("the chrome_142 profile is missing");
const server = http.createServer((req, res) => res.end("ok")).listen(0, "127.0.0.1", async () => {
  try {
    const res = await wreq.fetch("http://127.0.0.1:" + server.address().port + "/", { browser: "chrome_142", timeout: 10000 });
    const body = await res.text();
    if (res.status !== 200 || body !== "ok") throw new Error("unexpected answer: " + res.status + " " + body);
    console.log("wreq-js works under Electron " + process.versions.electron + " (Node " + process.versions.node + ", ABI " + process.versions.modules + ")");
    process.exit(0);
  } catch (e) {
    console.error(e && e.stack || String(e));
    process.exit(1);
  }
});
`;

const dir = mkdtempSync(join(tmpdir(), "check-wreq-"));
try {
  const script = join(dir, "probe.js");
  writeFileSync(script, probe);
  const r = spawnSync(exe, [script, resources], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  if (r.error) die(`couldn't start ${exe}: ${r.error.message}`);
  if (r.status !== 0) die(`wreq-js failed in the packaged app (exit ${r.status}):\n${r.stderr || r.stdout}`);
  console.log(`${resources}: ${r.stdout.trim()}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
