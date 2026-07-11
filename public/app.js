// Shared with the server (lib/dir.js) so the client and server strip wrapping
// quotes from dir paths the exact same way.
import { cleanDir } from "/lib/dir.js";

const state = {
  config: null,
  sessions: [],
  activeDashId: null,
  focusedPaneId: null,
  live: new Map(), // paneId -> { term, ws, el, statusEl, overlayEl, reconnectAttempts }
  selected: new Set(), // pane ids selected for bulk actions (within the active dashboard)
  selectMode: false, // when true, per-pane checkboxes + bulk action bar are shown
  filter: "", // Q5: client-side pane filter query
};

// Q2: bounded per-pane scrollback captured from PTY output, keyed by paneId so
// it survives a pane being disposed and re-added (xterm's own buffer is lost on
// dispose). Stored as raw PTY chunks (each already carries its own newlines) in
// a FIFO ring capped by total byte size, so a long-lived agent can't grow
// memory without bound and we don't pay per-line split/shift cost on hot output.
const SCROLLBACK_MAX_CHARS = 2000 * 80; // ~2000 lines of terminal output
const scrollback = new Map();

function pushScrollback(paneId, data) {
  if (!paneId || !data) return;
  let buf = scrollback.get(paneId);
  if (!buf) { buf = { parts: [], size: 0 }; scrollback.set(paneId, buf); }
  data = String(data);
  buf.parts.push(data);
  buf.size += data.length;
  while (buf.size > SCROLLBACK_MAX_CHARS && buf.parts.length > 1) {
    buf.size -= buf.parts[0].length;
    buf.parts.shift();
  }
}

// Join the captured chunks back into a single string for replay / copy.
function getScrollback(paneId) {
  const buf = scrollback.get(paneId);
  return buf && buf.parts.length ? buf.parts.join("") : "";
}

// QoL: remember directories typed into any pane's Dir field and surface them as
// browser <datalist> autocomplete suggestions, so a repeated path is a
// one-click fill instead of copy/paste every time.
let recentDirs = null;
function ensureRecentDirs() {
  if (recentDirs) return recentDirs;
  recentDirs = document.createElement("datalist");
  recentDirs.id = "recentDirs";
  document.body.appendChild(recentDirs);
  return recentDirs;
}
function rememberDir(value) {
  const v = cleanDir(value);
  if (!v) return;
  const list = ensureRecentDirs();
  for (const opt of list.options) if (opt.value === v) return;
  const opt = document.createElement("option");
  opt.value = v;
  list.appendChild(opt);
}

// Anchor pane for Shift-click range selection (see selectChk handler).
let lastSelectAnchor = null;

const $ = (sel) => document.querySelector(sel);

function h(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (k === "value") e.value = v;
    // Boolean attributes: only set when truthy, otherwise their mere presence
    // (e.g. selected="false") would still mark the element as selected.
    else if ((k === "selected" || k === "checked" || k === "disabled") && !v) continue;
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

function uid(p) {
  return p + Math.random().toString(36).slice(2, 8);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function loadSessions() {
  try {
    state.sessions = await api("GET", "/api/sessions");
  } catch {
    state.sessions = [];
  }
}

// E3: coalesce config saves so editing several fields / dragging a slider
// produces a single POST (matching the server's own 150ms debounce). A trailing
// flush on pagehide avoids losing the last edit if the tab closes mid-debounce.
let saveTimer = null;
let tabsSig = null;
let selSig = null;
function flushConfigSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  api("POST", "/api/config", state.config).catch(() => {});
  broadcastConfig();
}
function saveConfig() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    api("POST", "/api/config", state.config).catch(() => {});
  }, 200);
  // Q8: let other tabs see this change live.
  broadcastConfig();
  return Promise.resolve();
}

// Q8: cross-tab state sync. Holds the chosen transport (null = use localStorage
// fallback, or neither is available). setupTabSync() populates this.
let tabSyncChannel = null;
let tabSyncUseLs = false;

// Q8: push the current config to other tabs via the active transport.
function broadcastConfig() {
  try {
    const payload = JSON.stringify({ type: "config", config: state.config, ts: Date.now() });
    if (tabSyncChannel) {
      tabSyncChannel.postMessage(JSON.parse(payload));
    } else if (tabSyncUseLs) {
      window.localStorage.setItem("kiloton-sync", payload);
    }
  } catch {}
}

// Q8: apply a config received from another tab and reconcile live connections.
function applyRemoteConfig(cfg) {
  try {
    if (!cfg || !Array.isArray(cfg.dashboards)) return;
    for (const d of cfg.dashboards) {
      if (!d || typeof d !== "object" || !Array.isArray(d.panes)) return;
    }
    state.config = cfg;
    state.activeDashId = cfg.activeDashId || (cfg.dashboards[0] && cfg.dashboards[0].id) || state.activeDashId;
    render();
    syncConnections();
  } catch (e) {
    console.warn("kiloton: ignored invalid remote config", e);
  }
}

// Q8: after a remote layout change, start/stop each pane's terminal socket to
// match its instanceId (e.g. another tab started/stopped the pane).
function syncConnections() {
  for (const d of state.config.dashboards) {
    for (const p of d.panes) {
      const live = state.live.get(p.id);
      if (!live) continue;
      // Trust a live local socket: never tear down a pane that is actually
      // connected here just because a (possibly stale) remote config says the
      // instance is gone — let the server-driven ws close handle real stops.
      if (p.instanceId && !live.ws) {
        live.reconnectAttempts = 0;
        connectWs(p, live);
      }
    }
  }
}

// Q8: wire up cross-tab sync. Prefers BroadcastChannel; falls back to a
// `storage` event on the "kiloton-sync" key. Wrapped so boot never throws.
function setupTabSync() {
  try {
    if ("BroadcastChannel" in window) {
      tabSyncChannel = new window.BroadcastChannel("kiloton-sync");
      tabSyncChannel.onmessage = (ev) => {
        const d = ev.data;
        if (d && d.type === "config") applyRemoteConfig(d.config);
      };
    } else if ("localStorage" in window) {
      tabSyncUseLs = true;
      window.addEventListener("storage", (e) => {
        if (e.key === "kiloton-sync" && e.newValue) {
          try {
            const d = JSON.parse(e.newValue);
            if (d && d.type === "config") applyRemoteConfig(d.config);
          } catch {}
        }
      });
    }
  } catch {}
}

function getActiveDash() {
  return state.config.dashboards.find((d) => d.id === state.activeDashId) || state.config.dashboards[0];
}

function setActiveDash(id) {
  state.activeDashId = id;
  state.config.activeDashId = id;
  // Selection is per-dashboard; leaving a dashboard drops it.
  state.selected.clear();
  state.selectMode = false;
  saveConfig();
  render();
}

/* ---------- rendering ---------- */

