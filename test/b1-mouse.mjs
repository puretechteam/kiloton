// Automated regression test for the B1 terminal-mouse fix (kiloton-improvements-plan.md §8).
//
// B1 can't be fully exercised without a real browser + a PTY app (vim/htop), but
// the actual code change is verifyable headlessly: the xterm Terminal must be
// constructed with `allowProposedApi: true` and `term.focus()` must be called on
// (re)attach, otherwise mouse events never reach the PTY. We boot the real
// client (public/app.js) inside jsdom with a spy Terminal + stubbed fetch, then
// assert the wiring is present.
//
// Run: node test/b1-mouse.mjs   (or: npm run test:b1)

import { JSDOM } from "jsdom";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = readFileSync(join(ROOT, "public", "index.html"), "utf8");

// Swallow any async errors from boot paths we don't fully drive (e.g. a missing
// element in this minimal harness) so the Terminal assertions below still run.
process.on("unhandledRejection", () => {});

const dom = new JSDOM(HTML, { url: "http://localhost:7655/", pretendToBeVisual: true });
const { window } = dom;

// --- globals the client expects ---
globalThis.window = window;
globalThis.document = window.document;
globalThis.location = window.location;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} addEventListener() {} };
globalThis.setInterval = () => 0; // don't keep the process alive in CI

// --- spy Terminal: records options + focus() calls ---
window.Terminal = class {
  constructor(opts) {
    this.opts = opts;
    window.Terminal.lastOpts = opts;
    window.Terminal.instances.push(this);
    this.focusCount = 0;
  }
  open(el) { this.element = el; }
  onData() {}
  onSelectionChange() {}
  onResize() {}
  attachCustomKeyEventHandler() {}
  resize() {}
  dispose() {}
  write() {}
  clear() {}
  getSelection() { return ""; }
  selectAll() {}
  focus() { this.focused = true; this.focusCount++; window.Terminal.focusCalls++; }
};

// Find the fake Terminal instance bound to a given pane's .term element.
function termForPane(paneId) {
  const el = document.querySelector(`[data-pane="${paneId}"] .term`);
  return window.Terminal.instances.find((t) => t.element === el) || null;
}
window.Terminal.instances = [];
window.Terminal.focusCalls = 0;
window.Terminal.lastOpts = null;

// --- stubbed API ---
const CONFIG = {
  activeDashId: "d1",
  dashboards: [
    {
      id: "d1", name: "Main", cols: 2, rows: 2,
      panes: [
        { id: "p_stopped", name: "Stopped", mode: "interactive", dir: "" },
        { id: "p_running", name: "Running", mode: "interactive", dir: "", instanceId: "inst-xyz" },
      ],
    },
  ],
};
async function fakeFetch(url) {
  let body = [];
  if (url.includes("/api/config")) body = CONFIG;
  else if (url.includes("/api/instances")) body = [];
  else if (url.includes("/api/sessions")) body = [];
  else if (url.includes("/api/version") || url.includes("/kilo")) body = { version: "0.2.0" };
  return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
}
globalThis.fetch = fakeFetch;
window.fetch = fakeFetch;

// Rewrite the absolute "/lib/dir.js" import to a real file URL so the module
// loads under Node, then boot the client via a temp copy.
const appSrc = readFileSync(join(ROOT, "public", "app.js"), "utf8");
const dirUrl = JSON.stringify(pathToFileURL(join(ROOT, "lib", "dir.js")).href);
const tmp = join(ROOT, "test", ".b1-app.tmp.mjs");
writeFileSync(tmp, appSrc.replace('"/lib/dir.js"', dirUrl));

let bootError = null;
try {
  await import(pathToFileURL(tmp).href);
  // boot() is async and not awaited by the module; let render/buildPane settle.
  await new Promise((r) => setTimeout(r, 150));
} catch (e) {
  bootError = e;
} finally {
  try { unlinkSync(tmp); } catch {}
}

test("B1: client boots and constructs at least one Terminal", () => {
  assert.ok(!bootError, "boot() threw: " + (bootError && bootError.stack));
  assert.ok(window.Terminal.instances.length > 0, "expected a Terminal to be constructed during render");
});

test("B1: Terminal is constructed with allowProposedApi (enables mouse reporting)", () => {
  assert.ok(window.Terminal.lastOpts, "no Terminal options captured");
  assert.strictEqual(
    window.Terminal.lastOpts.allowProposedApi,
    true,
    "Terminal options must include allowProposedApi: true so xterm forwards mouse events to the PTY",
  );
});

test("B1: term.focus() is called on (re)attach (canvas must receive mouse events)", () => {
  assert.ok(window.Terminal.focusCalls > 0, "term.focus() was never called on attach");
});

// xterm v5 only forwards mouse/wheel reports to the PTY while its helper
// textarea is focused (xterm.js: focus() focuses the textarea; isFocused =
// _isFocused && document.hasFocus()). The fix re-focuses the terminal on any
// pointer interaction, so a lost-focus state (re-render, focusout, clicking
// away and back) can never leave mouse reporting dead. These tests prove the
// wiring is present: a mousedown / focusin on the terminal element must call
// term.focus() again. (A real browser + vim/htop is still the final check.)
test("B1: term.focus() is re-called on mousedown of the terminal (lost-focus recovery)", () => {
  const inst = termForPane("p_running");
  assert.ok(inst, "running pane terminal instance not found");
  const before = inst.focusCount;
  inst.element.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
  assert.ok(inst.focusCount > before, "term.focus() was not called on mousedown of the terminal element");
});

test("B1: term.focus() is re-called on focusin of the terminal", () => {
  const inst = termForPane("p_running");
  assert.ok(inst, "running pane terminal instance not found");
  const before = inst.focusCount;
  inst.element.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
  assert.ok(inst.focusCount > before, "term.focus() was not called on focusin of the terminal element");
});

test("overlay is hidden for a running pane so it never intercepts mouse clicks", () => {
  const overlay = document.querySelector('[data-pane="p_running"] .overlay');
  assert.ok(overlay, "running pane overlay element not found");
  assert.ok(overlay.classList.contains("hidden"), "running pane overlay should have .hidden (display:none)");
});
