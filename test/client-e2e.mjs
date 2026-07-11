// Client smoke E2E for Kiloton (kiloton-improvements-plan.md Q4/Q5/Q7/Q9/B3/Q10).
//
// Boots the REAL client (public/app.js) inside jsdom with stubbed
// fetch/WebSocket/ResizeObserver/requestAnimationFrame/setInterval, then drives
// and asserts the new client features end-to-end without a real browser:
//   - Q4  duplicatePane
//   - Q7  per-pane label persistence
//   - Q5  client-side pane filter (applyFilter)
//   - Q10 health summary (loadHealth)
//   - B3  copy/paste wiring (silent execCommand path)
//   - Q9  shortcut help overlay (toggleShortcuts)
//
// The internal functions are module-scoped, so we append a tiny
// `globalThis.__kilotonApp` handle to a temp copy of app.js (the same
// import-rewrite trick test/b1-mouse.mjs uses) — the real source is untouched.
//
// Run: node test/client-e2e.mjs   (or: npm test)

import { JSDOM } from "jsdom";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = readFileSync(join(ROOT, "public", "index.html"), "utf8");

// Swallow async errors from boot paths we don't fully drive so the assertions
// below still run.
process.on("unhandledRejection", () => {});

const dom = new JSDOM(HTML, { url: "http://localhost:7655/", pretendToBeVisual: true });
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
globalThis.location = window.location;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} addEventListener() {} };
globalThis.setInterval = () => 0; // don't keep the process alive in CI

// --- spy Terminal ---
window.Terminal = class {
  constructor(opts) { this.opts = opts; window.Terminal.lastOpts = opts; window.Terminal.instances.push(this); }
  open() {} onData() {} onSelectionChange() {} onResize() {} attachCustomKeyEventHandler() {}
  resize() {} dispose() {} write() {} clear() {} getSelection() { return ""; } selectAll() {} focus() { this.focused = true; }
};
window.Terminal.instances = [];
window.Terminal.lastOpts = null;

// --- record clipboard calls ---
const execCommandCalls = [];
const clipboardWrites = [];
window.document.execCommand = (cmd) => { execCommandCalls.push(cmd); return true; };
try { window.navigator.clipboard = { writeText: (t) => { clipboardWrites.push(t); return Promise.resolve(); } }; } catch {}

// --- stubbed API ---
const CONFIG = {
  activeDashId: "d1",
  dashboards: [
    {
      id: "d1", name: "Main", cols: 2, rows: 1,
      panes: [
        { id: "p1", name: "One", mode: "interactive", dir: "projA", model: "m1", agent: "a1", auto: false, sessionId: null, task: "t1", label: "L1", instanceId: null, status: "stopped", exitCode: null },
        { id: "p2", name: "Two", mode: "task", dir: "projB", model: null, agent: null, auto: false, sessionId: null, task: "say hi", label: null, instanceId: "inst-2", status: "running", exitCode: null },
      ],
    },
  ],
};
const INSTANCES = [
  { paneId: "p1", status: "running", exitCode: null },
  { paneId: "p2", status: "exited", exitCode: 0 },
];
async function fakeFetch(url) {
  if (url.includes("/api/config")) return { ok: true, json: async () => CONFIG, text: async () => JSON.stringify(CONFIG) };
  if (url.includes("/api/instances") && url.includes("transcript")) {
    return { ok: true, text: async () => "KILOTON_CLIENT_TRANSCRIPT\nline2", json: async () => ({}) };
  }
  if (url.includes("/api/instances")) return { ok: true, json: async () => INSTANCES, text: async () => JSON.stringify(INSTANCES) };
  if (url.includes("/api/sessions")) return { ok: true, json: async () => [], text: async () => "[]" };
  if (url.includes("/api/version") || url.includes("/kilo")) return { ok: true, json: async () => ({ version: "0.2.0" }), text: async () => JSON.stringify({ version: "0.2.0" }) };
  return { ok: true, json: async () => ({}), text: async () => "{}" };
}
globalThis.fetch = fakeFetch;
window.fetch = fakeFetch;

