// End-to-end tests for Kiloton.
//
// Boots the real server (and, where needed, dedicated servers with their own
// config/env) and exercises the full stack against the real `kilo` CLI via
// node-pty: REST API, the WebSocket TUI bridge, session resume, restart/stop,
// layout persistence, autostart, env passthrough, error handling, and scaling
// from a handful of agents up to 30+.
//
// Runs fully offline (no API keys / network) except that it proves the TUI
// actually renders. Network-dependent behaviour (sending prompts) is left to
// the user; we only assert the agent *process* starts, streams, and stops.
//
// Run:            npm test
// Stress (30+):   npm run test:stress

import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = 7656;
const BASE = `http://localhost:${PORT}`;
// Each `withServer` spins up its own server on an isolated port and swaps this
// in for the duration of its callback, so HTTP requests / lingering
// WebSockets from one test can't bleed into another (which previously
// contaminated probes and attached phantom viewers).
let BASE_URL = BASE;

// Each `withServer` gets its own port, handed out sequentially starting above
// the core suite's port. Servers run sequentially (the previous one is stopped
// before the next starts), so a fresh incrementing port never collides and
// avoids the Windows TIME_WAIT race you get from re-grabbing a just-freed port.
let portSeq = 7657;
function nextPort() { return portSeq++; }

const failures = [];
function check(cond, msg) {
  if (cond) console.log(`  PASS  ${msg}`);
  else { console.log(`  FAIL  ${msg}`); failures.push(msg); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 15000, step = 200) {
  const start = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch {}
    if (Date.now() - start > timeout) return false;
    await sleep(step);
  }
}

async function getJSON(url, token) {
  const u = token ? url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token) : url;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${u} -> ${r.status}`);
  return r.json();
}

async function waitStatus(paneId, want, timeout = 8000, token) {
  return waitFor(async () => {
    const cfg = await getJSON(`${BASE_URL}/api/config`, token);
    const pane = cfg.dashboards.flatMap((d) => d.panes).find((p) => p.id === paneId);
    return pane && pane.status === want;
  }, timeout);
}

function collectPaneBytes(paneId, ms = 8000) {
  return new Promise((resolve) => {
    let bytes = 0;
    const ws = new WebSocket(`${BASE_URL.replace(/^http/, "ws")}/ws/${paneId}`);
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(bytes); }, ms);
    ws.on("open", () => ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 })));
    ws.on("message", (d) => { bytes += d.length; });
    ws.on("close", () => { clearTimeout(timer); resolve(bytes); });
    ws.on("error", () => { clearTimeout(timer); resolve(bytes); });
  });
}

async function startPane(paneId, dashboardId, body) {
  const r = await fetch(`${BASE_URL}/api/instances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dashboardId, paneId, ...body }),
  });
  return r;
}
async function stopPane(paneId) {
  await fetch(`${BASE_URL}/api/instances/${paneId}`, { method: "DELETE" });
}
async function startPaneToken(paneId, dashboardId, body, token) {
  const r = await fetch(`${BASE_URL}/api/instances`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ dashboardId, paneId, ...body }),
  });
  return r;
}

// ---- server lifecycle -------------------------------------------------------

function startServer(cfgPath, extraEnv = {}, port = PORT) {
  const child = spawn("node", ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, KILOTON_PORT: String(port), KILOTON_CONFIG: cfgPath, KILOTON_NO_OPEN: "1", ...extraEnv },
    stdio: "ignore",
  });
  return child;
}
async function waitReady(child) {
  // A token-protected server answers 401 (not 200) on /api/config, but 401
  // still proves the server is up — so treat any non-5xx response as ready.
  const ok = await waitFor(async () => {
    try { const r = await fetch(`${BASE_URL}/api/config`); return r.status < 500; } catch { return false; }
  }, 20000);
  if (!ok) { try { child.kill("SIGTERM"); } catch {} throw new Error("server did not become ready"); }
}
function stopServer(child) {
  try { child.kill("SIGTERM"); } catch {}
}

// ---- config builders --------------------------------------------------------

function pane(id) {
  return { id, mode: "interactive", dir: ROOT, model: null, agent: null, auto: false, sessionId: null, task: null, instanceId: null, status: "stopped", exitCode: null };
}
function defaultCfg(n) {
  return {
    kiloBin: "auto", autostart: false,
    dashboards: [{ id: "d1", name: "Test", rows: 2, cols: 3, panes: Array.from({ length: n }, (_, i) => pane("p" + (i + 1))) }],
  };
}
function multiDashCfg() {
  const mk = (id, n) => ({ id, name: id, rows: 1, cols: n, panes: Array.from({ length: n }, (_, i) => pane(id + (i + 1))) });
  return { kiloBin: "auto", autostart: false, dashboards: [mk("p", 6), mk("q", 6)] };
}