function renderTabs() {
  // E2: tabs change rarely — skip the innerHTML rebuild when nothing about the
  // dashboards (id, name, active) has changed since the last render.
  const sig = state.config.dashboards.map((d) => d.id + "|" + d.name + "|" + (d.id === state.activeDashId ? "1" : "0")).join(",");
  if (sig === tabsSig) return;
  tabsSig = sig;
  const tabs = $("#tabs");
  tabs.innerHTML = "";
  for (const d of state.config.dashboards) {
    const nameSpan = h("span", {
      class: "tab-name",
      text: d.name,
      title: "Double-click to rename",
      onclick: () => setActiveDash(d.id),
      ondblclick: () => startRename(d.id),
    });
    const tab = h("div", { class: "tab" + (d.id === state.activeDashId ? " active" : ""), "data-dash": d.id }, [
      nameSpan,
      h("span", {
        class: "rename",
        title: "Rename dashboard",
        text: "✎",
        onclick: (ev) => { ev.stopPropagation(); startRename(d.id); },
      }),
      h("span", {
        class: "close",
        title: "Close dashboard",
        text: "✕",
        onclick: (ev) => { ev.stopPropagation(); closeDashboard(d.id); },
      }),
    ]);
    tabs.appendChild(tab);
  }

  tabs.appendChild(h("div", { class: "tab tab-add", title: "Add dashboard", text: "+", onclick: () => addDashboard() }));
}

function startRename(dashId) {
  const tabs = $("#tabs");
  const tab = tabs.querySelector(`.tab[data-dash="${dashId}"]`);
  if (!tab) return;
  const nameSpan = tab.querySelector(".tab-name");
  if (!nameSpan || tab.querySelector(".tab-rename-input")) return;
  const dash = state.config.dashboards.find((d) => d.id === dashId);
  if (!dash) return;
  const input = h("input", { class: "tab-rename-input", type: "text", value: dash.name });
  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save) {
      const v = input.value.trim();
      if (v) dash.name = v;
      saveConfig();
    }
    renderTabs();
  };
  input.addEventListener("blur", () => commit(true));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(true); }
    else if (e.key === "Escape") { e.preventDefault(); commit(false); }
  });
}

function renderLayoutBar() {
  const dash = getActiveDash();
  $("#rowsInput").value = dash.rows;
  $("#colsInput").value = dash.cols;
}

function renderGrid() {
  const dash = getActiveDash();
  if (!dash) return;
  const grid = $("#grid");
  const activeIds = new Set(dash.panes.map((p) => p.id));

  // Collect pane ids across every dashboard so we don't tear down terminals
  // for dashboards we're just switching away from.
  const allIds = new Set();
  for (const d of state.config.dashboards) for (const p of d.panes) allIds.add(p.id);

  // Tear down terminals whose pane was deleted entirely.
  for (const [id, live] of [...state.live]) {
    if (!allIds.has(id)) {
      try { if (live.ws) live.ws.close(); } catch {}
      // A1: stop the resize observer before disposing the terminal, otherwise
      // it keeps firing fitTerminal against a disposed terminal.
      if (live.resizeObserver) { try { live.resizeObserver.disconnect(); } catch {} }
      try { live.term.dispose(); } catch {}
      if (live.el && live.el.parentNode) live.el.parentNode.removeChild(live.el);
      state.live.delete(id);
      scrollback.delete(id);
    }
  }

  // Keep other dashboards' terminals alive, just detach them from the DOM.
  for (const [id, live] of state.live) {
    if (!activeIds.has(id) && live.el && live.el.parentNode === grid) {
      grid.removeChild(live.el);
    }
  }

  grid.style.gridTemplateColumns = `repeat(${dash.cols}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${dash.rows}, minmax(0, 1fr))`;

  // When the grid layout changes (rows/cols — e.g. the Auto / "auto sort"
  // button, or add/remove pane), every attached pane's on-screen terminal must
  // be re-fit against its NEW size. The ResizeObserver only fires a synchronous
  // fit that can run mid-reflow and measure a transient size, leaving a black
  // gap below the terminal (see the note on fitTerminal/refit). Routing the
  // re-fit through the post-layout requestAnimationFrame below fixes that, so
  // flag every active pane here — not just the ones we (re)attach.
  for (const pane of dash.panes) {
    const live = state.live.get(pane.id);
    if (live) {
      if (live.el.parentNode !== grid) {
        grid.appendChild(live.el);
        // Re-appending the pane to the DOM drops the xterm helper textarea's
        // focus, which silently kills mouse/wheel reporting. Refocus on the
        // re-attach so the PTY keeps receiving mouse events in this pane.
        try { live.term.focus(); } catch {}
      }
      live.needsFit = true;
    } else {
      grid.appendChild(buildPane(pane));
      const nl = state.live.get(pane.id);
      if (nl) nl.needsFit = true;
    }
  }
  // E1: only re-fit panes that were (re)attached or explicitly flagged, not
  // every live terminal on every render. Attached panes are flagged above
  // whenever the grid (re)layouts, so this stays bounded to the active panes.
  requestAnimationFrame(() => {
    for (const [, live] of state.live) {
      if (live.needsFit) {
        fitTerminal(live);
        sendResize(live);
        live.needsFit = false;
      }
    }
  });
}

// xterm's UMD exposes `Terminal` as the class (or a namespace); resolve the
// real constructor regardless of which form the bundle uses.
//
// We deliberately avoid @xterm/addon-fit: its published build reaches into
// xterm internals (`_core`, `_renderService`) that changed in v5, so `fit()`
// throws and the terminal is stuck at the default 80x24 (leaving a big black
// area). xterm's public `proposeDimensions()` + `resize()` do the job instead.
function resolveTerminal(globalVal) {
  if (typeof globalVal === "function") return globalVal;
  if (globalVal && typeof globalVal.Terminal === "function") return globalVal.Terminal;
  throw new Error("xterm Terminal not found — vendor script failed to load");
}

function fitTerminal(live) {
  try {
    const term = live.term;
    const el = term.element;
    if (!el) return;
    const parent = el.parentElement; // the .term container
    const cs = getComputedStyle(parent);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const availW = parent.clientWidth - padX;
    const availH = parent.clientHeight - padY;
    if (availW <= 0 || availH <= 0) return;

    // Cell size: prefer xterm's own *rendered* cell dimensions (from the
    // renderer) on both axes. The old DOM probe for cellH read
    // `.xterm-rows`'s first child, which can be 0 / mis-sized before rows are
    // laid out — cellH then fell back to the 16px default while the actual
    // rendered cell is smaller, so `rows` was computed too small and the screen
    // ended up much shorter than its container (the black gap at the bottom).
    // The renderer dimensions are always the exact values xterm uses to size
    // the screen, so the terminal now fills its container with no gap.
    let cellW = 8, cellH = 16;
    const dims = (term._core && term._core._renderService) ? term._core._renderService.dimensions : null;
    if (dims && dims.cssCellWidth) cellW = dims.cssCellWidth;
    if (dims && dims.cssCellHeight) cellH = dims.cssCellHeight;
    if (!dims || !dims.cssCellWidth || !dims.cssCellHeight) {
      // Fallback before the renderer has produced dimensions (first paint).
      const rowsEl = el.querySelector(".xterm-rows");
      if (rowsEl && rowsEl.firstElementChild) {
        cellH = rowsEl.firstElementChild.getBoundingClientRect().height || cellH;
      }
      const probe = document.createElement("span");
      probe.style.cssText = "position:absolute;visibility:hidden;left:-9999px;top:0;font-family:monospace;font-size:12px;line-height:1;white-space:pre;";
      probe.textContent = "M".repeat(100);
      el.appendChild(probe);
      const pw = probe.getBoundingClientRect().width;
      if (pw > 0) cellW = pw / 100;
      el.removeChild(probe);
    }
    if (!cellW || !cellH || cellW <= 0 || cellH <= 0) return;

    const cols = Math.max(2, Math.floor(availW / cellW));
    const rows = Math.max(1, Math.floor(availH / cellH));
    if (cols !== term.cols || rows !== term.rows) {
      term.resize(cols, rows);
      // After a resize (esp. making the terminal wider) xterm's renderer can
      // leave the newly-revealed columns/rows black until its next paint — most
      // visible when you scroll back through history. Force a full viewport
      // repaint now so the post-resize state is clean before any scrolling.
      try { term.refresh(0, term.rows - 1); } catch {}
    }
  } catch {}
}

