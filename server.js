import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { spawnKilo, killInstance, resizeInstance, getKiloVersion, getLatestKiloVersion, resetKiloBinCache } from "./lib/spawn.js";
import { listSessions } from "./lib/sessions.js";
import { loadConfig, saveConfig, flushConfig } from "./lib/config.js";
import { execFile, exec } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const NODE_MODULES = path.join(__dirname, "node_modules");
const PORT = Number(process.env.KILOTON_PORT) || 7655;
const HOST = process.env.KILOTON_HOST || "127.0.0.1";

const KILOTON_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version; } catch { return null; }
})();

const app = express();
app.use(express.json());

// Same-origin guard: the API can spawn arbitrary kilo agents/tasks, so if the
// server is ever bound to a non-local interface we must not let a random
// webpage drive it. Browser cross-origin requests carry an `Origin` header that
// must match the request `Host`; non-browser clients (curl, the e2e suite)
// send no Origin and are allowed. Disable with KILOTON_NO_ORIGIN_CHECK=1
// (e.g. behind a reverse proxy that strips Origin).
const ENFORCE_ORIGIN = !process.env.KILOTON_NO_ORIGIN_CHECK;
function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
app.use((req, res, next) => {
  if (ENFORCE_ORIGIN && !originOk(req)) {
    res.status(403).json({ error: "cross-origin request blocked" });
    return;
  }
  next();
});

// vendor xterm from node_modules
app.use("/vendor/xterm", express.static(path.join(NODE_MODULES, "@xterm/xterm")));
app.use("/vendor/addon-fit", express.static(path.join(NODE_MODULES, "@xterm/addon-fit")));
// Serve the dashboard. Use `no-store` so the browser NEVER caches app.js /
// index.html — a stale script is the classic cause of a "dead" UI that does
// nothing on click. index.html is served dynamically with a cache-busting
// `?v=<mtime>` query on app.js so even an already-cached URL is refetched the
// moment the file changes.
const APP_JS = path.join(PUBLIC_DIR, "app.js");
app.get("/", (req, res) => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  let v = "0";
  try { v = String(fs.statSync(APP_JS).mtimeMs); } catch {}
  res.setHeader("Cache-Control", "no-store");
  res.send(html.replace('/app.js"', `/app.js?v=${v}"`));
});
app.get("/favicon.ico", (_req, res) => res.status(204).end());
app.use(express.static(PUBLIC_DIR, {
  maxAge: 0,
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
}));

// runtime registry: paneId -> instance
const instances = new Map();

function findPane(dashboardId, paneId) {
  const cfg = loadConfig();
  const dash = cfg.dashboards.find((d) => d.id === dashboardId);
  return dash ? dash.panes.find((p) => p.id === paneId) : null;
}

function findPaneById(paneId) {
  const cfg = loadConfig();
  for (const dash of cfg.dashboards) {
    const p = dash.panes.find((x) => x.id === paneId);
    if (p) return p;
  }
  return null;
}

function patchPane(paneId, patch) {
  const cfg = loadConfig();
  for (const dash of cfg.dashboards) {
    const p = dash.panes.find((x) => x.id === paneId);
    if (p) {
      Object.assign(p, patch);
      break;
    }
  }
  saveConfig(cfg);
}

app.get("/api/health", (req, res) => res.json({
  ok: true,
  uptime: process.uptime(),
  runningInstances: instances.size,
  kiloVersion: getKiloVersion(),
}));

app.get("/api/version", (req, res) => res.json({ version: KILOTON_VERSION }));

app.get("/api/kilo/version", async (req, res) => {
  res.json({ installed: getKiloVersion(), latest: await getLatestKiloVersion() });
});