// ---- test scenarios ---------------------------------------------------------

async function bootAndAssets() {
  const cfg = await getJSON(`${BASE_URL}/api/config`);
  check(Array.isArray(cfg.dashboards) && cfg.dashboards.length >= 1, "config has at least one dashboard");
  for (const p of ["/", "/app.js", "/style.css", "/vendor/xterm/lib/xterm.js", "/vendor/xterm/css/xterm.css"]) {
    const r = await fetch(BASE + p);
    check(r.ok, `asset served: ${p} (${r.status})`);
  }
  // The /lib mount was tightened to a single targeted route: only the
  // browser-safe /lib/dir.js helper is exposed (with no-store); the rest of
  // the lib/ tree (incl. lib/server/* internals) must NOT be browsable.
  {
    const r = await fetch(BASE + "/lib/dir.js");
    check(r.status === 200, `/lib/dir.js is served (200) (${r.status})`);
    const cc = r.headers.get("cache-control") || "";
    check(cc.includes("no-store"), `/lib/dir.js sends Cache-Control: no-store (${cc})`);
    const priv = await fetch(BASE + "/lib/server/auth.js");
    check(priv.status === 404, `/lib/server/auth.js is NOT served (404, got ${priv.status})`);
  }
}

async function sessionsList() {
  const s = await getJSON(`${BASE_URL}/api/sessions`);
  check(Array.isArray(s), "sessions endpoint returns an array");
  console.log(`  INFO  ${s.length} session(s) available for resume`);
  return s;
}

async function interactiveLifecycle(paneId) {
  await startPane(paneId, "d1", { mode: "interactive", dir: ROOT });
  check(await waitStatus(paneId, "running"), `${paneId}: interactive reaches 'running'`);
  const bytes = await collectPaneBytes(paneId);
  check(bytes > 100, `${paneId}: TUI streams over WebSocket (${bytes} bytes)`);
  await stopPane(paneId);
  check(await waitStatus(paneId, "stopped"), `${paneId}: interactive stops`);
  const cfg = await getJSON(`${BASE_URL}/api/config`);
  const p = cfg.dashboards.flatMap((d) => d.panes).find((x) => x.id === paneId);
  check(p.instanceId === null, `${paneId}: stopped instance clears instanceId`);
}

async function invalidSessionId(paneId) {
  await startPane(paneId, "d1", { mode: "resume", sessionId: "ses_does_not_exist_xyz" });
  // server must stay healthy; the bad session simply exits
  const healthy = await waitFor(async () => { try { await getJSON(`${BASE_URL}/api/config`); return true; } catch { return false; } }, 5000);
  check(healthy, `${paneId}: server stays healthy with an invalid session id`);
  await stopPane(paneId);
}

async function unknownPane404() {
  const post = await startPane("nope", "d1", { mode: "interactive", dir: ROOT });
  check(post.status === 404, "POST instance for unknown pane -> 404");
  const del = await fetch(`${BASE_URL}/api/instances/nope`, { method: "DELETE" });
  check(del.status === 404, "DELETE unknown instance -> 404");
}

async function wsUnknownCloses() {
  const closed = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/nope`);
    const t = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 3000);
    ws.on("close", () => { clearTimeout(t); resolve(true); });
    ws.on("error", () => { clearTimeout(t); resolve(true); });
  });
  check(closed, "WebSocket to unknown pane is closed by server (no hang)");
}

async function resumeById(paneId) {
  const s = await getJSON(`${BASE_URL}/api/sessions`);
  if (!s.length) { console.log("  SKIP  resume test (no sessions)"); return; }
  await startPane(paneId, "d1", { mode: "resume", sessionId: s[0].id });
  check(await waitStatus(paneId, "running"), `${paneId}: resume reaches 'running'`);
  const bytes = await collectPaneBytes(paneId);
  check(bytes > 100, `${paneId}: resumed session streams over WebSocket (${bytes} bytes)`);
  await stopPane(paneId);
  check(await waitStatus(paneId, "stopped"), `${paneId}: resume stops`);
}

async function taskMode(paneId) {
  await startPane(paneId, "d1", { mode: "task", task: "say hi", auto: true, dir: ROOT });
  check(await waitStatus(paneId, "running"), `${paneId}: task instance reaches 'running'`);
  const bytes = await collectPaneBytes(paneId);
  check(bytes > 100, `${paneId}: task TUI streams over WebSocket (${bytes} bytes)`);
  await stopPane(paneId);
  check(await waitStatus(paneId, "stopped"), `${paneId}: task stops`);
}

async function invalidDirFallback(paneId) {
  await startPane(paneId, "d1", { mode: "interactive", dir: "/no/such/dir/here" });
  check(await waitStatus(paneId, "running"), `${paneId}: invalid dir falls back to cwd (still runs)`);
  await stopPane(paneId);
}

async function layoutPersistence() {
  const before = await getJSON(`${BASE_URL}/api/config`);
  const newRows = before.dashboards[0].rows === 1 ? 2 : 1;
  before.dashboards[0].rows = newRows;
  await fetch(`${BASE_URL}/api/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(before) });
  const after = await getJSON(`${BASE_URL}/api/config`);
  check(after.dashboards[0].rows === newRows, "layout change persisted via POST /api/config");
}