// Fit now and again after layout settles. A single synchronous fit can run
// while the element is mid-reflow (e.g. on (re)connect), measuring a transient
// cell size and leaving black space below the terminal. Re-fitting on the next
// frame and shortly after converges to the correct size.
function refit(live) {
  fitTerminal(live);
  requestAnimationFrame(() => fitTerminal(live));
  setTimeout(() => fitTerminal(live), 120);
}

function fallbackCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
}

// B3: prefer the SILENT execCommand path so browsers like Vivaldi don't pop a
// "note created" clipboard notification. Keep navigator.clipboard.writeText only
// as a last-resort fallback when execCommand is unavailable.
function copyText(text) {
  if (fallbackCopy(text)) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  } catch {}
}

function pasteText(live, text) {
  if (!text) return;
  if (live.ws && live.ws.readyState === 1) {
    live.ws.send(JSON.stringify({ type: "data", data: text }));
  }
}

// Briefly swap a button's label to confirm an action (e.g. "copied").
function flashBtn(btn, okText) {
  if (!btn) return;
  const prev = btn.textContent;
  btn.textContent = okText;
  setTimeout(() => { btn.textContent = prev; }, 1000);
}

// Q3: cheap, non-blocking agent-exit notification. Flashes the document title,
// plays a short beep, and (only if already granted) raises a system Notification.
let titleFlashTimer = null;
function flashTitle(msg) {
  const orig = document.title;
  document.title = msg;
  if (titleFlashTimer) clearTimeout(titleFlashTimer);
  titleFlashTimer = setTimeout(() => { document.title = orig; }, 4000);
  window.addEventListener("focus", () => { document.title = orig; }, { once: true });
}
function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ac = new Ctx();
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.connect(g);
    g.connect(ac.destination);
    o.frequency.value = 880;
    g.gain.value = 0.06;
    o.start();
    setTimeout(() => { try { o.stop(); ac.close(); } catch {} }, 160);
  } catch {}
}
function notifyExit(pane, exitCode) {
  const label = pane.label || pane.dir || pane.id;
  flashTitle("● " + label + " finished");
  beep();
  try {
    if ("Notification" in window && window.Notification.permission === "granted") {
      new window.Notification("Kiloton: agent finished", {
        body: label + (exitCode != null ? " (exit " + exitCode + ")" : ""),
      });
    }
  } catch {}
}

let ctxMenu = null;
let ctxLive = null;

function buildCtxMenu() {
  ctxMenu = h("div", { class: "ctx-menu hidden" }, [
    h("div", {
      class: "ctx-item", text: "Paste",
      onclick: () => {
        const live = ctxLive;
        hideCtxMenu();
        if (!live) return;
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then((t) => { if (t) pasteText(live, t); }).catch(() => {});
        }
      },
    }),
    h("div", {
      class: "ctx-item", text: "Copy",
      onclick: () => {
        const live = ctxLive;
        hideCtxMenu();
        if (!live) return;
        const sel = live.term.getSelection() || window.getSelection().toString();
        if (sel) copyText(sel);
      },
    }),
  ]);
  document.body.appendChild(ctxMenu);
}

function showCtxMenu(x, y) {
  if (!ctxMenu) return;
  ctxMenu.classList.remove("hidden");
  ctxMenu.style.left = x + "px";
  ctxMenu.style.top = y + "px";
}

function hideCtxMenu() {
  if (ctxMenu) ctxMenu.classList.add("hidden");
}

