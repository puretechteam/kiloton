// Pure-function unit tests. No server / pty / browser — these import the lib
// modules directly and exercise the deterministic helpers so they can run in
// any environment (CI, headless) without spawning Kilo.
//
// Run:  node test/unit.mjs   (or: npm run test:unit)

import fs from "fs";
import os from "os";
import path from "path";

import { cleanDir } from "../lib/dir.js";
import { buildArgs, getKiloBin, getKiloVersion, resetKiloBinCache } from "../lib/spawn.js";
import { normalize } from "../lib/sessions.js";
import { validateConfig } from "../lib/validate.js";

let failures = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${msg}`);
  else { console.log(`  FAIL  ${msg} (got ${a}, expected ${e})`); failures++; }
}
function ok(cond, msg) {
  if (cond) console.log(`  PASS  ${msg}`);
  else { console.log(`  FAIL  ${msg}`); failures++; }
}

const cwd = process.cwd();

console.log("== cleanDir (dir.js) ==");
eq(cleanDir('"C:\\foo bar"'), "C:\\foo bar", "strips surrounding double quotes");
eq(cleanDir("'C:\\foo'"), "C:\\foo", "strips surrounding single quotes");
eq(cleanDir('  "nested"  '), "nested", "trims then strips a quoted value");
eq(cleanDir('""'), "", "double-quote pair collapses to empty");
eq(cleanDir(""), "", "empty input -> empty");
eq(cleanDir(null), "", "null -> empty");
eq(cleanDir("C:\\noquotes"), "C:\\noquotes", "leaves an unquoted path untouched");

console.log("== buildArgs (spawn.js) ==");
eq(buildArgs({ mode: "interactive", dir: cwd }), [cwd], "interactive passes an existing dir positionally");
eq(buildArgs({ mode: "interactive", dir: "/no/such/dir" }), [], "interactive drops a non-existent dir");
eq(buildArgs({ mode: "resume", sessionId: "ses_1" }), ["-s", "ses_1", "--replay"], "resume adds -s + --replay");
eq(buildArgs({ mode: "resume" }), [], "resume with no session id is empty");
eq(buildArgs({ mode: "task", task: "do it", auto: true, dir: cwd }),
  ["run", "do it", "-i", "--auto", "--dir", cwd],
  "task adds run/prompt/-i/--auto/--dir");
eq(buildArgs({ mode: "task", task: "", auto: false }), ["run", "-i"], "task tolerates an empty prompt");
eq(buildArgs({ mode: "task", task: "do it", auto: undefined }), ["run", "do it", "-i"], "task omits --auto when auto is undefined");
eq(buildArgs({ mode: "interactive", auto: false }), [], "interactive + auto:false excludes --auto");
eq(buildArgs({ mode: "interactive", auto: true }), [], "interactive mode never passes --auto (auto-approve only applies to task mode)");
eq(buildArgs({ mode: "resume", sessionId: "ses_1", auto: true }), ["-s", "ses_1", "--replay"], "resume never passes --auto even when auto is true");
eq(buildArgs({ mode: "interactive", model: "m1", agent: "a1" }),
  ["-m", "m1", "--agent", "a1"],
  "model/agent map to -m/--agent");

console.log("== normalize (sessions.js) ==");
eq(normalize({ id: "ses_1", title: "T" }), { id: "ses_1", title: "T", updated: "" }, "normalizes a flat JSON session");
eq(normalize({ session: { id: "ses_2" }, summary: "S" }), { id: "ses_2", title: "S", updated: "" }, "normalizes a nested session id");
ok(normalize({ title: "no id" }) === null, "drops a session with no id");

console.log("== validateConfig (validate.js) ==");
ok(validateConfig(null) === "dashboards must be an array", "null body -> error");
ok(validateConfig({ dashboards: "x" }) === "dashboards must be an array", "non-array dashboards -> error");
ok(validateConfig({ dashboards: [{ id: "d1" }] }) === "each dashboard needs id/name/rows/cols/panes", "missing dashboard fields -> error");
ok(validateConfig({ dashboards: [{ id: "d1", name: "n", rows: 1, cols: 1, panes: [] }] }) === null, "valid config -> null");
ok(typeof validateConfig({
  dashboards: [
    { id: "d1", name: "n", rows: 1, cols: 1, panes: [{ id: "a" }, { id: "a" }] },
  ],
}) === "string", "duplicate pane ids -> error");
ok(typeof validateConfig({
  dashboards: [
    { id: "d1", name: "n", rows: 1, cols: 1, panes: [{ name: "no id" }] },
  ],
}) === "string", "pane missing id -> error");

// getKiloBin / getKiloVersion: exercise the bin-resolution + version-parsing
// paths WITHOUT spawning the kilo CLI. We point KILO_BIN_PATH at a fake
// `@kilocode/cli` tree carrying a known version and assert the resolved bin and
// parsed version. The temp tree is cleaned up afterwards.
console.log("== getKiloBin / getKiloVersion (spawn.js) ==");
// Build the fake tree with forward slashes so the `@kilocode/cli` substring the
// real code looks for survives on Windows (where path.join uses backslashes).
const base = fs.mkdtempSync(path.join(os.tmpdir(), "kiloton-unit-")).replace(/\\/g, "/");
const fakeCliDir = `${base}/@kilocode/cli`;
fs.mkdirSync(`${fakeCliDir}/bin`, { recursive: true });
fs.writeFileSync(`${fakeCliDir}/bin/kilo`, "");
fs.writeFileSync(`${fakeCliDir}/package.json`, JSON.stringify({ name: "@kilocode/cli", version: "9.9.9" }));
const fakeBin = `${fakeCliDir}/bin/kilo`;

const savedBinPath = process.env.KILO_BIN_PATH;
try {
  resetKiloBinCache();
  process.env.KILO_BIN_PATH = fakeBin;
  eq(getKiloBin(), fakeBin, "resolveKiloBin returns KILO_BIN_PATH when it exists (env branch)");
  eq(getKiloVersion(), "9.9.9", "getKiloVersion parses version from the bin's package.json");

  // An explicit KILO_BIN_PATH is honored as-is (even when missing) so a bad
  // operator-supplied binary surfaces as a spawn error (D3) rather than
  // silently falling back to a real kilo.
  resetKiloBinCache();
  process.env.KILO_BIN_PATH = `${base}/nope`;
  ok(getKiloBin() === process.env.KILO_BIN_PATH, "resolveKiloBin honors an explicit (even non-existent) KILO_BIN_PATH");
} finally {
  process.env.KILO_BIN_PATH = savedBinPath;
  resetKiloBinCache();
  fs.rmSync(base, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL UNIT TESTS PASSED" : `\n${failures} UNIT TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