async function restartKeepsAlive(paneId) {
  await startPane(paneId, "d1", { mode: "interactive", dir: ROOT });
  check(await waitStatus(paneId, "running"), `${paneId}: restart test starts`);
  await fetch(`${BASE_URL}/api/instances/${paneId}/restart`, { method: "POST" });
  check(await waitStatus(paneId, "running"), `${paneId}: still running after restart`);
  await stopPane(paneId);
}

async function multipleDashboards() {
  await startPane("p1", "p", { mode: "interactive", dir: ROOT });
  await startPane("q1", "q", { mode: "interactive", dir: ROOT });
  check(await waitStatus("p1", "running"), "dashboard 'p' pane runs");
  check(await waitStatus("q1", "running"), "dashboard 'q' pane runs");
  const b1 = await collectPaneBytes("p1");
  const b2 = await collectPaneBytes("q1");
  check(b1 > 100 && b2 > 100, `both dashboards stream TUI (p1=${b1}, q1=${b2})`);
  await stopPane("p1");
  await stopPane("q1");
}

async function manyAgents(n) {
  console.log(`  INFO  starting ${n} agents concurrently...`);
  for (let i = 1; i <= n; i++) await startPane("p" + i, "d1", { mode: "interactive", dir: ROOT });
  let running = 0;
  for (let i = 1; i <= n; i++) if (await waitStatus("p" + i, "running", 12000)) running++;
  check(running === n, `all ${n} agents reached 'running' (${running}/${n})`);
  // sample a few terminals to confirm they actually render
  let streamed = 0;
  for (const id of ["p1", "p" + Math.ceil(n / 2), "p" + n]) {
    const b = await collectPaneBytes(id, 12000);
    if (b > 100) streamed++;
  }
  check(streamed === 3, `sampled terminals stream TUI (${streamed}/3)`);
  for (let i = 1; i <= n; i++) await stopPane("p" + i);
  let stopped = 0;
  for (let i = 1; i <= n; i++) if (await waitStatus("p" + i, "stopped", 8000)) stopped++;
  check(stopped === n, `all ${n} agents stopped cleanly (${stopped}/${n})`);
}

async function autostart() {
  // config says autostart:true with a pane that already has an instanceId set
  const cfg = defaultCfg(1);
  cfg.autostart = true;
  cfg.dashboards[0].panes[0].instanceId = "p1";
  cfg.dashboards[0].panes[0].dir = ROOT;
  return cfg;
}

async function envPassthrough(tmpDir) {
  const fakeBin = path.join(tmpDir, "fake-kilo.cjs");
  const probe = path.join(tmpDir, "envprobe.json");
  writeFileSync(fakeBin,
    `const fs=require('fs');` +
    `try{const p=process.env.KILO_E2E_ENVPROBE;if(p)fs.writeFileSync(p, JSON.stringify({port:process.env.KILOTON_PORT||null, probe:process.env.KILO_E2E_ENVPROBE||null, provider:process.env.ANTHROPIC_API_KEY||null}));}catch(e){}` +
    `process.exit(0);\n`);
  return { fakeBin, probe };
}

async function modelAgentPassthrough(tmpDir) {
  const fakeBin = path.join(tmpDir, "fake-kilo-argv.cjs");
  const probe = path.join(tmpDir, "argvprobe.json");
  writeFileSync(fakeBin,
    `const fs=require('fs');` +
    `try{const p=process.env.KILO_E2E_ARGVPROBE;if(p)fs.writeFileSync(p, JSON.stringify(process.argv.slice(2)));}catch(e){}` +
    `process.exit(0);\n`);
  return { fakeBin, probe };
}

