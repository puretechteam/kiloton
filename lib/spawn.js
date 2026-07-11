import pty from "node-pty";
import { execSync, exec, execFile } from "child_process";
import fs from "fs";
import path from "path";
import { createRequire } from "module";

import { cleanDir } from "./dir.js";
import { log } from "./log.js";

const require = createRequire(import.meta.url);

let kiloBinCache = null;
let kiloVersionCache = null;

function resolveKiloBin() {
  // Honor an explicit KILO_BIN_PATH as-is: if the operator pointed at a
  // specific binary we must use it (and let a missing/!executable one fail the
  // spawn and surface a real `error` status) rather than silently falling back.
  if (process.env.KILO_BIN_PATH) {
    return process.env.KILO_BIN_PATH;
  }
  // Prefer a local install (no process spawn needed).
  try {
    return require.resolve("@kilocode/cli/bin/kilo");
  } catch {}
  // Fall back to the global npm root. This spawns `npm`, so resolve lazily on
  // first use and cache the result instead of blocking at import time.
  try {
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    const candidate = path.join(root, "@kilocode/cli/bin/kilo");
    if (fs.existsSync(candidate)) return candidate;
  } catch {}
  return "kilo";
}

export function getKiloBin() {
  if (kiloBinCache === null) kiloBinCache = resolveKiloBin();
  return kiloBinCache;
}

// A4: return the argv needed to run the Kilo CLI. When the resolved bin is a
// path/JS file we must spawn it via `node`; when it's a bare command name
// (the `kilo` fallback from `resolveKiloBin`, e.g. on a machine with no local
// or global install) we run it directly. Returning `[process.execPath,
// "kilo"]` would make `pty.spawn(node, ["kilo", ...])` try to `require` a JS
// file called "kilo" and fail.
function binIsPath(bin) {
  return bin.includes("/") || bin.includes("\\") || path.isAbsolute(bin);
}

export function getKiloCommand() {
  const bin = getKiloBin();
  if (binIsPath(bin)) return [process.execPath, bin];
  return [bin];
}

// E5: resolve the kilo binary once at server boot (instead of lazily on the
// first spawn) and warn loudly if it can't be found, so a missing binary
// surfaces as a clear startup message rather than a confusing spawn failure.
export function resolveKiloBinAtBoot() {
  const bin = getKiloBin();
  if (bin === "kilo") {
    log("warn", "kilo binary not found locally or globally; will rely on the `kilo` command on PATH. If kilo is not installed/on PATH, spawns will fail.");
    return bin;
  }
  if (binIsPath(bin) && !fs.existsSync(bin)) {
    log("warn", `resolved kilo binary path does not exist: ${bin}`);
    return bin;
  }
  log("info", `kilo binary resolved at boot: ${bin}`);
  return bin;
}

// Reports the installed Kilo CLI version (or null). Reads the package.json next
// to the resolved bin; falls back to `npm ls -g` if it can't be located.
export function getKiloVersion() {
  if (kiloVersionCache !== null) return kiloVersionCache;
  const bin = getKiloBin();
  if (bin && bin.includes("@kilocode/cli")) {
    try {
      const pkgPath = path.join(path.dirname(path.dirname(bin)), "package.json");
      if (fs.existsSync(pkgPath)) {
        const v = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
        if (v) { kiloVersionCache = v; return v; }
      }
    } catch {}
  }
  try {
    const out = execSync("npm ls -g @kilocode/cli --depth=0", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: true,
    });
    const m = out.match(/@kilocode\/cli@([\d.]+)/);
    if (m) { kiloVersionCache = m[1]; return m[1]; }
  } catch {}
  kiloVersionCache = null;
  return null;
}

// Latest published version on the registry (or null if offline/unreachable).
export function getLatestKiloVersion() {
  return new Promise((resolve) => {
    exec("npm view @kilocode/cli version", { encoding: "utf8", timeout: 20000 }, (err, stdout) => {
      resolve(err ? null : (stdout || "").trim() || null);
    });
  });
}

export function resetKiloBinCache() {
  kiloBinCache = null;
  kiloVersionCache = null;
}