// Kill every running kilo process on the machine (not just the dashboard's
// tracked instances). On Windows the global kilo.exe is locked by any live
// kilo session — including the chat agent you're talking to — so npm can't
// replace the binary until they're all gone. We deliberately spare the
// Kiloton server itself (node server.js).
function killAllKiloProcesses() {
  if (process.platform !== "win32") return;
  try { execFile("taskkill", ["/F", "/IM", "kilo.exe"], { windowsHide: true }); } catch {}
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*kilo*' -and $_.CommandLine -notlike '*server.js*' } | ForEach-Object { taskkill /F /PID $_.ProcessId }";
  try { execFile("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true }); } catch {}
}

// Update the Kilo CLI in place (`npm install -g @kilocode/cli[@version]`).
// Already-spawned agents keep running on the old binary; new spawns pick up
// the new one. `version` is "latest" or an exact x.y.z.
app.post("/api/kilo/update", (req, res) => {
  const body = req.body || {};
  const target = typeof body.version === "string" ? body.version.trim() : "latest";
  if (target !== "latest" && !/^\d+\.\d+\.\d+$/.test(target)) {
    res.status(400).json({ error: "invalid version" });
    return;
  }
  const pkg = target === "latest" ? "@kilocode/cli" : `@kilocode/cli@${target}`;

  // On Windows the running kilo.exe is locked by live agents, so npm can't
  // replace the binary (EBUSY). Stop every tracked instance and mark its pane
  // stopped first, so the file lock is released before the install runs.
  const stopPromises = [];
  const cfg = loadConfig();
  for (const [paneId, inst] of instances) {
    stopPromises.push(new Promise((resolve) => {
      if (!inst || !inst.pty) return resolve();
      const t = setTimeout(resolve, 3000);
      killInstance(inst);
      inst.pty.once("exit", () => { clearTimeout(t); resolve(); });
    }));
    for (const d of cfg.dashboards) {
      const p = d.panes.find((x) => x.id === paneId);
      if (p) { p.instanceId = null; p.status = "stopped"; }
    }
  }
  saveConfig(cfg);
  instances.clear();

  Promise.all(stopPromises).then(() => {
    // Kill any remaining kilo processes (e.g. the chat agent) that still hold
    // the global binary open, then give the OS a moment to release handles.
    killAllKiloProcesses();
    setTimeout(() => {
      execFile("npm", ["install", "-g", pkg], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 300000, shell: true, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          res.status(500).json({ ok: false, error: (stderr || String(err)).slice(0, 2000), installed: getKiloVersion() });
          return;
        }
        resetKiloBinCache();
        res.json({ ok: true, installed: getKiloVersion(), output: (stdout || "").slice(0, 2000) });
      });
    }, 500);
  });
});

app.get("/api/config", (req, res) => res.json(loadConfig()));

// A2 + B1: validate the incoming config, persist it, then kill any runtime
// instances whose pane no longer exists in any dashboard (orphan pty leak).
function validateConfig(body) {
  if (!body || !Array.isArray(body.dashboards)) {
    return "dashboards must be an array";
  }
  for (const d of body.dashboards) {
    if (!d || typeof d.id !== "string" || typeof d.name !== "string" ||
        typeof d.rows !== "number" || typeof d.cols !== "number" ||
        !Array.isArray(d.panes)) {
      return "each dashboard needs id/name/rows/cols/panes";
    }
  }
  return null;
}

app.post("/api/config", (req, res) => {
  const body = req.body;
  const err = validateConfig(body);
  if (err) {
    res.status(400).json({ error: "invalid config: " + err });
    return;
  }
  const cfg = saveConfig(body);
  // A2 must run AFTER saveConfig returns (it writes the cached object the
  // instances map is reconciled against) and B1 must have run BEFORE (a
  // rejected body must not trigger orphan kills).
  const liveIds = new Set();
  for (const d of cfg.dashboards) for (const p of d.panes) liveIds.add(p.id);
  for (const [paneId, inst] of [...instances]) {
    if (!liveIds.has(paneId)) {
      console.log(`[lifecycle] orphan pane ${paneId} dropped from config — killing instance`);
      killInstance(inst);
      instances.delete(paneId);
    }
  }
  res.json({ ok: true });
});