async function malformedConfig400(tmpDir) {
  await withServer(tmpDir, defaultCfg(1), {}, async () => {
    const r = await fetch(`${BASE_URL}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dashboards: "not-an-array" }),
    });
    check(r.status === 400, "POST /api/config with non-array dashboards -> 400 (B1)");
  });
}

// ---- D1: quoted (Windows "Copy as path") directory ----
// A fake bin that records its working directory so we can prove a quoted dir
// resolves to the unquoted path (mirrors the cleanDir fix on the server).
async function quotedPathCwd(tmpDir) {
  const fakeBin = path.join(tmpDir, "fake-kilo-cwd.cjs");
  const probe = path.join(tmpDir, "cwdprobe.json");
  writeFileSync(fakeBin,
    `const fs=require('fs');` +
    `try{const p=process.env.KILO_E2E_CWDPROBE;if(p)fs.writeFileSync(p, JSON.stringify({cwd:process.cwd()}));}catch(e){}` +
    `process.exit(0);\n`);
  const quoted = `"${ROOT}"`;
  await withServer(tmpDir, defaultCfg(1), { KILO_BIN_PATH: fakeBin, KILO_E2E_CWDPROBE: probe }, async () => {
    const r = await startPane("p1", "d1", { mode: "interactive", dir: quoted });
    check(r.ok, "start with quoted dir accepted");
    const wrote = await waitFor(() => existsSync(probe), 8000);
    check(wrote, "fake bin ran from the quoted dir (cwd probe written)");
    if (wrote) {
      const info = JSON.parse(readFileSync(probe, "utf8"));
      check(info.cwd === ROOT, `quoted dir resolves to the same path (cwd=${info.cwd})`);
    }
    await stopPane("p1");
  });
}

// ---- D2: instance-cleanup on exit (A3) ----
// A fake bin that exits immediately. With no WebSocket viewing it, the server
// must reap the Map entry on exit while still persisting the pane's status /
// exit code so the client keeps showing the result.
async function instanceCleanup(tmpDir) {
  const fakeBin = path.join(tmpDir, "fake-kilo-exit.cjs");
  writeFileSync(fakeBin, `process.exit(0);\n`);
  await withServer(tmpDir, defaultCfg(1), { KILO_BIN_PATH: fakeBin }, async () => {
    const r = await startPane("p1", "d1", { mode: "interactive", dir: ROOT });
    check(r.ok, "start (fake bin) accepted");
    const exited = await waitStatus("p1", "exited", 8000);
    check(exited, "pane reaches 'exited' with the fake bin");
    const insts = await getJSON(`${BASE_URL}/api/instances`);
    check(Array.isArray(insts) && insts.length === 0, "GET /api/instances shrinks to 0 after exit (A3)");
    const cfg = await getJSON(`${BASE_URL}/api/config`);
    const p = cfg.dashboards.flatMap((d) => d.panes).find((x) => x.id === "p1");
    check(p.status === "exited", "pane status persists as 'exited'");
    check(p.exitCode === 0, "pane exitCode persists as 0");
    check(p.instanceId != null, "pane instanceId retained (client keeps showing exit code)");
  });
}

// ---- D3: failed spawn surfaces an `error` status + reason (not silent exit) ----
// Point KILO_BIN_PATH at a NON-EXISTENT binary so spawnKilo throws. The server
// must catch that, mark the pane `status:"error"` with a non-empty `error`
// string, and stay healthy (GET /api/config still 200).
async function failPaneError(tmpDir) {
  // A *relative* missing bin name is passed straight to pty.spawn as the
  // command (binIsPath() is false), so the missing executable throws
  // synchronously and the server marks the pane `error` via failPane(). (An
  // absolute missing path would instead run `node <missing>` which just exits
  // 1 and surfaces as `exited`.)
  const fakeBin = "kiloton-missing-kilo-bin-xyz";
  await withServer(tmpDir, defaultCfg(1), { KILO_BIN_PATH: fakeBin }, async () => {
    const r = await startPane("p1", "d1", { mode: "interactive", dir: ROOT });
    // The spawn throws, so the POST itself 500s; that's expected. The important
    // part is the persisted pane state below.
    check(r.status === 500, "start with missing KILO_BIN_PATH -> 500 (spawn failed)");
    const errored = await waitStatus("p1", "error", 5000);
    check(errored, "pane reaches status:'error' on a failed spawn (D3)");
    const cfg = await getJSON(`${BASE_URL}/api/config`);
    const p = cfg.dashboards.flatMap((d) => d.panes).find((x) => x.id === "p1");
    check(typeof p.error === "string" && p.error.length > 0, `error carries a reason: ${p.error}`);
    // server still healthy
    const again = await getJSON(`${BASE_URL}/api/config`);
    check(Array.isArray(again.dashboards) && again.dashboards.length >= 1, "GET /api/config still works (server healthy)");
  });
}

// ---- D4: normalizeStartInput 400s for malformed instance bodies ----
async function normalizeStartInput400(tmpDir) {
  await withServer(tmpDir, defaultCfg(1), {}, async () => {
    const cases = [
      { name: "task mode with empty task", body: { mode: "task", task: "" } },
      { name: "rows: 0", body: { rows: 0 } },
      { name: "cols: 9999 (out of range)", body: { cols: 9999 } },
      { name: "invalid mode 'bogus'", body: { mode: "bogus" } },
    ];
    for (const c of cases) {
      const r = await fetch(`${BASE_URL}/api/instances`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(c.body),
      });
      check(r.status === 400, `POST /api/instances ${c.name} -> 400 (D4)`);
    }
  });
}

// ---- D5: stop flushes instanceId to disk synchronously ----
// D1: config + instances stay consistent. Start a couple of panes, stop one,
// assert the stopped pane's instanceId is cleared in the ON-DISK config file
// immediately (not lost in the 150ms debounce), and that /api/config and
// /api/instances agree.
async function configIndexAndSyncFlush(tmpDir) {
  await withServer(tmpDir, defaultCfg(2), {}, async (cfgPath) => {
    await startPane("p1", "d1", { mode: "interactive", dir: ROOT });
    await startPane("p2", "d1", { mode: "interactive", dir: ROOT });
    check(await waitStatus("p1", "running", 12000), "p1 running");
    check(await waitStatus("p2", "running", 12000), "p2 running");

    await stopPane("p1");
    check(await waitStatus("p1", "stopped", 8000), "p1 stopped");

    // Read the on-disk file immediately (no wait) — stop must sync-flush.
    const disk = JSON.parse(readFileSync(cfgPath, "utf8"));
    const dp1 = disk.dashboards.flatMap((d) => d.panes).find((x) => x.id === "p1");
    const dp2 = disk.dashboards.flatMap((d) => d.panes).find((x) => x.id === "p2");
    check(dp1.instanceId === null, "on-disk config: stopped pane instanceId cleared synchronously (D5)");
    check(dp2.instanceId !== null, "on-disk config: running pane keeps its instanceId");

    // D1: consistency between /api/config and /api/instances
    const cfg = await getJSON(`${BASE_URL}/api/config`);
    const insts = await getJSON(`${BASE_URL}/api/instances`);
    const liveIds = new Set(cfg.dashboards.flatMap((d) => d.panes).filter((p) => p.instanceId != null).map((p) => p.id));
    const instIds = new Set(insts.map((i) => i.paneId));
    let consistent = true;
    for (const id of liveIds) if (!instIds.has(id)) consistent = false;
    for (const id of instIds) if (!liveIds.has(id)) consistent = false;
    check(consistent, "D1: /api/config panes with instanceId match /api/instances exactly");

    await stopPane("p2");
    check(await waitStatus("p2", "stopped", 8000), "p2 stopped");
  });
}

// ---- D6: KILOTON_TOKEN auth on REST + WebSocket ----
async function tokenAuth(tmpDir) {
  const bin = path.join(tmpDir, "fake-alive.cjs");
  writeFileSync(bin, `setTimeout(()=>process.exit(0), 60000);\n`);

  // 1) REST endpoints require the token.
  const noTok = await fetch(`${BASE_URL}/api/health`);
  check(noTok.status === 401, "GET /api/health without token -> 401 (D6)");

  const withQuery = await fetch(`${BASE_URL}/api/health?token=test-token`);
  check(withQuery.status === 200, "GET /api/health?token=... -> 200 (D6)");
  if (withQuery.ok) {
    const h = await withQuery.json();
    check(h && h.ok === true, "GET /api/health?token=... returns ok:true (D6)");
  }

  const withHeader = await fetch(`${BASE_URL}/api/health`, { headers: { Authorization: "Bearer test-token" } });
  check(withHeader.status === 200, "GET /api/health with Authorization: Bearer -> 200 (D6)");

  const wrong = await fetch(`${BASE_URL}/api/health?token=wrong`);
  check(wrong.status === 401, "GET /api/health?token=wrong -> 401 (D6)");

  // 3) S1 cookie flow: a valid ?token= on a top-level navigation sets a
  // same-origin HttpOnly Lax cookie so the browser auto-attaches it.
  const rootWithToken = await fetch(`${BASE_URL}/?token=test-token`, { redirect: "manual" });
  const sc = rootWithToken.headers.get("set-cookie");
  check(
    rootWithToken.status === 200 &&
      !!sc &&
      /kiloton_token=/.test(sc) &&
      /HttpOnly/i.test(sc) &&
      /SameSite=Lax/i.test(sc),
    "GET /?token=... sets HttpOnly SameSite=Lax kiloton_token cookie (D6/S1)"
  );

  // S1 replay: the cookie set above must now authenticate a plain API request
  // made with ONLY the cookie (no ?token=, no Authorization header). This
  // proves the browser's auto-attached cookie works on subsequent same-origin
  // requests.
  const cookieReplay = await fetch(`${BASE_URL}/api/health`, { headers: { Cookie: "kiloton_token=test-token" } });
  check(
    cookieReplay.status === 200 && cookieReplay.ok,
    "GET /api/health with kiloton_token cookie only -> 200 (S1 replay)"
  );

  // 2) WebSocket upgrade requires the token too.
  const r = await startPaneToken("p1", "d1", { mode: "interactive", dir: ROOT }, "test-token");
  check(r.ok, "start pane with token accepted");
  check(await waitStatus("p1", "running", 8000, "test-token"), "token pane reaches running");

  const wsBase = BASE_URL.replace(/^http/, "ws");
  const staysOpen = await new Promise((resolve) => {
    let closed = false;
    const ws = new WebSocket(`${wsBase}/ws/p1?token=test-token`);
    const t = setTimeout(() => { try { ws.close(); } catch {} resolve(!closed); }, 2000);
    ws.on("open", () => {});
    ws.on("close", () => { closed = true; clearTimeout(t); resolve(false); });
    ws.on("error", () => { closed = true; clearTimeout(t); resolve(false); });
  });
  check(staysOpen, "WebSocket /ws/p1?token=test-token stays OPEN (D6)");

  const closedNoToken = await new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}/ws/p1`);
    const t = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 3000);
    ws.on("close", () => { clearTimeout(t); resolve(true); });
    ws.on("error", () => { clearTimeout(t); resolve(true); });
  });
  check(closedNoToken, "WebSocket /ws/p1 without token is CLOSED (D6)");

  await stopPane("p1");
}

