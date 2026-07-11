# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-10

### Added
- **Recent-directories autocomplete (QoL):** the per-pane `Dir` field is now bound to a shared `<datalist>` that remembers every directory you type (deduped) and seeds from each pane's existing dir, so a repeated project path is a one-click fill instead of copy/paste. (`public/app.js`)
- **`engines` field:** `package.json` now declares `node >= 18`, so `npm` warns (instead of failing cryptically on the `node-pty` native build) on unsupported Node. (`package.json`)

- **Dashboard UX**
  - **Bulk selection (photo-app style):** a `☑ Select` button enters selection mode — per-pane checkboxes, an amber outline on selected panes, a floating action bar (`Select all` / `Clear` / `▶ Start` / `■ Stop` / `↻ Restart` / `✕ Delete` / `Done`), a live count badge, `Shift`-click range select, and `s` / `Ctrl`+`A` / `Esc` shortcuts.
  - **Restart all** button (mirrors Start all / Stop all).
  - **Copy directory** button (⧉) on each pane's `Dir` field copies the resolved (quote-stripped) path, with the resolved path shown as a tooltip.

- **Per-pane features**
  - **Duplicate pane (Q4):** clone a pane's mode/dir/model/agent/task/label from its hamburger menu.
  - **Per-pane label (Q7):** a free-text note shown in the header and persisted in `config.json`.
  - **Filter (Q5):** a layout-bar box that finds panes by dir/model/agent/task/label/session id across dashboards and jumps to a matching dashboard.
  - **Exit notifications (Q3):** on agent exit the tab title flashes, a short beep plays, and (if already permitted) a system `Notification` is raised.
  - **Health summary (Q10):** the top bar shows `N running · M exited` across all dashboards.
  - **Shortcut help (Q9):** a `?`/keyboard button (and `?` key) opens an overlay listing shortcuts.
  - **Scrollback capture (Q2):** a bounded in-memory ring buffer keeps recent output so an exited/reopened pane still shows its last lines.

- **Tests / CI / packaging**
  - **Unit tests** cover the pure functions `cleanDir` / `buildArgs` / `normalize` / `validateConfig` plus `getKiloBin` / `getKiloVersion` (`test/unit.mjs`, no server/pty/browser).
  - **Linter:** ESLint flat config (`eslint.config.js`) + `npm run lint`.
  - **B1 mouse regression test:** `test/b1-mouse.mjs` boots the client under jsdom with a spy Terminal and asserts the B1 wiring — `npm run test:b1`.
  - **End-to-end test covers the full 0.2.0 program:** `test/e2e.mjs` now adds server scenarios for the config index (D1), `failPane` error state (D3), input-validation 400s (D4), and synchronous config flush on lifecycle (D5); `npm test` also runs a new jsdom client smoke (`test/client-e2e.mjs`) exercising duplicate pane (Q4), per-pane label (Q7), filter (Q5), health summary (Q10), silent copy (B3), and the shortcut overlay (Q9).
  - **CI:** `.github/workflows/ci.yml` runs `npm ci` then `npm run lint && npm run test:unit` on push/PR across Node 18/20/22 (e2e excluded to stay fast).
  - **Docker:** multi-stage build (smaller final image) with `stop_grace_period` so the server can flush `config.json` on shutdown.
  - **`.env.example`** documents `KILOTON_HOST` LAN exposure and `KILOTON_TOKEN`.

