// Builds and checks the Hero sidecar, hero-runtime/ (see src/main/leetify-hero.ts for why it exists).
//
//   node tools/build-hero-runtime.mjs            bundle src/main/leetify-hero-cli.ts into hero-runtime/cli.js
//                                                (part of `npm run build`)
//   node tools/build-hero-runtime.mjs install    npm ci in hero-runtime with Node 22, copy that Node to
//                                                hero-runtime/bin/, bundle cli.js and check the result
//                                                (`npm run hero:install`; CI runs it before packaging)
//   node tools/build-hero-runtime.mjs check [dir]
//                                                run the sidecar's selftest with its own Node, e.g. against the
//                                                packaged copy: release/linux-unpacked/resources/hero
//                                                (`npm run hero:check`)
//
// Packaging: package.json's build.extraResources has two entries for this folder, on purpose. electron-builder drops a
// root-level node_modules from any extraResources source, so hero-runtime/node_modules is copied by an entry of its own
// (docs/DESIGN.md, "Hero sidecar"). `check` on the packaged copy is what notices if that ever stops working.
//
// Which Node 22: the one running this script when it is Node 22 (CI), else CS2CLEAN_NODE22, else the newest nvm
// v22. The sidecar's native modules (better-sqlite3) are installed by that Node and run by a copy of it, so
// they always match.

import { spawnSync } from "node:child_process";
import { copyFileSync, chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const heroDir = join(root, "hero-runtime");
const win = process.platform === "win32";
const nodeName = win ? "node.exe" : "node";

function die(msg) {
  console.error(`hero-runtime: ${msg}`);
  process.exit(1);
}

async function bundle() {
  await build({
    entryPoints: [join(root, "src/main/leetify-hero-cli.ts")],
    outfile: join(heroDir, "cli.js"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    logLevel: "warning",
    // Hero and its Chrome packages are loaded from hero-runtime/node_modules at run time (createRequire in the CLI).
  });
  console.log("hero-runtime: cli.js built");
}

/** The newest v22.x node binary under an nvm-style folder, or null. */
function newestV22(dir, rel) {
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir)
    .filter((v) => v.startsWith("v22."))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .reverse();
  for (const v of versions) {
    const bin = join(dir, v, ...rel);
    if (existsSync(bin)) return bin;
  }
  return null;
}

function findNode22() {
  if (process.versions.node.startsWith("22.")) return process.execPath;
  const forced = process.env.CS2CLEAN_NODE22;
  if (forced) return existsSync(forced) ? forced : die(`CS2CLEAN_NODE22 points at a file that doesn't exist: ${forced}`);
  const found = win
    ? process.env.NVM_HOME && newestV22(process.env.NVM_HOME, ["node.exe"])
    : newestV22(join(process.env.NVM_DIR || join(homedir(), ".nvm"), "versions", "node"), ["bin", "node"]);
  return found || die(`needs Node 22 (this is ${process.version}). Install it (nvm install 22) or set CS2CLEAN_NODE22 to its node binary.`);
}

/** npm's own script for that Node, so the install runs under it and not under whatever `npm` is on PATH. */
function npmCli(node) {
  const base = dirname(node);
  return [join(base, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), join(base, "node_modules", "npm", "bin", "npm-cli.js")]
    .find(existsSync);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.error) die(`couldn't run ${cmd}: ${r.error.message}`);
  if (r.status !== 0) die(`${cmd} ${args.join(" ")} failed (exit ${r.status ?? r.signal})`);
}

/** Runs the selftest and prints the one JSON line it answers with; fails unless it says ok. */
function selftest(dir) {
  const node = join(dir, "bin", nodeName);
  const cli = join(dir, "cli.js");
  if (!existsSync(node)) die(`no Node in the sidecar: ${node}`);
  if (!existsSync(cli)) die(`no cli.js in the sidecar: ${cli} (run npm run build)`);
  const r = spawnSync(node, [cli, "selftest"], { encoding: "utf8", cwd: dir, timeout: 120_000 });
  if (r.error) die(`couldn't start ${node}: ${r.error.message}`);
  const line = r.stdout.split(/\r?\n/).filter((l) => l.trim().startsWith("{")).pop();
  let res = null;
  try { res = line ? JSON.parse(line) : null; } catch { /* handled below */ }
  if (r.status !== 0 || !res || res.ok !== true) {
    die(`selftest FAILED in ${dir}\n  ${line ?? "(no result line)"}\n${(r.stderr || "").trim().split("\n").slice(-8).map((l) => "  " + l).join("\n")}`);
  }
  console.log(`hero-runtime: selftest ok in ${dir}`);
  console.log(`  node ${res.node} (ABI ${res.abi}), better-sqlite3 opens a database (SQLite ${res.sqlite}), Chrome: ${res.browser}`);
}

const [mode = "bundle", arg] = process.argv.slice(2);

if (mode === "bundle") {
  await bundle();
} else if (mode === "install") {
  const node = findNode22();
  console.log(`hero-runtime: installing with ${node}`);
  const npm = npmCli(node);
  const env = {
    ...process.env,
    PATH: `${dirname(node)}${delimiter}${process.env.PATH ?? ""}`,
    // Chrome is not part of the install: the app downloads it into its data folder on first use.
    HERO_SKIP_CHROME_DOWNLOAD: "1",
  };
  if (npm) run(node, [npm, "ci", "--no-audit", "--no-fund"], { cwd: heroDir, env });
  else run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: heroDir, env, shell: win });
  mkdirSync(join(heroDir, "bin"), { recursive: true });
  const dest = join(heroDir, "bin", nodeName);
  copyFileSync(node, dest);
  chmodSync(dest, 0o755);
  await bundle();
  selftest(heroDir);
} else if (mode === "check") {
  selftest(arg ? resolve(arg) : heroDir);
} else {
  die(`unknown mode "${mode}" (bundle, install or check)`);
}