// ---- U1: POST /api/kilo/update — invalid-version 400 leaves the guard usable ----
// SAFETY: an invalid `version` is rejected with 400 (routes.js:72) BEFORE
// `updateInFlight` is set and long before `killAllKiloProcesses()` runs, so
// hitting this path is safe and never kills the host kilo instance. We assert
// (U1) that a rejected request does NOT leave a permanent 409 lockout: a
// second identical invalid request must also be 400 (not 409), proving the
// guard was reset on the first 400. NOTE: the previously-present U2 test that
// sent a VALID version ("latest") is intentionally NOT included here — a valid
// version reaches killAllKiloProcesses() (routes.js:104) and would kill the
// host kilo instance running this session.
async function kiloUpdateGuard(_tmpDir) {
  const TOK = "test-token";
  const auth = { Authorization: "Bearer " + TOK };
  const ct = { "Content-Type": "application/json" };

  // An invalid version is rejected with 400 and must NOT permanently lock the
  // guard. A second identical request must also be 400 (not 409).
  const bad = JSON.stringify({ version: "!!notaversion" });
  const r1 = await fetch(`${BASE_URL}/api/kilo/update`, { method: "POST", headers: { ...ct, ...auth }, body: bad });
  check(r1.status === 400, `POST /api/kilo/update invalid version -> 400 (U1)`);
  const r2 = await fetch(`${BASE_URL}/api/kilo/update`, { method: "POST", headers: { ...ct, ...auth }, body: bad });
  check(r2.status === 400 && r2.status !== 409, `POST /api/kilo/update repeat invalid version -> 400, NOT 409 (U1)`);
}

