import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";

import { resolveKiloBinAtBoot } from "./lib/spawn.js";
import { loadConfig, saveConfig, flushConfig } from "./lib/config.js";
import { log } from "./lib/log.js";

import { createState } from "./lib/server/state.js";
import { createAuth, tokenMatches } from "./lib/server/auth.js";
import { createAutoRestart } from "./lib/server/autorestart.js";
import { registerRoutes } from "./lib/server/routes.js";
import { attachWs } from "./lib/server/ws.js";
import { killAllKiloProcesses } from "./lib/server/killKilo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const NODE_MODULES = path.join(__dirname, "node_modules");
const PORT = Number(process.env.KILOTON_PORT) || 7655;
const HOST = process.env.KILOTON_HOST || "127.0.0.1";

const KILOTON_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version; } catch { return null; }
})();

const app = express();
app.use(express.json({ limit: "1mb" }));

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

// D6: optional API + WebSocket auth.
const auth = createAuth(process.env.KILOTON_TOKEN);
app.use(auth.httpMiddleware);

// vendor xterm from node_modules
app.use("/vendor/xterm", express.static(path.join(NODE_MODULES, "@xterm/xterm")));
// Expose ONLY the browser-safe helper the client actually imports
// (lib/dir.js's cleanDir) as a single source of truth shared with the server.
// Serving the whole lib/ tree would also expose lib/server/* (auth, routes,
// etc.) to the browser, which is unnecessary.
app.get("/lib/dir.js", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "lib", "dir.js"));
});
// Serve the dashboard. Use `no-store` so the browser NEVER caches app.js /
// index.html — a stale script is the classic cause of a "dead" UI that does
// nothing on click. index.html is served dynamically with a cache-busting
// `?v=<mtime>` query on app.js so even an already-cached URL is refetched the
// moment the file changes.
const APP_JS = path.join(PUBLIC_DIR, "app.js");
app.get("/", (req, res) => {
  // S1: a LAN browser can only present the token via `?token=` on the
  // top-level navigation (it can't set an `Authorization` header). When a valid
  // token is supplied and token auth is enabled, set a same-origin HttpOnly
  // cookie so the browser auto-attaches it to the subsequent static/API/WS
  // sub-resources and the dashboard actually loads. Never set a cookie when
  // auth is disabled.
  const presented = auth.enabled ? auth.tokenFromReq(req) : null;
  if (presented && tokenMatches(presented, auth.expected)) {
    res.cookie("kiloton_token", presented, { path: "/", sameSite: "lax", httpOnly: true, secure: !!(req.secure || (req.headers && String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https")) });
  }
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

// ---- runtime state + features -------------------------------------------------

const S = createState();
// Q1: wire auto-restart as startInstance's exit hook.
const autorestart = createAutoRestart({
  startInstance: S.startInstance,
  findPaneById: S.findPaneById,
  patchPane: S.patchPane,
  log,
});
S.setExitHook(autorestart.onExit);

const ctx = { S, auth, originOk, ENFORCE_ORIGIN, KILOTON_VERSION };

registerRoutes(app, ctx);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
attachWs(server, wss, ctx);

server.listen(PORT, HOST, () => {
  console.log(`Kiloton running at http://localhost:${PORT}`);
  resolveKiloBinAtBoot();
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
    // Clear orphaned Kilo processes from a previous crashed server session
    // before (re)starting panes, guaranteeing a single instance per pane.
    killAllKiloProcesses();
    for (const dash of cfg.dashboards) {
      for (const pane of dash.panes) {
        if (pane.instanceId) {
          try {
            S.startInstance(pane, {}, { isAutoRestart: false });
            log("info", `autostarted pane ${pane.id} (mode=${pane.mode})`);
          } catch (e) {
            S.failPane(pane.id, "autostart failed: " + String(e && e.message ? e.message : e));
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
function openBrowser(port) {
  if (process.argv.includes("--no-open") || process.env.KILOTON_NO_OPEN) return;
  try {
    if (fs.existsSync("/.dockerenv")) return;
  } catch {}
  // WSL: xdg-open is usually absent, so defer to the Windows browser.
  let isWsl = false;
  try {
    isWsl = process.platform === "linux" &&
      fs.readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {}
  const url = `http://localhost:${port}`;
  let cmd;
  if (process.platform === "darwin") cmd = `open ${url}`;
  else if (process.platform === "win32") cmd = `cmd /c start "" "${url}"`;
  else if (isWsl) cmd = `cmd.exe /c start "" "${url}"`;
  else cmd = `xdg-open ${url}`;
  try {
    exec(cmd, (err) => { if (err) {/* ignore */} });
  } catch {}
}

function shutdown() {
  for (const inst of S.instances.values()) S.killInstance(inst);
  S.instances.clear();
  // flush config through config.js so the debounce timer is drained.
  try { flushConfig(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
