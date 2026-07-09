const state = {
  config: null,
  sessions: [],
  activeDashId: null,
  focusedPaneId: null,
  live: new Map(), // paneId -> { term, ws, el, statusEl, overlayEl, reconnectAttempts }
};

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
  } catch (e) {
    console.error("sessions", e);
    state.sessions = [];
  }
}

function saveConfig() {
  return api("POST", "/api/config", state.config).catch((e) => console.error(e));
}

function getActiveDash() {
  return state.config.dashboards.find((d) => d.id === state.activeDashId) || state.config.dashboards[0];
}

function setActiveDash(id) {
  state.activeDashId = id;
  state.config.activeDashId = id;
  saveConfig();
  render();
}

/* ---------- rendering ---------- */

function renderTabs() {
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

  for (const pane of dash.panes) {
    const live = state.live.get(pane.id);
    if (live) {
      if (live.el.parentNode !== grid) grid.appendChild(live.el);
    } else {
      grid.appendChild(buildPane(pane));
    }
  }
  requestAnimationFrame(() => {
    for (const [, live] of state.live) {
      fitTerminal(live);
      sendResize(live);
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
    if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
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
    document.execCommand("copy");
    document.body.removeChild(ta);
  } catch {}
}

function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
      return;
    }
  } catch {}
  fallbackCopy(text);
}

function pasteText(live, text) {
  if (!text) return;
  if (live.ws && live.ws.readyState === 1) {
    live.ws.send(JSON.stringify({ type: "data", data: text }));
  }
}

function pasteInto(live) {
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then((t) => { if (t) pasteText(live, t); }).catch(() => {});
      return;
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

  const dir = h("input", { type: "text", class: "grow dir", placeholder: "dir (blank = home)", value: pane.dir || "", onchange: (e) => { pane.dir = e.target.value; saveConfig(); } });

  const mode = h("select", {
    class: "mode",
    onchange: (e) => { pane.mode = e.target.value; saveConfig(); },
  }, [
    h("option", { value: "interactive", text: "Interactive", selected: pane.mode === "interactive" }),
    h("option", { value: "resume", text: "Resume", selected: pane.mode === "resume" }),
    h("option", { value: "task", text: "Task", selected: pane.mode === "task" }),
  ]);

  const auto = h("input", { type: "checkbox", class: "auto", checked: !!pane.auto, onchange: (e) => { pane.auto = e.target.checked; saveConfig(); } });
  const autoLabel = h("label", { title: "auto-approve (autonomous)" }, [auto, "auto"]);

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

  const menuBtn = h("button", { class: "hamburger", text: "⋮", title: "More options" });
  const menu = h("div", { class: "pane-menu hidden" }, [
    h("label", { class: "menu-row" }, [h("span", { text: "Mode" }), mode]),
    h("label", { class: "menu-row" }, [auto, h("span", { text: "auto-approve" })]),
    h("label", { class: "menu-row" }, [h("span", { text: "Task" }), task]),
    h("div", { class: "menu-row menu-actions" }, [startBtn, stopBtn, restartBtn, removeBtn]),
  ]);

  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const opened = menu.classList.toggle("hidden");
    if (!opened) {
      const pr = paneEl.getBoundingClientRect();
      const br = menuBtn.getBoundingClientRect();
      menu.style.top = (br.bottom - pr.top + 4) + "px";
      menu.style.right = (pr.right - br.right + 4) + "px";
    }
  });

  const statusCode = h("span", {
    class: "status-code",
    text: (pane.status === "exited" && pane.exitCode != null) ? "(" + pane.exitCode + ")" : "",
  });

  const head = h("div", { class: "pane-head", "data-pane": pane.id }, [
    status, statusCode, dirWrap, modelWrap, agentWrap,
    h("span", { class: "field-resume" }, [sessionSel]),
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
  const term = new (resolveTerminal(window.Terminal))({ fontFamily: "monospace", fontSize: 12, cursorBlink: true, theme: { background: "#000000" } });
  term.open(termEl);
  // Append the overlay AFTER term.open so it renders on top of the xterm
  // canvas, and as a child of termEl so its `inset:0` is scoped to the
  // terminal area (the header stays visible/clickable when stopped).
  termEl.appendChild(overlay);
  refit({ term });

  // xterm v5 removed term.onFocus/onBlur; track focus via DOM events on the
  // terminal element (focus/blur bubble as focusin/focusout).
  termEl.addEventListener("focusin", () => { state.focusedPaneId = pane.id; });
  termEl.addEventListener("focusout", (e) => {
    if (e.relatedTarget && termEl.contains(e.relatedTarget)) return;
    if (state.focusedPaneId === pane.id) state.focusedPaneId = null;
  });

  // Guarantee a fallback paste/copy target: clicking anywhere in the pane
  // (header or terminal) marks it focused, so the document paste listener
  // still works even when focusin doesn't fire.
  paneEl.addEventListener("mousedown", () => { state.focusedPaneId = pane.id; });

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
      if (e.type === "keydown" && e.key.toLowerCase() === "v") {
        pasteInto(live);
        return false;
      }
    }
    return true;
  });

  // Select-to-copy: copying text on selection is standard terminal UX.
  // Debounced so dragging/reselecting doesn't flood the clipboard.
  let copyDebounce = null;
  term.onSelectionChange(() => {
    if (copyDebounce) clearTimeout(copyDebounce);
    copyDebounce = setTimeout(() => {
      const s = term.getSelection();
      if (s) copyText(s);
    }, 150);
  });

  const live = { term, ws: null, el: paneEl, statusEl: status, statusCodeEl: statusCode, overlayEl: overlay, reconnectAttempts: 0 };
  state.live.set(pane.id, live);

  // Re-fit whenever the terminal container changes size (grid reflow, window
  // resize, scrollbar appearing, etc.) so the xterm element always fills it.
  if (typeof ResizeObserver !== "undefined") {
    live.resizeObserver = new ResizeObserver(() => fitTerminal(live));
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
        return;
      }
    } catch {}
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
    }
  };
  ws.onopen = () => { live.reconnectAttempts = 0; setOverlay(live, false); sendResize(live); };
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
      dir: pane.dir,
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