// Rewrite the absolute "/lib/dir.js" import to a real file URL, and append a
// handle exposing the module's internal functions so we can drive them.
const appSrc = readFileSync(join(ROOT, "public", "app.js"), "utf8");
const dirUrl = JSON.stringify(pathToFileURL(join(ROOT, "lib", "dir.js")).href);
const instrumented =
  appSrc.replace('"/lib/dir.js"', dirUrl) +
  "\nglobalThis.__kilotonApp = { duplicatePane, applyFilter, loadHealth, copyText, toggleShortcuts, getState: () => state, copyTranscript, downloadTranscript, applyRemoteConfig, broadcastConfig, syncConnections, setupTabSync, pushScrollback, getScrollback, rememberDir, ensureRecentDirs };\n";
const tmp = join(ROOT, "test", ".client-e2e-app.tmp.mjs");
writeFileSync(tmp, instrumented);

let bootError = null;
try {
  await import(pathToFileURL(tmp).href);
  // boot() is async and not awaited by the module; let config/render settle.
  await new Promise((r) => setTimeout(r, 300));
} catch (e) {
  bootError = e;
} finally {
  try { unlinkSync(tmp); } catch {}
}

const app = () => globalThis.__kilotonApp;

test("client boots without throwing", () => {
  assert.ok(!bootError, "boot() threw: " + (bootError && bootError.stack));
  assert.ok(app(), "internal app handle not exposed");
});

test("Q4: duplicatePane clones mode/dir/model/agent/task/label into a new pane", () => {
  const state = app().getState();
  const dash = state.config.dashboards[0];
  const src = dash.panes[0];
  const before = dash.panes.length;
  app().duplicatePane(src);
  const after = state.config.dashboards[0].panes;
  assert.strictEqual(after.length, before + 1, "a new pane was added");
  const np = after.find((p) => p.id !== src.id && p.mode === src.mode && p.dir === src.dir && p.model === src.model && p.agent === src.agent && p.task === src.task && p.label === src.label);
  assert.ok(np, "new pane copied mode/dir/model/agent/task/label from source");
});

test("Q7: per-pane label handler stores the label on the pane", () => {
  const state = app().getState();
  const pane = state.config.dashboards[0].panes[0];
  const input = document.querySelector(`#grid .pane[data-pane="${pane.id}"] .label`);
  assert.ok(input, "label input present in pane");
  input.value = "merged-notes";
  input.dispatchEvent(new window.Event("change"));
  assert.strictEqual(pane.label, "merged-notes", "label persisted to pane object via onchange handler");
});

test("Q5: applyFilter hides non-matching panes and keeps matching visible", () => {
  const state = app().getState();
  state.filter = "projA";
  app().applyFilter();
  const p1 = document.querySelector('#grid .pane[data-pane="p1"]');
  const p2 = document.querySelector('#grid .pane[data-pane="p2"]');
  assert.ok(p1 && p1.style.display !== "none", "matching pane (projA) stays visible");
  assert.ok(p2 && p2.style.display === "none", "non-matching pane (projB) is hidden");
  state.filter = "";
  app().applyFilter();
});

test("Q10: loadHealth renders running/exited counts from /api/instances", async () => {
  await app().loadHealth();
  const health = document.getElementById("health");
  assert.ok(health, "#health element present");
  const txt = health.textContent || "";
  assert.match(txt, /1\s*running/i, "shows 1 running");
  assert.match(txt, /1\s*exited/i, "shows 1 exited");
});

test("B3: copyText uses the silent execCommand path, not navigator.clipboard.writeText", () => {
  execCommandCalls.length = 0;
  clipboardWrites.length = 0;
  app().copyText("hello-clip");
  assert.ok(execCommandCalls.includes("copy"), "document.execCommand('copy') was invoked (silent path)");
  assert.strictEqual(clipboardWrites.length, 0, "navigator.clipboard.writeText was NOT the primary path");
});

test("Q9: toggleShortcuts(true) reveals the shortcut help overlay", () => {
  const el = document.getElementById("shortcutHelp");
  assert.ok(el, "#shortcutHelp element present");
  assert.ok(el.classList.contains("hidden"), "overlay starts hidden");
  app().toggleShortcuts(true);
  assert.ok(!el.classList.contains("hidden"), "overlay shown after toggleShortcuts(true)");
});

test("Q6: copyTranscript fetches the pane transcript and copies it", async () => {
  execCommandCalls.length = 0;
  clipboardWrites.length = 0;
  await app().copyTranscript({ id: "p1" });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(execCommandCalls.includes("copy"), "document.execCommand('copy') invoked (fetched + copied)");
  assert.strictEqual(clipboardWrites.length, 0, "navigator.clipboard.writeText not the primary path");
});