- **Security / server (D6, Q1, Q8)**
  - **Optional token auth (D6):** new `KILOTON_TOKEN` env var. When set, every HTTP request and WebSocket upgrade must carry it — via the `Authorization: Bearer <token>` header, or a `?token=<token>` query param (used by the WebSocket since browsers can't set headers on the upgrade). Unset keeps the old local-only, no-auth behavior; a missing/wrong token returns `401` on the API.
  - **Auto-restart crashed agents (Q1):** each pane's hamburger (☰) menu has an "auto-restart" checkbox. When enabled and the agent *crashes* (exits non-zero), Kiloton restarts it with exponential backoff (base 2s, doubling each attempt, capped at 60s, up to 5 attempts). A clean exit (code 0, e.g. a finished task) or a normal user **Stop** is **not** restarted. After 5 failed attempts it gives up and the pane stays stopped (status shows a note).
  - **Cross-tab sync (Q8):** open the dashboard in multiple browser tabs and they stay in sync — layout edits, dashboard switches, and starts/stops made in one tab are reflected live in the others (via `BroadcastChannel`, with a `localStorage` fallback). No config needed.

- **Per-pane (Q6)**
  - **Export / copy transcript (Q6):** each pane's hamburger menu adds **Copy transcript** (copies the pane's *full* terminal output to the clipboard) and **Download transcript** (saves it as `<paneId>.transcript.txt`). The full transcript is captured server-side, not just the client's recent scrollback; `GET /api/instances/:paneId/transcript` returns it as `text/plain` (`404` if the pane is unknown).

### Changed
- **Cross-platform browser launch:** `openBrowser` now detects WSL (via `/proc/version`) and defers to the Windows browser (`cmd.exe /c start`) instead of the usually-absent `xdg-open`. (`server.js`)
- **"Update Kilo" now kills processes on Linux/macOS:** `killAllKiloProcesses` previously returned early on anything but Windows; it now `pkill`s Kilo CLI processes on POSIX too (never the Kiloton server), so `npm install -g` can replace the binary cleanly. (`lib/server/routes.js`)
- **Tightened `/lib` static route:** only `/lib/dir.js` (the helper the client actually imports) is served now, instead of the entire `lib/` tree (which exposed `lib/server/*` to the browser). (`server.js`)
- **Docker image:** `KILO_VERSION` pin aligned between `Dockerfile` and `docker-compose.yml` (now `7.4.5`), and the base image moved `node:24-slim` -> `node:22-slim` so `node-pty` prebuilds are used (smaller, more reliable build). (`Dockerfile`, `docker-compose.yml`)
- **Scrollback capture efficiency:** per-pane scrollback now stores raw PTY chunks in a byte-capped FIFO ring instead of splitting every chunk into lines and shifting an array per line - same replay/copy behavior, far less work on hot terminal output. (`public/app.js`)

- **Backend**
  - **O(1) pane lookup (D1):** an in-memory `configIndex` (`Map<paneId,{dash,pane}>`) rebuilt on config load/save; `findPaneById`/`patchPane` use it instead of a per-event linear scan.
  - **Synchronous flush on lifecycle (D5):** start/stop/exit transitions write `config.json` immediately; high-frequency field edits keep the 150ms debounce.
  - **Validated start input (D4):** `normalizeStartInput()` trims/clamps `POST /api/instances`, rejects an empty `task` in task mode, bounds `rows`/`cols` (1–500), and returns `400` on bad input.
  - **Eager kilo resolve (E5):** the binary is resolved once at boot with a clear warning if it is missing.
  - **Stable start-failure state (D3):** `failPane()` sets `status:"error"` + a reason so a failed launch shows *why* instead of a generic `500`.
  - Earlier 0.2.0 refactors: de-duplicated `startInstance`, single `findPaneById` finder, `validateConfig` moved to `lib/validate.js`, centralized logging via `lib/log.js`, brand wordmark links to GitHub (bee emoji dropped).
  - **Split server into modules (D2):** `server.js` is now a thin orchestrator. Runtime state + lifecycle live in `lib/server/state.js`; HTTP routes in `lib/server/routes.js`; the WebSocket bridge in `lib/server/ws.js`; auth in `lib/server/auth.js`; auto-restart in `lib/server/autorestart.js`; transcript capture in `lib/server/transcript.js`. Internal refactoring only — no user-facing behavior change.