// ---- Q1: auto-restart crashed agents ----
async function autoRestart(tmpDir) {
  const p = pane("p1");
  p.autoRestart = true;
  const cfg = { kiloBin: "auto", autostart: false, dashboards: [{ id: "d1", name: "Test", rows: 1, cols: 1, panes: [p] }] };

  const bin = path.join(tmpDir, "fake-crash.cjs");
  writeFileSync(bin,
    `const fs=require('fs'); try{const p=process.env.KILO_E2E_RESTART_PROBE; if(p) fs.appendFileSync(p,'run\\n');}catch(e){} process.exit(1);\n`);
  const probe = path.join(tmpDir, "restartprobe.log");

  await withServer(tmpDir, cfg, { KILO_BIN_PATH: bin, KILO_E2E_RESTART_PROBE: probe }, async () => {
    await startPane("p1", "d1", { mode: "interactive", dir: ROOT });

    const enough = await waitFor(async () => {
      if (!existsSync(probe)) return false;
      const lines = readFileSync(probe, "utf8").split("\n").filter((x) => x.trim().length).length;
      return lines >= 2;
    }, 12000, 200);
    check(enough, "pane auto-restarted after a crash (>=2 runs) (Q1)");

    const ccfg = await getJSON(`${BASE_URL}/api/config`);
    const cp = ccfg.dashboards.flatMap((d) => d.panes).find((x) => x.id === "p1");
    check((cp.autoRestartAttempts || 0) >= 1, `autoRestartAttempts incremented (${cp.autoRestartAttempts}) (Q1)`);

    await stopPane("p1");
  });
}

