import { execFile } from "child_process";
import { loadConfig, saveConfig } from "../config.js";
import { validateConfig } from "../validate.js";
import { listSessions } from "../sessions.js";
import {
  getKiloVersion,
  getLatestKiloVersion,
  resetKiloBinCache,
} from "../spawn.js";
import { validateStartInput } from "../validate.js";
import { log } from "../log.js";
import { killAllKiloProcesses } from "./killKilo.js";

// D2 — every HTTP route, registered against the shared Express `app`. All
// runtime state is reached through `ctx.S` (the state module) so this file
// holds no mutable state of its own.

export function registerRoutes(app, ctx) {
  const { S } = ctx;
  let updateInFlight = false;
  // ---- helpers ---------------------------------------------------------------

  // D4: normalize + clamp the body of `POST /api/instances`.
  function clampInt(v, fallback, min, max) {
    if (v === undefined || v === null) return fallback;
    const n = Number.isInteger(v) ? v : parseInt(v, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function normalizeStartInput(body) {
    const err = validateStartInput(body);
    if (err) return { error: err };
    const value = {
      dashboardId: typeof body.dashboardId === "string" ? body.dashboardId : undefined,
      paneId: typeof body.paneId === "string" ? body.paneId : undefined,
      mode: typeof body.mode === "string" ? body.mode.trim() : undefined,
      dir: typeof body.dir === "string" ? body.dir.trim() : undefined,
      model: typeof body.model === "string" ? body.model.trim() || null : null,
      agent: typeof body.agent === "string" ? body.agent.trim() || null : null,
      sessionId: typeof body.sessionId === "string" ? body.sessionId.trim() || null : null,
      task: typeof body.task === "string" ? body.task.trim() || null : null,
      auto: !!body.auto,
      rows: clampInt(body.rows, 24, 1, 500),
      cols: clampInt(body.cols, 80, 1, 500),
    };
    return { value };
  }

  // ---- routes -----------------------------------------------------------------

  app.get("/api/health", (req, res) => res.json({
    ok: true,
    uptime: process.uptime(),
    runningInstances: S.instances.size,
    kiloVersion: getKiloVersion(),
  }));

  app.get("/api/version", (req, res) => res.json({ version: ctx.KILOTON_VERSION }));

  app.get("/api/kilo/version", async (req, res) => {
    res.json({ installed: getKiloVersion(), latest: await getLatestKiloVersion() });
  });

  app.post("/api/kilo/update", (req, res) => {
    const body = req.body || {};
    if (updateInFlight) {
      res.status(409).json({ error: "update already in progress" });
      return;
    }
    const target = typeof body.version === "string" ? body.version.trim() : "latest";
    if (target !== "latest" && !/^\d+\.\d+\.\d+$/.test(target)) {
      res.status(400).json({ error: "invalid version" });
      return;
    }
    const pkg = target === "latest" ? "@kilocode/cli" : `@kilocode/cli@${target}`;
    updateInFlight = true;

    const stopPromises = [];
    const cfg = loadConfig();
    for (const [paneId, inst] of S.instances) {
      stopPromises.push(new Promise((resolve) => {
        if (!inst || !inst.pty) return resolve();
        const t = setTimeout(resolve, 3000);
        S.killInstance(inst);
        inst.pty.once("exit", () => { clearTimeout(t); resolve(); });
      }));
      for (const d of cfg.dashboards) {
        const p = d.panes.find((x) => x.id === paneId);
        if (p) { p.instanceId = null; p.status = "stopped"; }
      }
    }
    saveConfig(cfg);
    S.instances.clear();

    for (const d of cfg.dashboards) {
      for (const p of d.panes) {
        if (p._restartTimer) { clearTimeout(p._restartTimer); p._restartTimer = null; }
      }
    }

    Promise.all(stopPromises)
      .then(() => {
        killAllKiloProcesses();
        setTimeout(() => {
          execFile("npm", ["install", "-g", pkg], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 300000, windowsHide: true }, (err, stdout, stderr) => {
            if (err) {
              updateInFlight = false;
              res.status(500).json({ ok: false, error: (stderr || String(err)).slice(0, 2000), installed: getKiloVersion() });
              return;
            }
            resetKiloBinCache();
            updateInFlight = false;
            res.json({ ok: true, installed: getKiloVersion(), output: (stdout || "").slice(0, 2000) });
          });
        }, 500);
      })
      .catch((e) => {
        updateInFlight = false;
        res.status(500).json({ ok: false, error: String(e) });
      });
  });

  app.get("/api/config", (req, res) => res.json(loadConfig()));

  // B1 + A3: validate, persist, then kill orphaned ptys for panes dropped from
  // the saved layout.
  app.post("/api/config", (req, res) => {
    const body = req.body;
    const err = validateConfig(body);
    if (err) {
      res.status(400).json({ error: "invalid config: " + err });
      return;
    }
    const clean = JSON.parse(JSON.stringify(body));
    for (const d of clean.dashboards || []) {
      for (const p of d.panes || []) {
        delete p.status; delete p.instanceId; delete p.exitCode; delete p.error; delete p.autoRestartAttempts;
      }
    }
    const cfg = saveConfig(clean);
    const liveIds = new Set();
    for (const d of cfg.dashboards) for (const p of d.panes) liveIds.add(p.id);
    for (const [paneId, inst] of [...S.instances]) {
      if (!liveIds.has(paneId)) {
        log("info", `orphan pane ${paneId} dropped from config — killing instance`);
        S.killInstance(inst);
        S.instances.delete(paneId);
      }
    }
    res.json({ ok: true });
  });

  // D3: running instances for headless / Docker debugging.
  app.get("/api/instances", (req, res) => {
    const out = [];
    for (const [paneId, inst] of S.instances) {
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

  // Q6: full transcript of a pane (server-side capture, not the capped client
  // scrollback). Returns text/plain so it can be saved straight to a file.
  app.get("/api/instances/:paneId/transcript", (req, res) => {
    const { paneId } = req.params;
    if (!S.findPaneById(paneId)) {
      res.status(404).json({ error: "pane not found" });
      return;
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("X-Transcript-Bytes", String(S.getTranscript(paneId).length));
    res.send(S.getTranscript(paneId));
  });

  app.post("/api/instances", (req, res) => {
    const body = req.body || {};
    const { error, value } = normalizeStartInput(body);
    if (error) {
      res.status(400).json({ error });
      return;
    }
    const { dashboardId, paneId, mode, dir, model, agent, sessionId, task, auto, rows, cols } = value;
    const pane = S.findPaneById(paneId, dashboardId);
    if (!pane) {
      res.status(404).json({ error: "pane not found" });
      return;
    }

    if (mode !== undefined) pane.mode = mode;
    if (dir !== undefined) pane.dir = dir;
    pane.model = model;
    pane.agent = agent;
    pane.sessionId = sessionId;
    pane.task = task;
    pane.auto = auto;

    const existing = S.instances.get(paneId);
    if (existing && existing.status === "running") {
      res.json({ instanceId: paneId, wsPath: "/ws/" + paneId });
      return;
    }
    try {
      res.json(S.startInstance(pane, { rows, cols }));
    } catch (e) {
      const reason = "failed to start agent: " + String(e && e.message ? e.message : e);
      S.failPane(paneId, reason);
      res.status(500).json({ error: reason, status: "error", paneId });
    }
  });

  app.delete("/api/instances/:paneId", (req, res) => {
    const { paneId } = req.params;
    if (!S.findPaneById(paneId)) {
      res.status(404).json({ error: "pane not found" });
      return;
    }
    S.stopInstance(paneId);
    res.json({ ok: true });
  });

  app.post("/api/instances/:paneId/restart", (req, res) => {
    const { paneId } = req.params;
    const pane = S.findPaneById(paneId);
    if (!pane) {
      res.status(404).json({ error: "pane not found" });
      return;
    }
    try {
      res.json(S.startInstance(pane));
    } catch (e) {
      const reason = "failed to restart agent: " + String(e && e.message ? e.message : e);
      S.failPane(paneId, reason);
      res.status(500).json({ error: reason, status: "error", paneId });
    }
  });
}