test("Q6: downloadTranscript builds a Blob and triggers a download", async () => {
  const origBlob = window.Blob;
  const origCreate = window.URL.createObjectURL;
  const origRevoke = window.URL.revokeObjectURL;
  const origClick = window.HTMLAnchorElement.prototype.click;
  let blobParts = null;
  window.Blob = class { constructor(parts) { this.parts = parts; blobParts = parts; } };
  window.URL.createObjectURL = () => "blob:fake";
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () {};
  try {
    await app().downloadTranscript({ id: "p1" });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(blobParts, "a Blob was constructed from the transcript");
    assert.ok(blobParts.join("").includes("KILOTON_CLIENT_TRANSCRIPT"), "blob body contains the fetched transcript");
  } finally {
    window.Blob = origBlob;
    window.URL.createObjectURL = origCreate;
    window.URL.revokeObjectURL = origRevoke;
    window.HTMLAnchorElement.prototype.click = origClick;
  }
});

test("QoL: #recentDirs datalist exists after a pane is built and seeds its dir", () => {
  const list = document.getElementById("recentDirs");
  assert.ok(list, "#recentDirs datalist is created on build");
  const opts = [...list.options].map((o) => o.value);
  // p1/p2 in CONFIG carry dir "projA"/"projB"; buildPane seeds them.
  assert.ok(opts.includes("projA"), "#recentDirs seeded with pane dir 'projA'");
});

test("QoL: changing a pane's Dir adds a deduped <option> to #recentDirs", () => {
  const state = app().getState();
  const pane = state.config.dashboards[0].panes[0];
  const dirInput = document.querySelector(`#grid .pane[data-pane="${pane.id}"] .dir`);
  assert.ok(dirInput, "Dir input present in pane");
  const newDir = "/fresh/recent-dir-" + Date.now();
  dirInput.value = newDir;
  dirInput.dispatchEvent(new window.Event("change"));
  const list = document.getElementById("recentDirs");
  const opts = [...list.options].map((o) => o.value);
  assert.ok(opts.includes(newDir), `#recentDirs gained an <option> for the typed dir (${JSON.stringify(opts)})`);
  // typing the same dir again must NOT create a duplicate option.
  const before = list.options.length;
  dirInput.dispatchEvent(new window.Event("change"));
  assert.strictEqual(list.options.length, before, "re-typing the same dir does not duplicate the option");
});

test("Q2: getScrollback returns raw PTY chunks joined in FIFO order", () => {
  const id = "sb-test-" + Date.now();
  app().pushScrollback(id, "first chunk\n");
  app().pushScrollback(id, "second chunk");
  const out = app().getScrollback(id);
  assert.strictEqual(out, "first chunk\nsecond chunk", "getScrollback joins captured chunks verbatim");
  app().pushScrollback(id, "");
  assert.strictEqual(app().getScrollback(id), "first chunk\nsecond chunk", "empty push is ignored");
});

test("Q8: applyRemoteConfig swaps state.config and re-renders without throwing", () => {
  const remoteCfg = JSON.parse(JSON.stringify(app().getState().config));
  remoteCfg.dashboards.push({
    id: "d_remote", name: "Remote", rows: 1, cols: 1,
    panes: [{ id: "pr1", name: "R", mode: "interactive", dir: "x", model: null, agent: null, auto: false, sessionId: null, task: null, label: null, instanceId: null, status: "stopped", exitCode: null }],
  });
  assert.doesNotThrow(() => app().applyRemoteConfig(remoteCfg), "applyRemoteConfig does not throw");
  assert.strictEqual(app().getState().config, remoteCfg, "state.config swapped to the remote config");
  assert.ok(document.querySelector('#tabs .tab[data-dash="d_remote"]'), "new dashboard tab rendered for the remote config");
});

test("Q8: broadcastConfig posts the current config over the sync channel", () => {
  const origBC = window.BroadcastChannel;
  const msgs = [];
  window.BroadcastChannel = class {
    constructor(name) { this.name = name; }
    postMessage(m) { msgs.push(m); }
    close() {}
  };
  try {
    app().setupTabSync();
    app().broadcastConfig();
    assert.ok(msgs.length >= 1, "BroadcastChannel.postMessage was called");
    const m = msgs[msgs.length - 1];
    assert.strictEqual(m.type, "config", "message type is 'config'");
    assert.deepStrictEqual(m.config, app().getState().config, "message carries the current config");
  } finally {
    window.BroadcastChannel = origBC;
  }
});