// ---- Q6: full transcript endpoint ----
async function transcriptExport(tmpDir) {
  const bin = path.join(tmpDir, "fake-transcript.cjs");
  writeFileSync(bin,
    `const fs=require('fs'); try{process.stdout.write('KILOTON_TRANSCRIPT_MARKER\\n');}catch(e){} setTimeout(()=>process.exit(0), 60000);\n`);

  await withServer(tmpDir, defaultCfg(1), { KILO_BIN_PATH: bin }, async () => {
    await startPane("p1", "d1", { mode: "interactive", dir: ROOT });
    check(await waitStatus("p1", "running", 8000), "transcript pane reaches running");

    const r = await fetch(`${BASE_URL}/api/instances/p1/transcript`);
    check(r.ok, "GET /api/instances/p1/transcript -> 200 (Q6)");
    const ct = r.headers.get("content-type") || "";
    check(ct.includes("text/plain"), `transcript content-type is text/plain (${ct}) (Q6)`);
    // Status flips to "running" synchronously (set by the spawn, not by a pty
    // event), so the marker bytes may not have reached the transcript buffer
    // yet — poll for them instead of reading once.
    const gotMarker = await waitFor(async () => {
      const tr = await fetch(`${BASE_URL}/api/instances/p1/transcript`);
      if (!tr.ok) return false;
      const t = await tr.text();
      return t.includes("KILOTON_TRANSCRIPT_MARKER");
    }, 8000, 100);
    check(gotMarker, "transcript body contains the captured marker (Q6)");

    const miss = await fetch(`${BASE_URL}/api/instances/nope/transcript`);
    check(miss.status === 404, "GET /api/instances/nope/transcript -> 404 (Q6)");

    await stopPane("p1");
  });
}

// ---- runner ----------------------------------------------------------------

async function withServer(tmpDir, cfgObj, extraEnv, fn) {
  const cfgPath = path.join(tmpDir, "cfg-" + Math.random().toString(36).slice(2, 8) + ".json");
  writeFileSync(cfgPath, JSON.stringify(cfgObj, null, 2));
  const port = nextPort();
  const base = `http://localhost:${port}`;
  const prev = BASE_URL;
  BASE_URL = base;
  const child = startServer(cfgPath, extraEnv, port);
  try {
    await waitReady(child);
    await fn(cfgPath);
  } finally {
    BASE_URL = prev;
    stopServer(child);
  }
}

