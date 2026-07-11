import { execFile } from "child_process";

// Kill every running kilo process on the machine (not just tracked instances),
// so the global `npm install -g @kilocode/cli` can replace the binary cleanly,
// and so a crashed server session doesn't leave orphaned Kilo processes that a
// fresh autostart would duplicate.
export function killAllKiloProcesses() {
  if (process.platform === "win32") {
    try { execFile("taskkill", ["/F", "/IM", "kilo.exe"], { windowsHide: true }); } catch {}
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { ($_.CommandLine -like '*@kilocode/cli*' -or $_.CommandLine -like '*bin/kilo*') -and $_.CommandLine -notlike '*server.js*' } | ForEach-Object { taskkill /F /PID $_.ProcessId }";
    try { execFile("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true }); } catch {}
    return;
  }
  // POSIX (Linux/macOS): kill any process whose command line references the
  // Kilo CLI. Target `@kilocode/cli` and the `bin/kilo` entry point, but never
  // the Kiloton server (server.js). `pkill` exits non-zero when nothing
  // matches, so swallow the error.
  try { execFile("pkill", ["-f", "@kilocode/cli"]); } catch {}
  try { execFile("pkill", ["-f", "bin/kilo"]); } catch {}
}