export function buildArgs({ mode, dir, model, agent, auto, sessionId, task }) {
  const args = [];
  if (sessionId) args.push("-s", sessionId);
  if (mode === "resume") {
    if (sessionId) args.push("--replay");
  } else if (mode === "task") {
    args.push("run");
    if (task && task.length) args.push(task);
    args.push("-i");
    if (auto) args.push("--auto");
    if (dir && fs.existsSync(dir)) args.push("--dir", dir);
  } else {
    // interactive TUI — `dir` is the path kilo should open. Only pass it if it
    // actually exists; otherwise kilo exits immediately on the bad path.
    if (dir && fs.existsSync(dir)) args.push(dir);
  }
  if (model) args.push("-m", model);
  if (agent) args.push("--agent", agent);
  return args;
}

export function spawnKilo(opts) {
  const { paneId, mode, dir: rawDir, model, agent, auto, sessionId, task, rows = 24, cols = 80, onExit, onStatus } = opts;
  // File explorers may copy a path wrapped in quotes; strip them so the
  // directory still resolves. Shared with the client via lib/dir.js.
  const dir = cleanDir(rawDir);
  const args = buildArgs({ mode, dir, model, agent, auto, sessionId, task });
  // B4: don't leak Kiloton's own server config (port/config path/fake-bin
  // override) into every spawned agent. Provider keys such as
  // ANTHROPIC_API_KEY don't start with KILOTON_ and are preserved.
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === "KILOTON_PORT" || k === "KILOTON_CONFIG" || k === "KILOTON_HOST" ||
        k === "KILO_BIN_PATH" || k === "KILOTON_NO_OPEN" || k === "KILOTON_NO_ORIGIN_CHECK" ||
        k.startsWith("KILOTON_")) {
      delete env[k];
    }
  }
  const [cmd, ...cmdArgs] = getKiloCommand();
  const ptyProc = pty.spawn(cmd, [...cmdArgs, ...args], {
    name: "xterm-256color",
    cols: cols,
    rows: rows,
    cwd: dir && fs.existsSync(dir) ? dir : (process.env.USERPROFILE || process.env.HOME || process.cwd()),
    env,
  });

  const inst = {
    paneId,
    pty: ptyProc,
    status: "running",
    exitCode: null,
    ws: null,
  };

  const forward = (d) => {
    if (inst.ws && inst.ws.readyState === 1) inst.ws.send(d);
  };
  ptyProc.on("data", forward);
  let ended = false;
  const finalize = (status, code, errMsg) => {
    if (ended) return;
    ended = true;
    inst.status = status;
    inst.exitCode = code;
    if (errMsg != null) inst.error = errMsg;
    if (inst.ws && inst.ws.readyState === 1) {
      inst.ws.send(JSON.stringify({ type: "status", status: inst.status, exitCode: code }));
    }
    if (onStatus) onStatus(inst.status, code, errMsg);
    if (onExit) onExit(code, inst);
    log("info", `pane ${paneId} ${status}${code != null ? " (code=" + code + ")" : ""}${errMsg ? ": " + errMsg : ""}`);
  };
  ptyProc.on("error", (err) => {
    const msg = String(err && err.message ? err.message : err);
    log("error", `pane ${paneId} pty error: ${msg}`);
    finalize("error", null, msg);
  });
  ptyProc.on("exit", (code) => {
    finalize("exited", code, null);
  });

  return inst;
}

export function killInstance(inst) {
  if (!inst || !inst.pty) return;
  log("info", `killing pane ${inst.paneId}`);
  try {
    inst.pty.removeAllListeners("exit");
    inst.pty.removeAllListeners("data");
    const pid = inst.pty.pid;
    inst.pty.kill();
    // Best-effort: kill the whole process tree so child kilo agents (which
    // hold kilo.exe open) don't linger as orphans and keep the binary locked.
    // On Windows the OS ignores negative-pid signals, so use taskkill to walk
    // the tree; on POSIX a negative pid targets the process group.
    if (pid) {
      if (process.platform === "win32") {
        try { execFile("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true }); } catch {}
      } else {
        try { process.kill(-pid, "SIGKILL"); } catch {}
      }
    }
  } catch {
    // ignore
  }
}

export function resizeInstance(inst, cols, rows) {
  if (!inst || !inst.pty) return;
  try {
    inst.pty.resize(cols, rows);
  } catch {
    // ignore
  }
}