async function main() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "kiloton-e2e-"));
  const cfgPath = path.join(tmpDir, "config.json");
  writeFileSync(cfgPath, JSON.stringify(defaultCfg(6), null, 2));

  const child = startServer(cfgPath);
  try {
    await waitReady(child);
    console.log(`\n== Core suite (port ${PORT}) ==`);
    await bootAndAssets();
    await sessionsList();
    await interactiveLifecycle("p1");
    await invalidSessionId("p2");
    await unknownPane404();
    await wsUnknownCloses();
    await resumeById("p3");
    await taskMode("p4");
    await invalidDirFallback("p5");
    await restartKeepsAlive("p6");
    await layoutPersistence();
  } finally {
    stopServer(child);
  }

  console.log(`\n== Multiple dashboards ==`);
  await withServer(tmpDir, multiDashCfg(), {}, multipleDashboards);

  console.log(`\n== Autostart ==`);
  await withServer(tmpDir, await autostart(), {}, async () => {
    const cfg = await getJSON(`${BASE_URL}/api/config`);
    const p = cfg.dashboards.flatMap((d) => d.panes).find((x) => x.id === "p1");
    check(p.status === "running", "autostart spawned the saved instance on boot");
  });

  console.log(`\n== Env passthrough + KILO_BIN_PATH (B4) ==`);
  const { fakeBin, probe } = await envPassthrough(tmpDir);
  const PROVIDER_KEY = "sk-test-provider-123";
  await withServer(tmpDir, defaultCfg(1), { KILO_BIN_PATH: fakeBin, KILO_E2E_ENVPROBE: probe, ANTHROPIC_API_KEY: PROVIDER_KEY }, async () => {
    await startPane("p1", "d1", { mode: "interactive", dir: ROOT });
    const wrote = await waitFor(() => existsSync(probe), 8000);
    check(wrote, "custom KILO_BIN_PATH was executed (env probe written)");
    if (wrote) {
      const env = JSON.parse(readFileSync(probe, "utf8"));
      check(env.probe === probe, "custom env var is inherited by the spawned process");
      check(env.port == null, "KILOTON_PORT is NOT leaked into the agent (B4)");
      check(env.provider === PROVIDER_KEY, "provider key (ANTHROPIC_API_KEY) still passed through (B4)");
    }
    await stopPane("p1");
  });

  console.log(`\n== Model/agent passthrough (E1) ==`);
  const { fakeBin: argvBin, probe: argvProbe } = await modelAgentPassthrough(tmpDir);
  await withServer(tmpDir, defaultCfg(1), { KILO_BIN_PATH: argvBin, KILO_E2E_ARGVPROBE: argvProbe }, async () => {
    // Start from a clean probe so we capture THIS pane's own argv, not a stale
    // write from an earlier `kilo session list` invocation.
    try { rmSync(argvProbe); } catch {}
    await startPane("p1", "d1", { mode: "interactive", dir: ROOT, model: "anthropic/test-model", agent: "my-agent" });
    const wrote = await waitFor(() => existsSync(argvProbe), 8000);
    check(wrote, "model/agent pane started and recorded argv");
    if (wrote) {
      const argv = JSON.parse(readFileSync(argvProbe, "utf8"));
      const mi = argv.indexOf("-m");
      const ai = argv.indexOf("--agent");
      check(mi !== -1 && argv[mi + 1] === "anthropic/test-model", "model passed through as -m <model>");
      check(ai !== -1 && argv[ai + 1] === "my-agent", "agent passed through as --agent <agent>");
    }
    await stopPane("p1");
  });

  console.log(`\n== Version / health / instances APIs (E2/D2/D3) ==`);
  await withServer(tmpDir, defaultCfg(1), {}, async () => {
    const v = await getJSON(`${BASE_URL}/api/version`);
    let pkgVersion = null;
    try { pkgVersion = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version; } catch {}
    check(v && v.version === pkgVersion, `GET /api/version returns package.json version (${v && v.version})`);

    const h = await getJSON(`${BASE_URL}/api/health`);
    check(h && h.ok === true && typeof h.uptime === "number" && typeof h.runningInstances === "number" && typeof h.kiloVersion === "string",
      "GET /api/health returns ok/uptime/runningInstances/kiloVersion (D2)");

    const insts = await getJSON(`${BASE_URL}/api/instances`);
    check(Array.isArray(insts), "GET /api/instances returns an array (D3)");
  });

  console.log(`\n== Malformed config 400 (E3/B1) ==`);
  await malformedConfig400(tmpDir);

  console.log(`\n== Quoted dir path (D1) ==`);
  await quotedPathCwd(tmpDir);

  console.log(`\n== Instance cleanup on exit (D2/A3) ==`);
  await instanceCleanup(tmpDir);

  console.log(`\n== D3: failed spawn surfaces error state ==`);
  await failPaneError(tmpDir);

  console.log(`\n== D4: normalizeStartInput 400s ==`);
  await normalizeStartInput400(tmpDir);

  console.log(`\n== D5: sync flush + D1 config/index consistency ==`);
  await configIndexAndSyncFlush(tmpDir);

  console.log(`\n== Kilo version API ==`);
  await withServer(tmpDir, defaultCfg(1), {}, async () => {
    const v = await getJSON(`${BASE_URL}/api/kilo/version`);
    check(v && typeof v.installed === "string" && v.installed.length > 0, "GET /api/kilo/version returns installed version");
  });

  console.log(`\n== D6: token auth ==`);
  await withServer(tmpDir, defaultCfg(1), { KILOTON_TOKEN: "test-token" }, async () => { await tokenAuth(tmpDir); });

  console.log(`\n== U1: kilo update guard (invalid-version only; no kill path) ==`);
  await withServer(tmpDir, defaultCfg(1), { KILOTON_TOKEN: "test-token" }, async () => { await kiloUpdateGuard(tmpDir); });

  console.log(`\n== Q1: auto-restart ==`);
  await autoRestart(tmpDir);

  console.log(`\n== Q6: full transcript ==`);
  await transcriptExport(tmpDir);

  const agents = parseInt(process.env.KILOTON_E2E_AGENTS || "6", 10);
  console.log(`\n== Scaling (${agents} agents) ==`);
  await withServer(tmpDir, defaultCfg(agents), {}, async () => { await manyAgents(agents); });

  rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n${failures.length === 0 ? "ALL E2E TESTS PASSED" : failures.length + " E2E TEST(S) FAILED"}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error("E2E harness error:", e); process.exit(1); });