function buildPane(pane) {
  const status = h("span", { class: "status " + (pane.status || "stopped"), title: pane.status || "stopped" });

  // Tooltip shows the actual path the agent will open (after quote-stripping),
  // so users can see where a pasted/"Copy as path" value really resolves.
  const dirTitle = () => {
    const d = cleanDir(pane.dir);
    return d ? d : "(blank → home)";
  };
  const dir = h("input", {
    type: "text",
    class: "grow dir",
    list: "recentDirs",
    placeholder: "dir (blank = home)",
    value: pane.dir || "",
    title: dirTitle(),
    onchange: (e) => { pane.dir = cleanDir(e.target.value); e.target.title = dirTitle(); rememberDir(e.target.value); saveConfig(); },
  });
  if (pane.dir) rememberDir(pane.dir);
  const copyDirBtn = h("button", {
    class: "copy-dir icon-btn",
    title: "Copy resolved directory path",
    text: "⧉",
    onclick: (e) => {
      e.stopPropagation();
      copyText(dirTitle());
      flashBtn(copyDirBtn, "✓");
    },
  });

  const mode = h("select", {
    class: "mode",
    onchange: (e) => { pane.mode = e.target.value; saveConfig(); },
  }, [
    h("option", { value: "interactive", text: "Interactive", selected: pane.mode === "interactive" }),
    h("option", { value: "resume", text: "Resume", selected: pane.mode === "resume" }),
    h("option", { value: "task", text: "Task", selected: pane.mode === "task" }),
  ]);

  const auto = h("input", { type: "checkbox", class: "auto", checked: !!pane.auto, onchange: (e) => { pane.auto = e.target.checked; saveConfig(); } });

  // Q1: opt-in auto-restart toggle. The server does the actual restarting;
  // this is purely a UI control bound to pane.autoRestart.
  const autoRestart = h("input", { type: "checkbox", class: "auto-restart", checked: !!pane.autoRestart, onchange: (e) => { pane.autoRestart = e.target.checked; saveConfig(); } });

  const sessionSel = h("select", { class: "session", onchange: (e) => { pane.sessionId = e.target.value; saveConfig(); } }, [
    h("option", { value: "", text: "New Session" }),
    ...state.sessions.map((s) => h("option", { value: s.id, text: s.id + " — " + s.title, selected: s.id === pane.sessionId })),
  ]);

  const task = h("input", { type: "text", class: "grow task", placeholder: "task prompt", value: pane.task || "", onchange: (e) => { pane.task = e.target.value; saveConfig(); } });

  const startBtn = h("button", { text: "Start", onclick: () => startPane(pane) });
  const stopBtn = h("button", { text: "Stop", onclick: () => stopPane(pane) });
  const restartBtn = h("button", { text: "↻", title: "Restart", onclick: () => restartPane(pane) });
  const removeBtn = h("button", { class: "remove", text: "✕", title: "Quit (remove pane)", onclick: () => removePane(pane) });

  const dirWrap = h("label", { class: "dir-label", title: "Working directory for this terminal (blank = home)" }, [
    h("span", { class: "lbl", text: "Dir" }),
    dir,
    copyDirBtn,
  ]);

  const model = h("input", { type: "text", class: "grow model", placeholder: "model", value: pane.model || "", onchange: (e) => { pane.model = e.target.value.trim() || null; saveConfig(); } });
  const modelWrap = h("label", { class: "dir-label", title: "Model override (-m), e.g. anthropic/claude-3-5-sonnet" }, [
    h("span", { class: "lbl", text: "Model" }),
    model,
  ]);

  const agent = h("input", { type: "text", class: "grow agent", placeholder: "agent", value: pane.agent || "", onchange: (e) => { pane.agent = e.target.value.trim() || null; saveConfig(); } });
  const agentWrap = h("label", { class: "dir-label", title: "Agent override (--agent)" }, [
    h("span", { class: "lbl", text: "Agent" }),
    agent,
  ]);

  // Q4: clone this pane's mode/dir/model/agent/task into a new pane.
  const dupBtn = h("button", { text: "⧉ Duplicate", title: "Clone this pane into a new one", onclick: (e) => { e.stopPropagation(); duplicatePane(pane); } });

  const menuBtn = h("button", { class: "hamburger", text: "⋮", title: "More options" });
  // Q7: free-text per-pane label shown in the header and persisted in config.json.
  const labelInput = h("input", { type: "text", class: "grow label", placeholder: "label / note", value: pane.label || "", onchange: (e) => { pane.label = e.target.value.trim() || null; if (labelSpan) { labelSpan.textContent = pane.label || ""; labelSpan.title = pane.label || ""; } saveConfig(); } });
  const labelWrap = h("label", { class: "menu-row" }, [h("span", { text: "Label" }), labelInput]);
  // Q6: copy / download this pane's full terminal transcript. The button
  // references are captured so copyTranscript can flash the clicked button.
  const copyTranscriptBtn = h("button", { text: "Copy transcript", title: "Copy this pane's full terminal transcript to the clipboard", onclick: (e) => { e.stopPropagation(); copyTranscript(pane, copyTranscriptBtn); } });
  const downloadTranscriptBtn = h("button", { text: "Download transcript", title: "Download this pane's full terminal transcript as a .txt file", onclick: (e) => { e.stopPropagation(); downloadTranscript(pane); } });

  const menu = h("div", { class: "pane-menu hidden" }, [
    h("label", { class: "menu-row" }, [h("span", { text: "Mode" }), mode]),
    h("label", { class: "menu-row" }, [auto, h("span", { text: "auto-approve" })]),
    h("label", { class: "menu-row" }, [autoRestart, h("span", { text: "auto-restart" })]),
    h("label", { class: "menu-row" }, [h("span", { text: "Task" }), task]),
    labelWrap,
    h("div", { class: "menu-row menu-actions" }, [startBtn, stopBtn, restartBtn, removeBtn, dupBtn]),
    h("div", { class: "menu-row menu-actions" }, [copyTranscriptBtn, downloadTranscriptBtn]),
  ]);

  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const nowHidden = menu.classList.toggle("hidden");
    if (!nowHidden) {
      // The pane uses `overflow: hidden`, so a `position: fixed` menu (CSS) is
      // positioned against the viewport and is never clipped by the pane. All
      // coordinates come from getBoundingClientRect(), which are viewport-relative.
      const br = menuBtn.getBoundingClientRect();
      const gap = 4;
      const mw = menu.offsetWidth;
      const mh = menu.offsetHeight;
      const vw = window.innerWidth, vh = window.innerHeight;
      // Horizontal: right-align to the button (opens leftward) when there is
      // room; otherwise left-align (opens rightward); clamp into the viewport.
      let left = "auto", right = "auto";
      if (br.right - mw >= gap) {
        right = (vw - br.right + gap) + "px";
      } else if (br.left + mw <= vw - gap) {
        left = br.left + "px";
      } else {
        left = Math.max(gap, vw - mw - gap) + "px";
      }
      // Vertical: open below the button; flip above when it would overflow.
      let top = br.bottom + gap;
      if (top + mh > vh - gap) {
        top = br.top - mh - gap;
        if (top < gap) top = gap;
      }
      menu.style.top = top + "px";
      menu.style.left = left;
      menu.style.right = right;
    }
  });

  const statusCode = h("span", {
    class: "status-code",
    text: (pane.status === "exited" && pane.exitCode != null) ? "(" + pane.exitCode + ")" : "",
  });

  // Selection checkbox (photo-app style bulk actions). Hidden unless select
  // mode is active; lives in the header so it travels with the pane element.
  // Supports Shift-click to select the whole range from the last-clicked pane.
  const selectChk = h("input", {
    type: "checkbox",
    class: "pane-select",
    title: "Select this pane (Shift-click to select a range)",
    checked: state.selected.has(pane.id),
    onchange: (e) => {
      e.stopPropagation();
      const id = pane.id;
      const dash = getActiveDash();
      const ids = dash.panes.map((p) => p.id);
      if (e.shiftKey && lastSelectAnchor && lastSelectAnchor !== id) {
        const a = ids.indexOf(lastSelectAnchor);
        const b = ids.indexOf(id);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) {
            if (e.target.checked) state.selected.add(ids[i]);
            else state.selected.delete(ids[i]);
          }
        }
      } else {
        if (e.target.checked) state.selected.add(id);
        else state.selected.delete(id);
        lastSelectAnchor = id;
      }
      updateSelectionUI();
    },
  });

  // Q7: per-pane label, shown in the header when set.
  const labelSpan = h("span", { class: "pane-label", title: pane.label || "" });
  if (pane.label) labelSpan.textContent = pane.label;
  const head = h("div", { class: "pane-head", "data-pane": pane.id }, [
    selectChk, status, statusCode, dirWrap, modelWrap, agentWrap,
    h("span", { class: "field-resume" }, [sessionSel]),
    labelSpan,
    menuBtn,
  ]);

  const overlay = h("div", { class: "overlay" + (pane.instanceId ? " hidden" : "") }, [
    h("div", { class: "overlay-card" }, [
      h("div", { class: "overlay-title", text: "Empty terminal" }),
      h("div", { text: "Set a directory / session above, then click Start to launch a Kilo agent here." }),
      h("button", { class: "overlay-start", text: "Start", onclick: () => startPane(pane) }),
    ]),
  ]);
  const termEl = h("div", { class: "term" });
  const paneEl = h("div", { class: "pane", "data-pane": pane.id }, [head, termEl, menu]);

  // create terminal + (maybe) connect
  // B1: allowProposedApi enables any proposed mouse/feature flags xterm may
  // need; term.focus() makes sure the canvas receives DOM mouse events so the
  // PTY's mouse tracking (vim/htop/etc.) works.
  const term = new (resolveTerminal(window.Terminal))({ allowProposedApi: true, fontFamily: "monospace", fontSize: 12, cursorBlink: true, theme: { background: "#000000" } });
  term.open(termEl);
  // Q2: replay the last captured scrollback so a re-added/exited pane still
  // shows recent output (xterm's own buffer is lost on dispose).
  const replay = getScrollback(pane.id);
  if (replay) {
    term.write(replay);
  }
  term.focus();
  // Append the overlay AFTER term.open so it renders on top of the xterm
  // canvas, and as a child of termEl so its `inset:0` is scoped to the
  // terminal area (the header stays visible/clickable when stopped).
  termEl.appendChild(overlay);
  refit({ term });

  // xterm v5 only emits mouse/wheel reports to the PTY while its helper
  // textarea is focused (term.hasFocus() ⟺ _isFocused && document.hasFocus(),
  // see xterm.js). Any pointer interaction must (re)focus the terminal, because
  // focus is silently lost on re-render (renderGrid re-appends the pane), on
  // focusout, and when the user clicks elsewhere then back — after which mouse
  // reporting dies until a manual refocus. We focus on mouseenter/mousedown/
  // focusin so interacting with the terminal always refocuses it.
  const focusTerm = () => { try { term.focus(); } catch {} };
  termEl.addEventListener("focusin", () => { state.focusedPaneId = pane.id; focusTerm(); });
  termEl.addEventListener("mouseenter", focusTerm);
  termEl.addEventListener("mousedown", focusTerm);
  // Track focus only for paste routing. Never blur the terminal here — doing so
  // would kill mouse reporting until the next click.
  termEl.addEventListener("focusout", (e) => {
    if (e.relatedTarget && termEl.contains(e.relatedTarget)) return;
    if (state.focusedPaneId === pane.id) state.focusedPaneId = null;
  });

  // Guarantee a fallback paste/copy target: clicking anywhere in the pane
  // (header or terminal) marks it focused, so the document paste listener
  // still works even when focusin doesn't fire. Clicking the terminal also
  // refocuses it (see termEl mousedown above), but a header click must NOT
  // steal focus away from a field the user is typing into.
  paneEl.addEventListener("mousedown", () => { state.focusedPaneId = pane.id; });

  const live = { term, ws: null, el: paneEl, statusEl: status, statusCodeEl: statusCode, overlayEl: overlay, reconnectAttempts: 0 };

  termEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    ctxLive = live;
    showCtxMenu(e.clientX, e.clientY);
  });

  term.attachCustomKeyEventHandler((e) => {
    if (e.ctrlKey && e.shiftKey) {
      if (e.type === "keydown" && e.key.toLowerCase() === "c") {
        const sel = term.getSelection() || window.getSelection().toString();
        if (sel) { copyText(sel); return false; }
      }
    }
    return true;
  });

  state.live.set(pane.id, live);

  // Re-fit whenever the terminal container changes size (grid reflow, window
  // resize, scrollbar appearing, etc.) so the xterm element always fills it.
  // Keep the PTY in sync too: when the grid is re-laid out (e.g. the Auto /
  // "auto sort" button changes rows×cols) attached panes resize via this
  // observer, and if we don't push the new size to the pty the running TUI
  // keeps rendering at the old dimensions — misaligned lines / drawing outside
  // its box / black gaps. The needsFit path in renderGrid already does this,
  // but the observer is what actually drives most live resizes.
  if (typeof ResizeObserver !== "undefined") {
    live.resizeObserver = new ResizeObserver(() => {
      fitTerminal(live);
      if (live.ws && live.ws.readyState === 1) {
        try { live.ws.send(JSON.stringify({ type: "resize", cols: live.term.cols, rows: live.term.rows })); } catch {}
      }
    });
    live.resizeObserver.observe(termEl);
  }

  term.onData((d) => {
    if (live.ws && live.ws.readyState === 1) live.ws.send(JSON.stringify({ type: "data", data: d }));
  });

  if (pane.instanceId) connectWs(pane, live);

  return paneEl;
}