- **Client**
  - **Render perf (E1/E2/E3/E6):** only re-fit panes that changed size / were re-attached, memoized tabs + selection UI, client-side save debounce (~200ms), and removed leftover debug `console.error`s.
  - **Plain copy & paste (B3):** copy now uses the silent `execCommand` path (no clipboard/notification popups); selection is no longer auto-copied — only explicit Copy / `Ctrl`+`Shift`+`C` / copy-dir copies.
  - Earlier 0.2.0 CSS: consistent button sizing + `:focus-visible` outline; removed the confirm prompt from the per-pane hamburger delete.

### Fixed

#### UI / client
- **Per-pane hamburger menu no longer clipped:** the menu is now `position: fixed` and viewport-positioned (with a scroll fallback), so its controls (Stop/Restart/Remove/Duplicate, transcript copy/download) stay reachable even in dense grids where the pane's `overflow: hidden` previously cut it off. (`public/app.js`, `public/style.css`)
- **Crash when closing the last dashboard:** an empty dashboard set made `render` throw and brick the UI; closing the last dashboard now creates a fresh one instead. (`public/app.js`)
- **Client scrollback no longer leaks:** a pane's captured scrollback is now pruned when the pane is removed (was retaining ~160KB per removed pane). (`public/app.js`)
- **Cross-tab sync hardened:** the remote config is now shape-validated (a malformed/older-tab config can't make `render()` throw in the receiving tab), and `syncConnections` no longer tears down a locally-running pane on a stale remote update; reconnect attempts reset correctly. (`public/app.js`)
- **Terminal/PTY size desync on layout change:** resizing a pane via the `ResizeObserver` (e.g. clicking **Auto** / "auto sort", or changing rows×cols) now also pushes the new `cols`/`rows` to the PTY over the WebSocket, and the `ResizeObserver` synchronous fit is no longer the only re-fit — `renderGrid` now flags every attached pane with `needsFit` so it is re-fit on the next animation frame (after layout settles). Previously a running TUI (vim/`htop`/etc.) kept rendering at the old size, and freshly re-laid-out terminals measured a transient size and showed a black gap / were left undersized. `fitTerminal` also forces a full viewport repaint (`term.refresh`) right after `term.resize`, clearing the black gap below a freshly-shrunk terminal and the black right columns seen when scrolling back through history after a terminal was widened. (`public/app.js`)
- **Terminal mouse (B1):** the `Terminal` is constructed with `allowProposedApi: true` and `term.focus()` is called on (re)attach so mouse-tracking apps (vim/`less`/ncurses) receive events; the running-pane overlay is `display:none` and never intercepts clicks. *(Still worth a real-browser check in `vim`/`htop`.)*
- **Right-click menu (B2):** now dismisses on click-away, `Esc`, window blur/scroll/resize.
- **Topbar dividers:** exactly one separator between the Kilo info and the health summary, plus the previously-missing divider after the summary.
- **Pane-header "slit":** removed the hamburger's stray `margin-left:auto` gap and the empty-label chip (`.pane-label:empty { display:none }`) that drew a tiny box between the session dropdown and the hamburger.
- **Help button:** now a keyboard SVG icon instead of the `?` text.
- **Per-pane hamburger menu spilling off-screen:** the menu was always anchored to the button's right edge, which pushed half of it off the left of the screen when the wrapping header put the `⋮` button near the left (e.g. in the leftmost pane). It now opens leftward when there is room and rightward otherwise, always staying inside the pane. It also flips above the button instead of overflowing the bottom. (`public/app.js`)
- **Oversized pane header when only one row is used:** removed the forced `min-height: 64px` on `.pane-head` so the header collapses to a single row's height for a few agents, and still grows to two rows when the controls wrap. (`public/style.css`)
- **Client polish:** scrollback comment deduplicated; the hamburger `opened` flag renamed to `nowHidden`; the port label now shows the real `location.host` (not hardcoded `localhost`); grid `max="12"` removed (auto-grid can exceed it); `live` declaration hoisted before its closures; `updateSessionOptions` hoisted to module scope; a duplicate Ctrl+Shift+V paste path removed (the capture handler already forwards paste, avoiding double input); the `#recentDirs` datalist is now created at boot so autocomplete is available immediately. (`public/app.js`, `public/index.html`)
- **First-paint session dropdowns populated:** `boot()` now loads sessions before the first `render()`, so pane session `<select>`s no longer flash empty on load. (`public/app.js`)
- **Client hygiene:** removed a production `globalThis.__kilotonApp` test-hook leak from `app.js`, and corrected the paste help text to `Ctrl`/`Cmd` + `V`. (`public/app.js`, `public/index.html`)
- **`boot()` failure surfaces an error:** `boot()` now has a top-level `.catch()` that renders a visible "Failed to load dashboard" message instead of a silently blank UI. (`public/app.js`)
- **Ctrl/Cmd+Enter gates on `typing`:** the start shortcut no longer fires while typing in a header field, consistent with the other shortcuts. (`public/app.js`)
- **Redundant `updateSessionOptions()` removed:** the post-`render()` call in `boot()` was dead work (panes already populate session options from pre-loaded sessions); the refresh call is kept. (`public/app.js`)
- **Reconnect-exhaustion reset persisted:** clearing `pane.instanceId` on reconnect exhaustion now calls `saveConfig()`, so the reset is written to disk. (`public/app.js`)

#### Server / backend
- **`validateConfig` hardened:** panes without a string `id`, and duplicate pane ids across dashboards, are now rejected (duplicate ids collided in the pane index). (`lib/validate.js`)
- **`POST /api/config` no longer persists client-authored runtime fields** (`status`/`instanceId`/`exitCode`/`error`/`autoRestartAttempts`), preventing server/client desync from a stale config push. (`lib/server/routes.js`)
- **`POST /api/kilo/update` serialized + timer-safe:** concurrent updates now return `409`, pending auto-restart backoff timers are cleared before reinstalling, and a second WebSocket for a pane no longer orphans the previous socket. (`lib/server/routes.js`, `lib/server/ws.js`)
- **Robustness: PTY socket errors no longer crash the server:** `spawnKilo` now attaches an `error` handler to the pty, so a single bad terminal connection is logged instead of throwing an uncaught exception that killed every running agent. (`lib/spawn.js`)
- **Stop during auto-restart backoff now wins:** a manual Stop cancels the pending respawn timer, so an agent is no longer silently relaunched after you stopped it in the 2-60s backoff window. (`lib/server/autorestart.js`, `lib/server/state.js`)
- **Config lost on shutdown:** `shutdown()` called `loadConfig()` (a no-op for flushing) instead of `flushConfig()`, so the last <=150ms of debounced edits could be dropped on `Ctrl+C` / `SIGTERM`. It now calls `flushConfig()`, which drains the debounce timer and writes synchronously. (`server.js`, `lib/config.js`)
- **Health poll blocked the event loop every 5s:** `getKiloVersion()` shelled out to `npm ls -g` synchronously on each `/api/health` poll. It is now memoized (invalidated only when the Kilo binary is re-resolved, e.g. after an update), removing a recurring blocking `execSync`. (`lib/spawn.js`)
- **Earlier 0.2.0 bugs:** quoted directory paths now resolve (client + server quote-stripping); bulk delete actually removes selected panes; the `instances` Map no longer leaks exited panes; `getKiloBin()` no longer spawns `node kilo` for the bare-command fallback.
- **Auto-approve scope (no Kilo bug):** `--auto` is forwarded only for **Task**-mode panes; **Interactive** panes (the default) never receive it, so the checkbox only affects Task mode. Unit tests added.
- **Explicit `KILO_BIN_PATH` is now honored (D3 / FailPane):** `resolveKiloBin` previously ignored a missing explicit `KILO_BIN_PATH` and silently fell back to the real `kilo`, so a bad binary never surfaced; it now passes the explicit path through, so a missing one makes the spawn throw and the pane lands in `status:"error"` with a reason (caught by the e2e D3 scenario). The corresponding unit test was updated to the new contract.
- **Autostart no longer double-spawns orphaned agents:** the boot autostart path now calls `killAllKiloProcesses()` (Windows + POSIX) *before* re-spawning saved panes, so a Kilo agent orphaned by a previously crashed server is cleared first — guaranteeing a single instance per pane on autostart. (`server.js`, `lib/server/killKilo.js`)
- **`startInstance` clears a pending auto-restart timer:** a manual Start/Restart during the auto-restart backoff window is no longer clobbered — the freshly started instance is no longer killed and respawned when the stale timer fires. (`lib/server/state.js`)
- **Boot no longer crashes on a malformed-but-parseable `config.json`:** `readFromDisk` now validates the structure (`dashboards`/`panes` arrays) and falls back to the default config if it is mistyped, instead of throwing a `TypeError` and taking the server down. (`lib/config.js`)
- **PTY `error` now leaves a recoverable state:** a terminal pty `error` emitted without a follow-up `exit` sets the pane to `status:"error"` and cleans up the instance, instead of leaving it stuck `running` with a dead pty. (`lib/spawn.js`)
- **`npm install -g` no longer uses a shell:** the update path's `execFile` call dropped `shell: true` (argv is already validated). (`lib/server/routes.js`)
- **Redundant `findPane` wrapper removed:** inlined into `findPaneById` at its only call site. (`lib/server/state.js`, `lib/server/routes.js`)
- **Concurrent "Update Kilo" now guarded correctly:** `updateInFlight` is cleared only after the `npm install -g` actually completes (both success and error branches) — a second in-flight `POST /api/kilo/update` can no longer launch a parallel install. (`lib/server/routes.js`)
- **Dead `Set-Cookie` fallback removed:** the unencoded raw-header cookie fallback in the `GET /` handler was dropped; the server always uses Express's `res.cookie`. (`server.js`)
- **`POST /api/kilo/update` no longer locks itself out:** version/pkg validation now runs BEFORE `updateInFlight` is set, so an invalid-version `400` can't leave the flag stuck `true` (which previously made every later update return `409` until restart). (`lib/server/routes.js`)
- **`config.json` no longer stores runtime timers:** `writeConfig` now strips underscore-prefixed runtime keys (e.g. `_restartTimer`) from each pane before serializing, so a pending auto-restart `Timeout` object can't pollute `config.json`. The in-memory config is untouched. (`lib/config.js`)
- **Async pty-error reason now persisted:** the async pty `error` path now passes the error message into `onStatus`, which persists it to `pane.error`, so a pane that dies from an async terminal error shows `status:"error"` with a real reason (the synchronous missing-binary case already did via `failPane`). (`lib/spawn.js`, `lib/server/state.js`)
- **Windows `killAllKiloProcesses` match tightened:** the win32 kill filter now targets `@kilocode/cli` / `bin/kilo` (matching the POSIX branch) instead of the bare substring `kilo`, so an unrelated local node script whose path contains "kilo" is no longer caught. (`lib/server/killKilo.js`)

#### Security
- **Token-authenticated dashboard is now reachable on LAN:** with `KILOTON_TOKEN` set, a valid `GET /?token=` now sets a `kiloton_token` session cookie (`HttpOnly`, `SameSite=Lax`); `tokenFromReq`/`wsAllowed` also accept the cookie, so the browser auto-attaches it to the HTML, static assets, API, and WebSocket — the dashboard UI no longer breaks under token auth. (`server.js`, `lib/server/auth.js`)
- **Constant-time token compare:** `lib/server/auth.js` now compares the token with `crypto.timingSafeEqual` instead of `===`. (`lib/server/auth.js`)
- **JSON body size limit:** `express.json()` is now bounded to `1mb` to mitigate large-payload abuse on the config/instances APIs. (`server.js`)
- **Token-cookie flow regression-tested:** the D6 e2e suite now asserts `GET /?token=` returns `Set-Cookie: kiloton_token=...; HttpOnly; SameSite=Lax` and that follow-up same-origin requests authenticate via the cookie alone. (`test/e2e.mjs`)
- **Token cookie now `Secure` over HTTPS:** the `kiloton_token` session cookie sets `Secure` only when the request was served over HTTPS (`req.secure` or `x-forwarded-proto: https`), so plain-HTTP LAN deployments keep working while proxied HTTPS is protected. (`server.js`)

#### CI, tests & docs
- **CI:** the `b1-mouse` and `client-e2e` jsdom suites are now run in CI (they cover the menu, cross-tab sync, and scrollback fixes) alongside lint + unit. (`.github/workflows/ci.yml`)
- **CI gates on `npm audit`:** `.github/workflows/ci.yml` now runs `npm audit --audit-level=high` after `npm ci`, failing the build on known high-severity advisories. (`.github/workflows/ci.yml`)
- **CI fixed — `test:client-e2e` script added:** `.github/workflows/ci.yml` referenced a missing `npm run test:client-e2e` script (CI failed on every run); the script now exists in `package.json`. (`.github/workflows/ci.yml`, `package.json`)
- **Removed unused `@xterm/addon-fit` dependency:** it was declared and statically served (`/vendor/addon-fit`) but never imported by the client; dropped from `package.json`, the static route, and the e2e assertion, with `package-lock.json` re-synced so `npm ci` still works. (`package.json`, `server.js`, `test/e2e.mjs`)
- **README Docker wording aligned to `node:22-slim`:** the Docker section previously claimed `node:24-slim`; it now matches the `Dockerfile` (and CI matrix), which use `node:22-slim`. (`README.md`)
- **Misleading spawn comment fixed:** the duplicated "version" comment above `resolveKiloBinAtBoot` (which resolves the binary) was corrected/removed. (`lib/spawn.js`)
- **Docs:** README no longer recommends Node 24 (image/CI/prebuilds are 18/20/22); the CI description now lists `npm audit` + `test:b1` + `test:client-e2e` and the local gate command includes `test:b1`; `REVIEW.md`'s stale addon-fit assertion note was corrected. (`README.md`, `REVIEW.md`)
- **Docs:** `REVIEW.md` no longer falsely claims the lockfile pins `@xterm/addon-fit` (it was removed), and its title now reads 0.2.0. (`REVIEW.md`)
- **Tailscale access documented:** README adds an "Access from another network (Tailscale)" section for running the server at home and opening the dashboard from another machine (bind `0.0.0.0` + `KILOTON_TOKEN`; open `http://<tailscale-ip>:<port>/?token=...`). (`README.md`)
- **e2e now guards the update path + token-cookie replay:** `test/e2e.mjs` adds the invalid-version `400` test (and confirms the guard resets, not permanent lockout) and a cookie-replay assertion — a follow-up same-origin request authenticates via the `kiloton_token` cookie alone. The valid-update/`409` path is intentionally not exercised here because it calls `killAllKiloProcesses()` system-wide. (`test/e2e.mjs`)
- **Docs:** `.env.example` auth wording clarified (default open; set `KILOTON_TOKEN` to require a token). (`.env.example`)

### Known limitations
- **`saveConfig()` is fire-and-forget:** the debounced save returns immediately; persistence is guaranteed only on `pagehide` (`flushConfig`). By design.
- **xterm scrollbar hidden by design:** the terminal scrollbar is fully hidden; wheel and keyboard scrolling still work.

## [0.1.0]

Initial release.