async function removePane(pane) {
  if (!confirm(`Remove this pane? This stops the agent and discards its scrollback.`)) return;
  try { await api("DELETE", "/api/instances/" + pane.id); } catch {}
  const live = state.live.get(pane.id);
  if (live) {
    if (live.ws) { try { live.ws.close(); } catch {} }
    // A1: stop the resize observer before disposing the terminal.
    if (live.resizeObserver) { try { live.resizeObserver.disconnect(); } catch {} }
    try { live.term.dispose(); } catch {}
    if (live.el && live.el.parentNode) live.el.parentNode.removeChild(live.el);
    state.live.delete(pane.id);
  }
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
  if (state.activeDashId === id) setActiveDash(state.config.dashboards[0]?.id || null);
  else { saveConfig(); render(); }
}

function newPane() {
  return { id: uid("p"), mode: "interactive", dir: "", model: null, agent: null, auto: false, sessionId: null, task: null, instanceId: null, status: "stopped", exitCode: null };
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

/* ---------- boot ---------- */

function render() {
  renderTabs();
  renderLayoutBar();
  renderGrid();
}

async function boot() {
  $("#portLabel").textContent = "http://localhost:" + (location.port || "7655");
  try {
    const v = await api("GET", "/api/version");
    const bv = $("#brandVersion");
    if (bv && v.version) bv.textContent = "v" + v.version;
  } catch {}
  state.config = await api("GET", "/api/config");
  state.activeDashId = state.config.activeDashId || state.config.dashboards[0]?.id || null;
  render();
  await loadSessions();
  updateSessionOptions();
  loadKiloVersion();
  $("#addPane").addEventListener("click", addPane);
  $("#applyGrid").addEventListener("click", applyGrid);
  $("#autoGrid").addEventListener("click", autoGrid);
  $("#startAll").addEventListener("click", () => startAllInDash());
  $("#stopAll").addEventListener("click", () => stopAllInDash());
  $("#saveLayout").addEventListener("click", () => saveConfig());
  $("#refreshSessions").addEventListener("click", async () => { await loadSessions(); updateSessionOptions(); });
  $("#updateKilo").addEventListener("click", updateKilo);

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

  buildCtxMenu();
  document.addEventListener("click", hideCtxMenu);

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

  // C4: Ctrl/Cmd+Enter starts the currently focused pane.
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      const id = state.focusedPaneId;
      if (!id) return;
      const pane = state.config.dashboards.flatMap((d) => d.panes).find((p) => p.id === id);
      if (pane) startPane(pane);
    }
  });

  window.addEventListener("resize", () => {
    for (const [, live] of state.live) sendResize(live);
  });
}

boot();