function connectWs(pane, live) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // Don't stomp a socket that's already connecting/connected: closing a
  // CONNECTING socket is exactly what produces the browser error
  // "WebSocket is closed before the connection is established". A fresh
  // start/restart will have already nulled live.ws before calling us.
  if (live.ws && (live.ws.readyState === WebSocket.CONNECTING || live.ws.readyState === WebSocket.OPEN)) {
    return;
  }
  if (live.ws) { try { live.ws.close(); } catch {} live.ws = null; }
  const ws = new WebSocket(`${proto}://${location.host}/ws/${pane.id}`);
  live.ws = ws;
  ws.onmessage = (ev) => {
    const data = ev.data;
    try {
      const m = JSON.parse(data);
      if (m.type === "status") {
        setStatusDisplay(live, m.status, m.exitCode);
        setOverlay(live, m.status !== "running");
        // Q3: an agent finished (esp. task mode) — notify the user.
        if (m.status === "exited") notifyExit(pane, m.exitCode);
        return;
      }
    } catch {}
    // Q2: capture PTY output into the bounded scrollback ring buffer.
    pushScrollback(pane.id, data);
    live.term.write(data);
  };
  ws.onclose = () => {
    // A newer connection may have already superseded this one (e.g. a fresh
    // start/restart) — don't tear down or auto-reconnect in that case.
    if (live.ws !== ws) return;
    live.ws = null;
    setStatusDisplay(live, "stopped", null, "disconnected");
    setOverlay(live, true);
    // The server spawns instances asynchronously (autostart / first start),
    // so a connect can arrive before inst.pty is ready and get closed. Retry
    // with backoff so the terminal eventually attaches instead of staying
    // stuck "disconnected". Only retries while the instance is meant to run.
    if (pane.instanceId && (live.reconnectAttempts || 0) < 8) {
      live.reconnectAttempts = (live.reconnectAttempts || 0) + 1;
      const delay = 600 * live.reconnectAttempts;
      setTimeout(() => {
        const l = state.live.get(pane.id);
        if (l && l.ws === null && pane.instanceId) connectWs(pane, l);
      }, delay);
    } else if (pane.instanceId) {
      // C1: reconnect attempts exhausted. The instance is gone (server
      // restarted / crashed) — drop the stale marker so the pane returns to a
      // "click Start" state instead of being stuck "disconnected" forever.
      pane.instanceId = null;
      pane.status = "stopped";
      setStatusDisplay(live, "stopped", null, "server restarted — click Start");
      setOverlay(live, true);
      saveConfig();
    }
  };
  ws.onopen = () => { live.reconnectAttempts = 0; setOverlay(live, false); live.term.focus(); sendResize(live); };
}

function setOverlay(live, show) {
  if (live && live.overlayEl) live.overlayEl.classList.toggle("hidden", !show);
}

