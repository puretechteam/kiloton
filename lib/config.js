import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.KILOTON_CONFIG
  ? path.resolve(process.env.KILOTON_CONFIG)
  : path.join(__dirname, "..", "config.json");

const DEFAULT_CONFIG = { kiloBin: "auto", autostart: false, dashboards: [] };

let cache = null;
let saveTimer = null;

function readFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function loadConfig() {
  if (!cache) cache = readFromDisk();
  return cache;
}

export function saveConfig(cfg) {
  cache = { ...DEFAULT_CONFIG, ...cfg };
  // Debounce disk writes: many panes start at once and each persists its
  // settings, so coalesce those into a single write shortly after.
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cache, null, 2)); } catch {}
  }, 150);
  return cache;
}

export function flushConfig() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (cache) {
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cache, null, 2)); } catch {}
  }
}
