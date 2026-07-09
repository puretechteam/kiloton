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

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function waitStatus(paneId, want, timeout = 8000) {
  return waitFor(async () => {
    const cfg = await getJSON(`${BASE}/api/config`);
    const pane = cfg.dashboards.flatMap((d) => d.panes).find((p) => p.id === paneId);
    return pane && pane.status === want;
  }, timeout);
}

function collectPaneBytes(paneId, ms = 8000) {
  return new Promise((resolve) => {
    let bytes = 0;
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/${paneId}`);
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(bytes); }, ms);
    ws.on("open", () => ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 })));
    ws.on("message", (d) => { bytes += d.length; });
    ws.on("close", () => { clearTimeout(timer); resolve(bytes); });
    ws.on("error", () => { clearTimeout(timer); resolve(bytes); });
  });
}

async function startPane(paneId, dashboardId, body) {
  const r = await fetch(`${BASE}/api/instances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dashboardId, paneId, ...body }),
  });
  return r;
}
async function stopPane(paneId) {
  await fetch(`${BASE}/api/instances/${paneId}`, { method: "DELETE" });
}

// ---- server lifecycle -------------------------------------------------------

function startServer(cfgPath, extraEnv = {}) {
  const child = spawn("node", ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, KILOTON_PORT: String(PORT), KILOTON_CONFIG: cfgPath, ...extraEnv },
    stdio: "ignore",
  });
  return child;
}
async function waitReady(child) {
  const ok = await waitFor(async () => {
    try { await getJSON(`${BASE}/api/config`); return true; } catch { return false; }
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
  const cfg = await getJSON(`${BASE}/api/config`);
  check(Array.isArray(cfg.dashboards) && cfg.dashboards.length >= 1, "config has at least one dashboard");
  for (const p of ["/", "/app.js", "/style.css", "/vendor/xterm/lib/xterm.js", "/vendor/addon-fit/lib/addon-fit.js", "/vendor/xterm/css/xterm.css"]) {
    const r = await fetch(BASE + p);
    check(r.ok, `asset served: ${p} (${r.status})`);
  }
}

async function sessionsList() {
  const s = await getJSON(`${BASE}/api/sessions`);
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
  const cfg = await getJSON(`${BASE}/api/config`);
  const p = cfg.dashboards.flatMap((d) => d.panes).find((x) => x.id === paneId);
  check(p.instanceId === null, `${paneId}: stopped instance clears instanceId`);
}

async function invalidSessionId(paneId) {
  await startPane(paneId, "d1", { mode: "resume", sessionId: "ses_does_not_exist_xyz" });
  // server must stay healthy; the bad session simply exits
  const healthy = await waitFor(async () => { try { await getJSON(`${BASE}/api/config`); return true; } catch { return false; } }, 5000);
  check(healthy, `${paneId}: server stays healthy with an invalid session id`);
  await stopPane(paneId);
}

async function unknownPane404() {
  const post = await startPane("nope", "d1", { mode: "interactive", dir: ROOT });
  check(post.status === 404, "POST instance for unknown pane -> 404");
  const del = await fetch(`${BASE}/api/instances/nope`, { method: "DELETE" });
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
  const s = await getJSON(`${BASE}/api/sessions`);
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
  const before = await getJSON(`${BASE}/api/config`);
  const newRows = before.dashboards[0].rows === 1 ? 2 : 1;
  before.dashboards[0].rows = newRows;
  await fetch(`${BASE}/api/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(before) });
  const after = await getJSON(`${BASE}/api/config`);
  check(after.dashboards[0].rows === newRows, "layout change persisted via POST /api/config");
}

async function restartKeepsAlive(paneId) {
  await startPane(paneId, "d1", { mode: "interactive", dir: ROOT });
  check(await waitStatus(paneId, "running"), `${paneId}: restart test starts`);
  await fetch(`${BASE}/api/instances/${paneId}/restart`, { method: "POST" });
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
    const r = await fetch(`${BASE}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dashboards: "not-an-array" }),
    });
    check(r.status === 400, "POST /api/config with non-array dashboards -> 400 (B1)");
  });
}

// ---- runner ----------------------------------------------------------------

async function withServer(tmpDir, cfgObj, extraEnv, fn) {
  const cfgPath = path.join(tmpDir, "cfg-" + Math.random().toString(36).slice(2, 8) + ".json");
  writeFileSync(cfgPath, JSON.stringify(cfgObj, null, 2));
  const child = startServer(cfgPath, extraEnv);
  try {
    await waitReady(child);
    await fn();
  } finally {
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
    const sessions = await sessionsList();
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
    const cfg = await getJSON(`${BASE}/api/config`);
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
    const v = await getJSON(`${BASE}/api/version`);
    let pkgVersion = null;
    try { pkgVersion = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version; } catch {}
    check(v && v.version === pkgVersion, `GET /api/version returns package.json version (${v && v.version})`);

    const h = await getJSON(`${BASE}/api/health`);
    check(h && h.ok === true && typeof h.uptime === "number" && typeof h.runningInstances === "number" && typeof h.kiloVersion === "string",
      "GET /api/health returns ok/uptime/runningInstances/kiloVersion (D2)");

    const insts = await getJSON(`${BASE}/api/instances`);
    check(Array.isArray(insts), "GET /api/instances returns an array (D3)");
  });

  console.log(`\n== Malformed config 400 (E3/B1) ==`);
  await malformedConfig400(tmpDir);

  console.log(`\n== Kilo version API ==`);
  await withServer(tmpDir, defaultCfg(1), {}, async () => {
    const v = await getJSON(`${BASE}/api/kilo/version`);
    check(v && typeof v.installed === "string" && v.installed.length > 0, "GET /api/kilo/version returns installed version");
  });

  const agents = parseInt(process.env.KILOTON_E2E_AGENTS || "6", 10);
  console.log(`\n== Scaling (${agents} agents) ==`);
  await withServer(tmpDir, defaultCfg(agents), {}, async () => { await manyAgents(agents); });

  rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n${failures.length === 0 ? "ALL E2E TESTS PASSED" : failures.length + " E2E TEST(S) FAILED"}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error("E2E harness error:", e); process.exit(1); });