// Centralise status-dot updates so the inline exit code (C3) stays in sync
// everywhere a pane's status changes.
function setStatusDisplay(live, status, exitCode, titleText) {
  live.statusEl.className = "status " + (status || "stopped");
  live.statusEl.title = titleText != null ? titleText : (status + (exitCode != null ? " (" + exitCode + ")" : ""));
  if (live.statusCodeEl) live.statusCodeEl.textContent = (status === "exited" && exitCode != null) ? "(" + exitCode + ")" : "";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function showPaneError(pane, msg) {
  const live = state.live.get(pane.id);
  if (!live) return;
  setStatusDisplay(live, "exited", null, "error: " + msg);
  if (live.overlayEl) {
    live.overlayEl.classList.remove("hidden");
    const card = live.overlayEl.querySelector(".overlay-card");
    if (card) card.innerHTML = `<div class="overlay-title">Error</div><div>${escapeHtml(msg)}</div>`;
  }
}

function sendResize(live) {
  if (!live.ws || live.ws.readyState !== 1) return;
  try {
    refit(live);
    live.ws.send(JSON.stringify({ type: "resize", cols: live.term.cols, rows: live.term.rows }));
  } catch {}
}

/* ---------- pane lifecycle ---------- */

async function startPane(pane) {
  try {
    await api("POST", "/api/instances", {
      dashboardId: state.activeDashId,
      paneId: pane.id,
      mode: pane.mode,
      dir: cleanDir(pane.dir),
      auto: pane.auto,
      sessionId: pane.sessionId,
      task: pane.task,
      model: pane.model,
      agent: pane.agent,
    });
  } catch (e) {
    showPaneError(pane, e.message || String(e));
    return;
  }
  const live = state.live.get(pane.id);
  if (live) connectWs(pane, live);
}

async function stopPane(pane) {
  try {
    await api("DELETE", "/api/instances/" + pane.id);
  } catch (e) {
    showPaneError(pane, e.message || String(e));
    return;
  }
  const live = state.live.get(pane.id);
  if (live) {
    if (live.ws) { try { live.ws.close(); } catch {} live.ws = null; }
    setStatusDisplay(live, "stopped", null, "stopped");
    setOverlay(live, true);
  }
  // Clear the local instance marker so we don't keep retrying a dead socket
  // and the next load shows the empty terminal.
  pane.instanceId = null;
  pane.status = "stopped";
}

async function restartPane(pane) {
  try {
    await api("POST", "/api/instances/" + pane.id + "/restart");
  } catch (e) {
    showPaneError(pane, e.message || String(e));
    return;
  }
  const live = state.live.get(pane.id);
  if (live) connectWs(pane, live);
}

// Q6: copy a pane's FULL transcript. Prefer the server's authoritative capture
// (it records every byte); fall back to the locally-captured scrollback if the
// server has no copy. `btn` is the clicked element, flashed to confirm.
async function copyTranscript(pane, btn) {
  let text = null;
  try {
    const res = await fetch(`/api/instances/${pane.id}/transcript`, { method: "GET" });
    if (res.ok) text = await res.text();
  } catch {}
  if (!text) {
    const buf = getScrollback(pane.id);
    if (buf) text = buf;
  }
  if (text) {
    copyText(text);
    flashBtn(btn, "copied");
  }
}

// Q6: download a pane's FULL transcript as a .txt file via a blob URL.
async function downloadTranscript(pane) {
  try {
    const res = await fetch(`/api/instances/${pane.id}/transcript`, { method: "GET" });
    if (!res.ok) throw new Error(await res.text());
    const text = await res.text();
    const blob = new window.Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.download = `${pane.id}.transcript.txt`;
    a.href = url;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch {}
}

// Stop + tear down a pane's terminal and remove it from state.live/selection.
// Shared by removePane (single) and selectionDelete (bulk).
function disposePane(pane) {
  api("DELETE", "/api/instances/" + pane.id).catch(() => {});
  const live = state.live.get(pane.id);
  if (live) {
    if (live.ws) { try { live.ws.close(); } catch {} }
    // A1: stop the resize observer before disposing the terminal.
    if (live.resizeObserver) { try { live.resizeObserver.disconnect(); } catch {} }
    try { live.term.dispose(); } catch {}
    if (live.el && live.el.parentNode) live.el.parentNode.removeChild(live.el);
    state.live.delete(pane.id);
  }
  state.selected.delete(pane.id);
  scrollback.delete(pane.id);
}

async function removePane(pane) {
  // No confirm: this is the per-pane hamburger "✕", and the click itself is the
  // confirmation. Bulk actions still confirm once via selectionDelete.
  disposePane(pane);
  const dash = getActiveDash();
  dash.panes = dash.panes.filter((p) => p.id !== pane.id);
  saveConfig();
  render();
}

/* ---------- kilo update ---------- */

async function loadKiloVersion() {
  const info = $("#kiloInfo");
  if (!info) return;
  try {
    const v = await api("GET", "/api/kilo/version");
    const inst = v.installed || "?";
    if (v.latest && v.latest !== inst) {
      info.textContent = `Kilo ${inst} (${v.latest} available)`;
      info.classList.add("outdated");
    } else {
      info.textContent = `Kilo ${inst}` + (v.latest ? " · up to date" : "");
      info.classList.remove("outdated");
    }
  } catch {
    info.textContent = "Kilo ?";
  }
}

async function updateKilo() {
  const btn = $("#updateKilo");
  const info = $("#kiloInfo");
  if (btn) btn.disabled = true;
  info.textContent = "Updating Kilo…";
  try {
    const res = await fetch("/api/kilo/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "update failed");
    info.textContent = `Kilo ${data.installed} (updated)`;
  } catch (e) {
    info.textContent = "Update failed: " + (e.message || e);
  } finally {
    if (btn) btn.disabled = false;
    loadKiloVersion();
  }
}

/* ---------- layout editing ---------- */

function addDashboard() {
  const d = { id: uid("d"), name: "Dashboard " + (state.config.dashboards.length + 1), rows: 2, cols: 2, panes: [newPane()] };
  state.config.dashboards.push(d);
  setActiveDash(d.id);
}

function closeDashboard(id) {
  const dash = state.config.dashboards.find((d) => d.id === id);
  if (!dash) return;
  if (!confirm(`Close dashboard "${dash.name}" and stop its instances?`)) return;
  for (const p of dash.panes) { api("DELETE", "/api/instances/" + p.id).catch(() => {}); }
  state.config.dashboards = state.config.dashboards.filter((d) => d.id !== id);
  if (state.config.dashboards.length === 0) {
    const d = { id: uid("d"), name: "Dashboard 1", rows: 1, cols: 1, panes: [newPane()] };
    state.config.dashboards.push(d);
    setActiveDash(d.id);
    return;
  }
  if (state.activeDashId === id) setActiveDash(state.config.dashboards[0].id);
  else { saveConfig(); render(); }
}

function newPane() {
  return { id: uid("p"), mode: "interactive", dir: "", model: null, agent: null, auto: false, sessionId: null, task: null, label: null, instanceId: null, status: "stopped", exitCode: null };
}

// Q4: clone a pane's mode/dir/model/agent/task/label into a new pane in the
// same dashboard (a quick way to scale a pattern across projects).
function duplicatePane(src) {
  const dash = getActiveDash();
  const np = newPane();
  np.mode = src.mode;
  np.dir = src.dir;
  np.model = src.model;
  np.agent = src.agent;
  np.auto = src.auto;
  np.sessionId = src.sessionId;
  np.task = src.task;
  np.label = src.label;
  const idx = dash.panes.indexOf(src);
  dash.panes.splice(idx >= 0 ? idx + 1 : dash.panes.length, 0, np);
  saveConfig();
  renderGrid();
}

function addPane() {
  const dash = getActiveDash();
  dash.panes.push(newPane());
  saveConfig();
  renderGrid();
}

function applyGrid() {
  const dash = getActiveDash();
  dash.rows = Math.max(1, parseInt($("#rowsInput").value, 10) || 1);
  dash.cols = Math.max(1, parseInt($("#colsInput").value, 10) || 1);
  saveConfig();
  renderGrid();
}

// Pick the rows×cols that gives every terminal the most screen space for the
// current number of panes: minimize wasted (empty) cells, then match the
// window's aspect ratio so each pane is as large and well-shaped as possible.
function autoGrid() {
  const dash = getActiveDash();
  const n = dash.panes.length;
  if (n <= 0) {
    dash.rows = 1;
    dash.cols = 1;
  } else {
    const gridEl = $("#grid");
    const W = (gridEl && gridEl.clientWidth) || window.innerWidth;
    const H = (gridEl && gridEl.clientHeight) || window.innerHeight;
    const targetAspect = W / H; // cols:rows ratio that best fills the window
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const wasted = rows * cols - n;
      const aspect = cols / rows;
      const score = wasted * 1000 + Math.abs(Math.log(aspect / targetAspect));
      if (!best || score < best.score) best = { rows, cols, score };
    }
    dash.rows = best.rows;
    dash.cols = best.cols;
  }
  $("#rowsInput").value = dash.rows;
  $("#colsInput").value = dash.cols;
  saveConfig();
  renderGrid();
}

async function startAllInDash() {
  const dash = getActiveDash();
  for (const p of dash.panes) await startPane(p);
}

async function stopAllInDash() {
  const dash = getActiveDash();
  for (const p of dash.panes) await stopPane(p);
}

async function restartAllInDash() {
  const dash = getActiveDash();
  for (const p of dash.panes) await restartPane(p);
}

/* ---------- bulk selection (photo-app style) ---------- */

// Drop selection ids that no longer map to a live pane in any dashboard.
function pruneSelection() {
  const allIds = new Set();
  for (const d of state.config.dashboards) for (const p of d.panes) allIds.add(p.id);
  for (const id of [...state.selected]) if (!allIds.has(id)) state.selected.delete(id);
}

function setSelectMode(on) {
  state.selectMode = on;
  if (!on) { state.selected.clear(); lastSelectAnchor = null; }
  const grid = $("#grid");
  if (grid) grid.classList.toggle("selecting", on);
  const btn = $("#selectMode");
  if (btn) btn.classList.toggle("active", on);
  updateSelectionUI();
}

function clearSelection() {
  state.selected.clear();
  lastSelectAnchor = null;
  updateSelectionUI();
}

function selectAllInDash() {
  const dash = getActiveDash();
  for (const p of dash.panes) state.selected.add(p.id);
  updateSelectionUI();
}

// Reflect selection state onto the DOM (checkboxes, highlight, action bar).
function updateSelectionUI() {
  // E2: selection rarely changes; skip the per-pane DOM walk when neither the
  // selected set nor the select-mode flag changed since the last update.
  const sig = (state.selectMode ? "1" : "0") + ":" + [...state.selected].sort().join(",");
  if (sig === selSig) return;
  selSig = sig;
  const grid = $("#grid");
  if (grid) {
    for (const el of grid.querySelectorAll(".pane")) {
      const id = el.getAttribute("data-pane");
      const chk = el.querySelector(".pane-select");
      if (chk) chk.checked = state.selected.has(id);
      el.classList.toggle("selected", state.selected.has(id));
    }
  }
  const n = state.selected.size;
  const count = $("#selCount");
  if (count) count.textContent = n + " selected";
  const selBtn = $("#selectMode");
  if (selBtn) selBtn.textContent = state.selectMode && n > 0 ? "☑ Select (" + n + ")" : "☑ Select";
  const bar = $("#selectionBar");
  if (bar) {
    bar.classList.toggle("hidden", !state.selectMode);
    for (const b of bar.querySelectorAll("button[data-sel-action]")) {
      const a = b.dataset.selAction;
      b.disabled = (n === 0) && (a === "start" || a === "stop" || a === "restart" || a === "delete");
    }
  }
}

async function selectionStart() {
  for (const p of [...selPanes()]) await startPane(p);
  updateSelectionUI();
}

async function selectionStop() {
  for (const p of [...selPanes()]) await stopPane(p);
  updateSelectionUI();
}

async function selectionRestart() {
  for (const p of [...selPanes()]) await restartPane(p);
  updateSelectionUI();
}

function selPanes() {
  const dash = getActiveDash();
  return dash.panes.filter((p) => state.selected.has(p.id));
}

async function selectionDelete() {
  const ids = selPanes().map((p) => p.id);
  if (!ids.length) return;
  if (!confirm(`Remove ${ids.length} selected pane(s)? This stops each agent and discards its scrollback.`)) return;
  const dash = getActiveDash();
  for (const id of ids) {
    const pane = dash.panes.find((p) => p.id === id);
    if (pane) disposePane(pane);
  }
  // Capture the delete set up front: disposePane() also clears ids from
  // state.selected, so filtering against state.selected here would keep every
  // pane and the grid would just rebuild the ones we meant to remove.
  const delSet = new Set(ids);
  dash.panes = dash.panes.filter((p) => !delSet.has(p.id));
  state.selected.clear();
  saveConfig();
  render();
}

/* ---------- boot ---------- */

function render() {
  renderTabs();
  renderLayoutBar();
  renderGrid();
  pruneSelection();
  updateSelectionUI();
  applyFilter();
}

// Q5: filter panes by dir/model/agent/task/label/sessionId. When the active
// dashboard has no matches, jump to the first other dashboard that does.
function paneMatches(p, q) {
  return [p.id, p.dir, p.model, p.agent, p.task, p.label, p.sessionId]
    .some((v) => (v || "").toLowerCase().includes(q));
}

function applyFilter() {
  const q = (state.filter || "").toLowerCase().trim();
  const dash = getActiveDash();
  if (!q) {
    for (const el of document.querySelectorAll("#grid .pane")) el.style.display = "";
    const fc = $("#filterCount");
    if (fc) fc.textContent = "";
    return;
  }
  const matchesIn = (d) => d.panes.filter((p) => paneMatches(p, q)).length;
  if (matchesIn(dash) === 0) {
    const other = state.config.dashboards.find((d) => d.id !== dash.id && matchesIn(d) > 0);
    if (other) { setActiveDash(other.id); return; }
  }
  let shown = 0;
  for (const p of dash.panes) {
    const el = document.querySelector('#grid .pane[data-pane="' + p.id + '"]');
    const match = paneMatches(p, q);
    if (el) el.style.display = match ? "" : "none";
    if (match) shown++;
  }
  const fc = $("#filterCount");
  if (fc) fc.textContent = shown + " match" + (shown === 1 ? "" : "es");
}

// Q10: surface a "N running / M exited" summary from GET /api/instances.
async function loadHealth() {
  const el = $("#health");
  if (!el) return;
  try {
    const list = await api("GET", "/api/instances");
    let running = 0, exited = 0;
    for (const i of list) {
      if (i.status === "running") running++;
      else if (i.status === "exited") exited++;
    }
    el.innerHTML = `${running} <span class="running">running</span> · ${exited} <span class="exited">exited</span>`;
  } catch {
    el.textContent = "—";
  }
}

// Q9: keyboard-shortcut help overlay.
function toggleShortcuts(force) {
  const el = $("#shortcutHelp");
  if (!el) return;
  const show = force != null ? force : el.classList.contains("hidden");
  el.classList.toggle("hidden", !show);
}

async function boot() {
  $("#portLabel").textContent = "http://" + location.host;
  ensureRecentDirs();
  try {
    const v = await api("GET", "/api/version");
    const bv = $("#brandVersion");
    if (bv && v.version) bv.textContent = "v" + v.version;
  } catch {}
  state.config = await api("GET", "/api/config");
  state.activeDashId = state.config.activeDashId || state.config.dashboards[0]?.id || null;
  await loadSessions();
  render();
  loadKiloVersion();
  $("#addPane").addEventListener("click", addPane);
  $("#applyGrid").addEventListener("click", applyGrid);
  $("#autoGrid").addEventListener("click", autoGrid);
  $("#startAll").addEventListener("click", () => startAllInDash());
  $("#stopAll").addEventListener("click", () => stopAllInDash());
  $("#restartAll").addEventListener("click", () => restartAllInDash());
  $("#selectMode").addEventListener("click", () => setSelectMode(!state.selectMode));
  $("#selAll").addEventListener("click", selectAllInDash);
  $("#selClear").addEventListener("click", clearSelection);
  $("#selStart").addEventListener("click", selectionStart);
  $("#selStop").addEventListener("click", selectionStop);
  $("#selRestart").addEventListener("click", selectionRestart);
  $("#selDelete").addEventListener("click", selectionDelete);
  $("#selDone").addEventListener("click", () => setSelectMode(false));
  $("#saveLayout").addEventListener("click", () => saveConfig());
  $("#refreshSessions").addEventListener("click", async () => { await loadSessions(); updateSessionOptions(); });
  $("#updateKilo").addEventListener("click", updateKilo);

  // Q5: client-side pane filter.
  $("#search").addEventListener("input", (e) => { state.filter = e.target.value; applyFilter(); });
  // Q9: shortcut help overlay.
  $("#helpBtn").addEventListener("click", () => toggleShortcuts());
  $("#shortcutHelpClose").addEventListener("click", () => toggleShortcuts(false));
  document.addEventListener("click", (e) => {
    const pop = $("#shortcutHelp");
    if (pop && !pop.classList.contains("hidden") && !pop.contains(e.target) && e.target.id !== "helpBtn") {
      pop.classList.add("hidden");
    }
  });

  // Q10: poll instance health and surface a running/exited summary.
  loadHealth();
  setInterval(loadHealth, 5000);

  // E3: flush any pending debounced config save before the tab unloads.
  window.addEventListener("pagehide", flushConfigSave);

  // Info popover explaining that Update force-stops every Kilo instance.
  $("#kiloInfoBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    $("#kiloUpdateInfo").classList.toggle("hidden");
  });
  $("#kiloUpdateInfoClose").addEventListener("click", () => $("#kiloUpdateInfo").classList.add("hidden"));
  document.addEventListener("click", (e) => {
    const pop = $("#kiloUpdateInfo");
    if (pop && !pop.classList.contains("hidden") && !pop.contains(e.target) && e.target.id !== "kiloInfoBtn") {
      pop.classList.add("hidden");
    }
  });

  // B2: robust context-menu dismissal. A capture-phase mousedown hides the
  // menu unless the press lands inside the menu itself (so clicks on menu
  // items still fire). This also covers the old bug where a right-click
  // elsewhere fired `contextmenu` but not `click`, leaving the menu stuck.
  // Escape / blur / scroll / resize also dismiss it.
  buildCtxMenu();
  document.addEventListener("mousedown", (e) => {
    if (e.target.closest && e.target.closest(".ctx-menu")) return;
    if (ctxMenu && !ctxMenu.classList.contains("hidden")) hideCtxMenu();
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideCtxMenu(); });
  window.addEventListener("blur", hideCtxMenu);
  window.addEventListener("scroll", hideCtxMenu, true);
  window.addEventListener("resize", hideCtxMenu);

  // Close any open per-pane hamburger menus when clicking outside them.
  document.addEventListener("click", (e) => {
    if (e.target.closest && (e.target.closest(".pane-menu") || e.target.closest(".hamburger"))) return;
    for (const m of document.querySelectorAll(".pane-menu:not(.hidden)")) m.classList.add("hidden");
  });

  // One capture-phase paste handler for the whole document. In the CAPTURE
  // phase it runs before xterm's own textarea paste listener, so we can
  // forward the clipboard text straight to the PTY and stop xterm from also
  // echoing it (which would double the input). It only acts when a pane is
  // focused and the caret is NOT in a header input, so pasting into the
  // mode/dir/session/task fields keeps native browser paste.
  document.addEventListener("paste", (e) => {
    const id = state.focusedPaneId;
    if (!id) return;
    const live = state.live.get(id);
    if (!live) return;
    const ae = document.activeElement;
    if (ae && ae.closest && ae.closest(".pane-head")) return;
    const text = (e.clipboardData || window.clipboardData)?.getData("text");
    if (!text) return;
    pasteText(live, text);
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // C4: Ctrl/Cmd+Enter starts the currently focused pane.
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || "");
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !typing) {
      const id = state.focusedPaneId;
      if (!id) return;
      const pane = state.config.dashboards.flatMap((d) => d.panes).find((p) => p.id === id);
      if (pane) startPane(pane);
    } else if (e.key === "Escape") {
      toggleShortcuts(false);
      if (state.selectMode && !typing) setSelectMode(false);
    } else if (e.key === "?" && !typing) {
      // Q9: show the keyboard-shortcut help overlay.
      e.preventDefault();
      toggleShortcuts(true);
    } else if (state.selectMode && (e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A") && !typing) {
      // Ctrl/Cmd+A selects every pane in the dashboard while in select mode.
      e.preventDefault();
      selectAllInDash();
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "s" || e.key === "S") && !typing) {
      // `s` toggles selection mode (ignored while typing in a field/terminal).
      e.preventDefault();
      setSelectMode(!state.selectMode);
    }
  });

  window.addEventListener("resize", () => {
    for (const [, live] of state.live) sendResize(live);
  });

  // Q8: live cross-tab state sync (never throws).
  setupTabSync();
}

function updateSessionOptions() {
  for (const [, live] of state.live) {
    const sel = live.el && live.el.querySelector(".session");
    if (!sel) continue;
    const cur = sel.value;
    sel.innerHTML = "";
    sel.appendChild(h("option", { value: "", text: "New Session" }));
    for (const s of state.sessions) {
      sel.appendChild(h("option", { value: s.id, text: s.id + " — " + s.title, selected: s.id === cur }));
    }
  }
}

boot().catch((err) => {
  const el = document.getElementById("grid");
  if (el) el.innerHTML = '<p style="padding:1rem;color:#c33">Failed to load dashboard: ' + (err && err.message ? err.message : String(err)) + '</p>';
  console.error(err);
});