// D3: expose running instances for headless / Docker debugging and a future
// instances UI. status/exitCode live on the inst object from spawnKilo.
app.get("/api/instances", (req, res) => {
  const out = [];
  for (const [paneId, inst] of instances) {
    out.push({ paneId, status: inst.status, exitCode: inst.exitCode });
  }
  res.json(out);
});

app.get("/api/sessions", async (req, res) => {
  try {
    res.json(await listSessions());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

function asStr(v) {
  return typeof v === "string" ? v : null;
}

app.post("/api/instances", (req, res) => {
  const body = req.body || {};
  const dashboardId = body.dashboardId;
  const paneId = body.paneId;
  const mode = typeof body.mode === "string" ? body.mode : "interactive";
  const dir = typeof body.dir === "string" ? body.dir : "";
  const model = asStr(body.model);
  const agent = asStr(body.agent);
  const sessionId = asStr(body.sessionId);
  const task = asStr(body.task);
  const auto = !!body.auto;
  const pane = findPane(dashboardId, paneId);
  if (!pane) {
    res.status(404).json({ error: "pane not found" });
    return;
  }

  const existing = instances.get(paneId);
  // Already running: don't kill the agent, just let the client (re)attach.
  if (existing && existing.status === "running") {
    res.json({ instanceId: paneId, wsPath: "/ws/" + paneId });
    return;
  }
  // kill any dead/exited instance for this pane
  if (existing) {
    try { existing.ws && existing.ws.close(); } catch { /* ignore */ }
    killInstance(existing);
  }
  instances.delete(paneId);

  let inst;
  try {
    inst = spawnKilo({
      paneId,
      mode,
      dir,
      model,
      agent,
      auto,
      sessionId,
      task,
      onStatus: (status, code) => {
        patchPane(paneId, { status, exitCode: code, instanceId: paneId });
      },
    });
  } catch (e) {
    console.error(`[lifecycle] spawn failed for pane ${paneId} (mode=${mode}): ${e}`);
    res.status(500).json({ error: "failed to start agent: " + String(e) });
    return;
  }
  instances.set(paneId, inst);
  console.log(`[lifecycle] spawned pane ${paneId} (mode=${mode}${model ? ", model=" + model : ""}${agent ? ", agent=" + agent : ""})`);

  // persist pane settings so layout/autostart survive reloads
  patchPane(paneId, { mode, dir, model, agent, auto, sessionId, task, instanceId: paneId, status: "running", exitCode: null });

  res.json({ instanceId: paneId, wsPath: "/ws/" + paneId });
});

app.delete("/api/instances/:paneId", (req, res) => {
  const { paneId } = req.params;
  if (!findPaneById(paneId)) {
    res.status(404).json({ error: "pane not found" });
    return;
  }
  const inst = instances.get(paneId);
  if (inst) killInstance(inst);
  instances.delete(paneId);
  patchPane(paneId, { instanceId: null, status: "stopped", exitCode: null });
  res.json({ ok: true });
});

app.post("/api/instances/:paneId/restart", (req, res) => {
  const { paneId } = req.params;
  const cfg = loadConfig();
  let pane = null;
  for (const dash of cfg.dashboards) {
    pane = dash.panes.find((p) => p.id === paneId);
    if (pane) break;
  }
  if (!pane) {
    res.status(404).json({ error: "pane not found" });
    return;
  }
  const inst = instances.get(paneId);
  if (inst) {
    try { inst.ws && inst.ws.close(); } catch { /* ignore */ }
    killInstance(inst);
  }
  instances.delete(paneId);

  let newInst;
  try {
    newInst = spawnKilo({
      paneId,
      mode: pane.mode,
      dir: pane.dir,
      model: pane.model,
      agent: pane.agent,
      auto: pane.auto,
      sessionId: pane.sessionId,
      task: pane.task,
      onStatus: (status, code) => patchPane(paneId, { status, exitCode: code }),
    });
  } catch (e) {
    console.error(`[lifecycle] restart failed for pane ${paneId}: ${e}`);
    res.status(500).json({ error: "failed to restart agent: " + String(e) });
    return;
  }
  instances.set(paneId, newInst);
  console.log(`[lifecycle] restarted pane ${paneId} (mode=${pane.mode})`);
  patchPane(paneId, { instanceId: paneId, status: "running", exitCode: null });
  res.json({ instanceId: paneId, wsPath: "/ws/" + paneId });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  if (ENFORCE_ORIGIN && !originOk(req)) {
    ws.close();
    return;
  }
  const paneId = decodeURIComponent((req.url || "").split("?")[0].split("/").pop());
  const inst = instances.get(paneId);
  if (!inst || !inst.pty) {
    ws.close();
    return;
  }
  inst.ws = ws;
  ws.send(JSON.stringify({ type: "status", status: inst.status, exitCode: inst.exitCode }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
      resizeInstance(inst, msg.cols, msg.rows);
    } else if (msg.type === "data" && typeof msg.data === "string") {
      inst.pty.write(msg.data);
    }
  });

  ws.on("close", () => {
    if (inst.ws === ws) inst.ws = null;
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Kiloton running at http://localhost:${PORT}`);
  const cfg = loadConfig();
  if (!cfg.autostart) {
    // server restarted: any saved instanceId points to a dead process
    let changed = false;
    for (const dash of cfg.dashboards) {
      for (const p of dash.panes) {
        if (p.instanceId) {
          p.instanceId = null;
          p.status = "stopped";
          p.exitCode = null;
          changed = true;
        }
      }
    }
    if (changed) saveConfig(cfg);
  } else {
    for (const dash of cfg.dashboards) {
      for (const pane of dash.panes) {
        if (pane.instanceId) {
          try {
            const inst = spawnKilo({
              paneId: pane.id,
              mode: pane.mode,
              dir: pane.dir,
              model: pane.model,
              agent: pane.agent,
              auto: pane.auto,
              sessionId: pane.sessionId,
              task: pane.task,
              onStatus: (status, code) => patchPane(pane.id, { status, exitCode: code }),
            });
            instances.set(pane.id, inst);
            patchPane(pane.id, { status: "running", exitCode: null });
            console.log(`[lifecycle] autostarted pane ${pane.id} (mode=${pane.mode})`);
          } catch (e) {
            // B2: a missing binary / bad path can throw here. Don't leave the
            // pane "running" with no live pty that reconnects forever — mark it
            // exited and clear the stale instanceId so the client shows empty.
            console.error(`[lifecycle] autostart failed for pane ${pane.id}: ${e}`);
            patchPane(pane.id, { status: "exited", exitCode: null, instanceId: null });
          }
        }
      }
    }
    console.log("Autostarted saved instances.");
  }
  openBrowser(PORT);
});

server.on("error", (err) => {
  console.error(`Kiloton failed to listen on ${HOST}:${PORT}: ${err.message}`);
  process.exit(1);
});

// Best-effort: open the dashboard in the user's default browser on first launch.
// Skipped in containers/CI or when explicitly disabled (--no-open / KILOTON_NO_OPEN).
function openBrowser(port) {
  if (process.argv.includes("--no-open") || process.env.KILOTON_NO_OPEN) return;
  try {
    if (fs.existsSync("/.dockerenv")) return;
  } catch {}
  const url = `http://localhost:${port}`;
  const cmd =
    process.platform === "darwin" ? `open ${url}`
    : process.platform === "win32" ? `cmd /c start "" "${url}"`
    : `xdg-open ${url}`;
  try {
    exec(cmd, (err) => { if (err) {/* ignore */} });
  } catch {}
}

function shutdown() {
  for (const inst of instances.values()) killInstance(inst);
  instances.clear();
  flushConfig();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
