import { spawnKilo, killInstance, resizeInstance } from "../spawn.js";
import { loadConfig, saveConfig, getConfigIndex } from "../config.js";
import { log } from "../log.js";
import { makeTranscriptRing } from "./transcript.js";

// D2 — the runtime registry + pane lifecycle, split out of server.js.
//
// Everything that owns the in-memory `instances` Map, the O(1) pane finder, and
// the start/stop/exit transitions lives here so routes.js and ws.js can stay
// thin. The module is created once via `createState()` and the resulting object
// (`S`) is threaded into the route/ws registrars.

export function createState() {
  // runtime registry: paneId -> instance
  const instances = new Map();

  // Q1: a single, stable exit hook (set by the server once the auto-restart
  // module exists). startInstance's per-instance onExit calls it. Defaults to a
  // no-op so the module is usable on its own (unit tests).
  let exitHook = () => {};

  function setExitHook(fn) {
    exitHook = typeof fn === "function" ? fn : () => {};
  }

  // A2/D1: single pane lookup via the O(1) config index.
  function findPaneById(paneId, dashboardId) {
    const idx = getConfigIndex();
    const hit = idx && idx.get(paneId);
    if (!hit) return null;
    if (dashboardId && hit.dash.id !== dashboardId) return null;
    return hit.pane;
  }

  // D5: lifecycle transitions write config.json immediately (not the 150ms
  // debounce used for high-frequency field edits).
  function patchPane(paneId, patch) {
    const idx = getConfigIndex();
    const hit = idx && idx.get(paneId);
    if (hit) Object.assign(hit.pane, patch);
    saveConfig(loadConfig(), { immediate: true });
  }

  // D3: a single, first-class failure model.
  function failPane(paneId, reason) {
    const idx = getConfigIndex();
    const hit = idx && idx.get(paneId);
    if (hit) {
      hit.pane.status = "error";
      hit.pane.error = reason;
      hit.pane.instanceId = null;
      hit.pane.exitCode = null;
    }
    log("error", `pane ${paneId} failed: ${reason}`);
    saveConfig(loadConfig(), { immediate: true });
  }

  // Q6: full-transcript retrieval for a running/exited instance.
  function getTranscript(paneId) {
    const inst = instances.get(paneId);
    if (!inst || !inst.transcript) return "";
    return inst.transcript.toString();
  }

  // A1: spawn + register a Kilo agent, persist its running state. Every spawn
  // site (POST /api/instances, restart, autostart, Q1 auto-restart) calls this.
  function startInstance(pane, { rows, cols } = {}, { isAutoRestart = false } = {}) {
    if (pane._restartTimer) { clearTimeout(pane._restartTimer); pane._restartTimer = null; }
    const existing = instances.get(pane.id);
    if (existing) {
      try { existing.ws && existing.ws.close(); } catch { /* ignore */ }
      killInstance(existing);
    }
    instances.delete(pane.id);

    let inst;
    try {
      inst = spawnKilo({
        paneId: pane.id,
        mode: pane.mode,
        dir: pane.dir,
        model: pane.model,
        agent: pane.agent,
        auto: pane.auto,
        sessionId: pane.sessionId,
        task: pane.task,
        rows,
        cols,
        onStatus: (status, code, errMsg) => {
          patchPane(pane.id, { status, exitCode: code, error: errMsg ?? pane.error, instanceId: pane.id });
        },
        // A3: a natural exit would otherwise leave the inst in the Map forever.
        onExit: (code, exited) => {
          if (instances.get(pane.id) !== exited) return;
          if (!exited.ws) instances.delete(pane.id);
          exitHook(pane.id, exited, code, exited);
        },
      });
    } catch (e) {
      log("error", `spawn failed for pane ${pane.id} (mode=${pane.mode}): ${e}`);
      throw e;
    }

    // Q6: capture every byte the PTY emits so the full transcript is available
    // even after the client's scrollback has rolled over.
    inst.transcript = makeTranscriptRing();
    try { inst.pty.on("data", (d) => inst.transcript.append(d)); } catch {}

    instances.set(pane.id, inst);
    log("info", `spawned pane ${pane.id} (mode=${pane.mode}${pane.model ? ", model=" + pane.model : ""}${pane.agent ? ", agent=" + pane.agent : ""})`);

    // persist pane settings so layout/autostart survive reloads
    patchPane(pane.id, {
      mode: pane.mode,
      dir: pane.dir,
      model: pane.model,
      agent: pane.agent,
      auto: pane.auto,
      sessionId: pane.sessionId,
      task: pane.task,
      instanceId: pane.id,
      status: "running",
      exitCode: null,
      error: null,
      // Q1: a normal (user-driven) start resets the retry counter; an
      // auto-restart keeps the already-incremented count so the cap is honoured.
      autoRestartAttempts: isAutoRestart ? (pane.autoRestartAttempts || 0) : 0,
    });
    return { instanceId: pane.id, wsPath: "/ws/" + pane.id };
  }

  // Stop a pane deliberately (user action / shutdown). Flags the instance so a
  // crash in flight isn't mistaken for a spontaneous exit by Q1's auto-restart.
  function stopInstance(paneId) {
    const pending = findPaneById(paneId);
    if (pending && pending._restartTimer) {
      clearTimeout(pending._restartTimer);
      pending._restartTimer = null;
    }
    const inst = instances.get(paneId);
    if (inst) {
      try { inst._intentionalStop = true; } catch {}
      killInstance(inst);
    }
    instances.delete(paneId);
    patchPane(paneId, { instanceId: null, status: "stopped", exitCode: null });
  }

  return {
    instances,
    findPaneById,
    patchPane,
    failPane,
    getTranscript,
    startInstance,
    stopInstance,
    setExitHook,
    killInstance,
    resizeInstance,
  };
}
