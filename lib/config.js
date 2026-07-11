import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.KILOTON_CONFIG
  ? path.resolve(process.env.KILOTON_CONFIG)
  : path.join(__dirname, "..", "config.json");

const DEFAULT_CONFIG = { kiloBin: "auto", autostart: false, dashboards: [] };

let cache = null;
let saveTimer = null;
let configIndex = null;
let indexedCache = null;

function readFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const cfg = { ...DEFAULT_CONFIG, ...raw };
    const ok =
      typeof cfg === "object" && cfg !== null &&
      Array.isArray(cfg.dashboards) &&
      cfg.dashboards.every((d) => d && Array.isArray(d.panes));
    if (!ok) {
      log("warn", "config.json parsed but is malformed (dashboards/panes not iterable); using default config");
      return structuredClone(DEFAULT_CONFIG);
    }
    return cfg;
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

// D1: a `Map<paneId, {dash, pane}>` so pane lookups are O(1) instead of a
// linear scan of every dashboard on every status event. Rebuilt whenever the
// cached config object is (re)assigned, so the references always point at the
// live pane objects a caller may have mutated in place.
function rebuildIndex() {
  configIndex = new Map();
  if (cache && Array.isArray(cache.dashboards)) {
    for (const dash of cache.dashboards) {
      if (!dash || !Array.isArray(dash.panes)) continue;
      for (const pane of dash.panes) {
        if (pane && pane.id != null) configIndex.set(pane.id, { dash, pane });
      }
    }
  }
  indexedCache = cache;
}

export function getConfigIndex() {
  return configIndex;
}

export function loadConfig() {
  if (!cache) {
    cache = readFromDisk();
    rebuildIndex();
  } else if (cache !== indexedCache) {
    rebuildIndex();
  }
  return cache;
}

function writeConfig() {
  if (!cache) return;
  try {
    // Strip underscore-prefixed runtime fields (e.g. pane._restartTimer, a
    // Node Timeout object) so they never get persisted into config.json. The
    // in-memory config is left untouched.
    const serializable = { ...cache };
    serializable.dashboards = (cache.dashboards || []).map((dash) => ({
      ...dash,
      panes: (dash.panes || []).map((pane) => {
        const clean = { ...pane };
        for (const k of Object.keys(clean)) if (k.startsWith("_")) delete clean[k];
        return clean;
      }),
    }));
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(serializable, null, 2));
  } catch {}
}

export function saveConfig(cfg, opts = {}) {
  cache = { ...DEFAULT_CONFIG, ...cfg };
  rebuildIndex();
  // D5: high-frequency field edits (POST /api/config) keep the 150ms debounce,
  // but the important lifecycle transitions (start/stop/exit, set via
  // `immediate`) flush to disk synchronously so a crash can't drop them.
  if (opts.immediate) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    writeConfig();
  } else {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeConfig();
    }, 150);
  }
  return cache;
}

export function flushConfig() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writeConfig();
}
