import pty from "node-pty";
import { execSync, exec, execFile } from "child_process";
import fs from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

let kiloBinCache = null;

function resolveKiloBin() {
  if (process.env.KILO_BIN_PATH && fs.existsSync(process.env.KILO_BIN_PATH)) {
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

export function getKiloCommand() {
  return [process.execPath, getKiloBin()];
}

// Reports the installed Kilo CLI version (or null). Reads the package.json next
// to the resolved bin; falls back to `npm ls -g` if it can't be located.
export function getKiloVersion() {
  const bin = getKiloBin();
  if (bin && bin.includes("@kilocode/cli")) {
    try {
      const pkgPath = path.join(path.dirname(path.dirname(bin)), "package.json");
      if (fs.existsSync(pkgPath)) {
        const v = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
        if (v) return v;
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
    if (m) return m[1];
  } catch {}
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
  const { paneId, mode, dir, model, agent, auto, sessionId, task, onExit, onStatus } = opts;
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
  const ptyProc = pty.spawn(process.execPath, [getKiloBin(), ...args], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
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
  ptyProc.on("exit", (code) => {
    inst.status = "exited";
    inst.exitCode = code;
    if (inst.ws && inst.ws.readyState === 1) {
      inst.ws.send(JSON.stringify({ type: "status", status: inst.status, exitCode: code }));
    }
    if (onStatus) onStatus(inst.status, code);
    if (onExit) onExit(code);
    console.log(`[lifecycle] pane ${paneId} exited (code=${code})`);
  });

  return inst;
}

export function killInstance(inst) {
  if (!inst || !inst.pty) return;
  console.log(`[lifecycle] killing pane ${inst.paneId}`);
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
