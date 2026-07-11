// Q1 — opt-in auto-restart of crashed agents, with exponential backoff and a
// retry cap.
//
// Wired in as startInstance's exit hook (see state.js). Policy:
//   - only panes with `autoRestart: true` are considered;
//   - an intentional stop (`_intentionalStop`) never triggers a restart;
//   - a *clean* exit (code 0) is treated as "the agent is done", not a crash;
//   - a crash (non-zero exit) schedules a restart after `base * 2^(n-1)` ms,
//     capped at `maxDelay`, up to `maxAttempts` times; beyond that the pane is
//     left stopped so we don't loop forever.
//
// The retry count is persisted on the pane (`autoRestartAttempts`) and surfaced
// in the UI via the pane's `error` field during the backoff window.

export function createAutoRestart({ startInstance, findPaneById, patchPane, log }) {
  const MAX_ATTEMPTS = 5;
  const BASE_DELAY = 2000;   // 2s
  const MAX_DELAY = 60000;   // 60s ceiling

  function onExit(paneId, inst, code) {
    const pane = findPaneById(paneId);
    if (!pane || !pane.autoRestart) return;
    if (inst && inst._intentionalStop) return; // user stopped it
    if (code === 0) return;                    // clean exit — not a crash

    const attempts = (pane.autoRestartAttempts || 0) + 1;
    if (attempts > MAX_ATTEMPTS) {
      log("warn", `pane ${paneId} auto-restart gave up after ${MAX_ATTEMPTS} attempts (last exit ${code})`);
      patchPane(paneId, {
        autoRestartAttempts: attempts,
        status: "stopped",
        exitCode: code,
        instanceId: null,
        error: `crashed (exit ${code}) and auto-restart gave up after ${MAX_ATTEMPTS} attempts`,
      });
      return;
    }

    const delay = Math.min(MAX_DELAY, BASE_DELAY * 2 ** (attempts - 1));
    log("info", `pane ${paneId} crashed (exit ${code}) — auto-restart ${attempts}/${MAX_ATTEMPTS} in ${delay}ms`);
    patchPane(paneId, {
      autoRestartAttempts: attempts,
      status: "error",
      exitCode: code,
      error: `crashed (exit ${code}) — auto-restarting ${attempts}/${MAX_ATTEMPTS} in ${Math.round(delay / 1000)}s…`,
    });

    const t = setTimeout(() => {
      const p = findPaneById(paneId);
      if (!p || !p.autoRestart) return;
      p._restartTimer = null;
      try {
        startInstance(p, {}, { isAutoRestart: true });
      } catch (e) {
        // A failed respawn reschedules on the next natural exit; log and stop
        // here so a throw doesn't crash the timer callback.
        log("error", `auto-restart spawn failed for pane ${paneId}: ${e}`);
      }
    }, delay);
    pane._restartTimer = t;
  }

  return { onExit, MAX_ATTEMPTS, BASE_DELAY, MAX_DELAY };
}
