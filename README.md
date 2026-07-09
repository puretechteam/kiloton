# 🐝 Kiloton

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-2ea043)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933)
![Kilo CLI](https://img.shields.io/badge/kilo%20cli-7.4.3-9cf)
![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-0.1.0-ffd700)
![Docker](https://img.shields.io/badge/docker-supported-0db7ed)

> Run many **Kilo CLI** agents in one place — a small local dashboard of live
> terminal panes you control from your browser.

Kiloton lets you launch and watch **lots of Kilo coding agents at once**, each in
its own terminal, organized however you like. Start brand-new chats, **reopen an old
chat by its session id**, or run **autonomous tasks** — all side by side.

- Running **6 agents on Kilo's free Gateway**? Open a 2×3 grid and hit *Start all*.
- Running **30 agents** against providers you already pay for? Spread them across
  several dashboards and bring-your-own API keys via environment variables.

No Electron, no native installs beyond Node.js. It is a local web page backed by a
tiny Node server.

---

## Table of contents

- [What you need](#what-you-need)
- [Install & first launch](#install--first-launch)
- [A 2-minute tour](#a-2-minute-tour)
- [Your first agents](#your-first-agents)
  - [Interactive (new chat)](#interactive-new-chat)
  - [Resume an old chat by id](#resume-an-old-chat-by-id)
  - [Task (autonomous)](#task-autonomous)
- [Organizing many agents](#organizing-many-agents)
- [Providers & credentials](#providers--credentials)
- [Configuration reference](#configuration-reference)
- [Docker](#docker)
- [Updating](#updating)
- [Running many agents (practical advice)](#running-many-agents-practical-advice)
- [Troubleshooting](#troubleshooting)
- [Tests](#tests)
- [License](#license)

---

## What you need

| Requirement | Why |
| --- | --- |
| **Node.js 18+** (20/22/24 recommended) | Runs the dashboard server and spawns Kilo. |
| **The Kilo CLI** (`kilo`) installed | Kiloton drives the `kilo` command you already use. Install once with `npm install -g @kilocode/cli`. |
| **A web browser** | The dashboard is a web page (Chrome, Edge, Firefox, Safari…). |
| **Kilo account / keys (optional)** | The free **Kilo Gateway** works with no key. Bring-your-own keys are optional (see [Providers](#providers--credentials)). |

That's it. On first launch the dashboard opens itself in your browser.

---

## Install & first launch

Don't worry if you've never done this — follow the steps in order. You'll type a
few commands into a terminal (the black window where you already run
`node server.js`).

### 0. Install Node.js (one time)

Kiloton runs on **Node.js**, which also gives you the `npm` command.

1. Go to <https://nodejs.org> and download the **LTS** version.
2. Run the installer and click through with the default options (Windows /
   macOS), or on Linux install it via your package manager, e.g.
   `sudo apt install -y nodejs npm` on Debian/Ubuntu.
3. To confirm it worked, open a terminal and run `node -v` — you should see a
   version number like `v20.x.x`.

Also install the Kilo CLI once (so Kiloton has something to launch):

```bash
npm install -g @kilocode/cli
```

### 1. Put the project files in a folder

- **Easiest:** download the project as a ZIP, unzip it, and remember where the
  folder is (the one containing `server.js`).
- **If you use git:** `git clone https://github.com/puretechteam/kiloton.git`
  then `cd kiloton`.

### 2. Open a terminal *in that folder*

- **Windows:** open the folder in File Explorer, click the address bar, type
  `cmd`, and press Enter. (Or right-click in the folder and choose *Open in
  Terminal*.)
- **macOS:** open the **Terminal** app, type `cd ` (with a space), then drag the
  project folder onto the Terminal window and press Enter.
- **Linux:** open your terminal app and run `cd /path/to/the/folder`.

You'll know you're in the right place if you run `dir` (Windows) or `ls`
(macOS/Linux) and see `server.js` listed.

### 3. Install the dashboard's dependencies (one time)

In that terminal, run:

```bash
npm install
```

This downloads the small set of packages Kiloton needs. It can take a minute the
first time. You only need to do it once (re-run it if you update the files).

### 4. Start the dashboard

```bash
npm start
```

That's the same as running `node server.js` directly — use whichever you like.
It prints a local address and opens your browser to
<http://localhost:7655>. If the browser doesn't open on its own, just visit that
address yourself.

To **stop** it: click the terminal and press `Ctrl+C`.

> Your layout is saved automatically to `config.json` next to `server.js`, so
> next time you just run `npm start` (or `node server.js`) and you're back where
> you left off.

### Notes

- **Windows** auto-opens with `cmd /c start`; **macOS** with `open`; **Linux**
  with `xdg-open` (needs a desktop environment — on a headless Linux box, start
  with `npm start -- --no-open` and open the URL yourself).
- If you'd rather it not pop a browser: `npm start -- --no-open`, or set
  `KILOTON_NO_OPEN=1`.
- The server listens on `127.0.0.1` (your own machine) by default. Only set
  `KILOTON_HOST=0.0.0.0` to expose it on a trusted local network.

---

## A 2-minute tour

| Region | What it is |
| --- | --- |
| Tabs (top) | Each tab is a dashboard — an independent grid of terminals. `+ Dashboard` adds one; `✕` closes it (and stops its agents). |
| Layout bar | Set `Rows` / `Cols` and `Apply grid` for the active dashboard; `+ Pane` adds a terminal. |
| `▶ Start all` / `■ Stop all` | Launch or stop every pane in the current dashboard at once — spin up your whole hive with one click. |
| Each pane | One Kilo agent. Status dot: green = running, grey = stopped, red = exited. Controls: mode, dir, model, agent, auto, session, task, and Start / Stop / ↻. |

- **Dashboards = tabs.** Each tab is an independent grid of terminals.
- **Each pane = one Kilo agent.** Set its mode, working folder, and options, then
  **Start**. A colored dot shows `running` (green) / `stopped` (grey) / `exited` (red).
- **Empty panes** show a short hint: *"Set a directory / session above, then click Start to launch a Kilo agent here."*
- **Start all / Stop all** launch or stop every pane in the current dashboard at once
  — perfect for spinning up your whole hive with one click.

---

## Your first agents

### Interactive (new chat)

1. In a pane, leave **Mode** on `Interactive`.
2. Set **dir** to the project folder the agent should work in (e.g. `C:\Projects\myapp`
   or `/workspace/myapp`). If the folder doesn't exist, Kiloton falls back to its own
   folder so nothing breaks.
3. Click **Start**. The terminal fills with Kilo's interface — type your request and
   chat as you normally would.

### Resume an old chat by id

1. Click **⟳ Sessions** in the top bar to refresh the session list (fetched from
   `kilo session list`).
2. Set the pane **Mode** to `Resume`.
3. Pick a session from the dropdown (it shows `session-id — title`).
4. Click **Start**. That exact previous conversation reopens, history included.

> No list? Make sure the dashboard is running where your sessions are stored (your
> machine, or the mounted volume in Docker — see [Docker](#docker)).

### Task (autonomous)

1. Set **Mode** to `Task`.
2. Type a **prompt** (the work you want done).
3. Tick **auto** to let the agent approve its own steps (hands-off).
4. Click **Start**. Kilo runs the task and shows progress live in the pane.

Environment variables for providers are passed straight through to each agent (see
[Providers](#providers--credentials)), so `Task` works with Kilo's Gateway or any
key you've set.

---

## Organizing many agents

- **Rows / Cols + Apply grid** sets the pane layout for the active dashboard.
  Examples: `2 × 3` = 6 terminals; `3 × 2` = 6; `2 × 4` = 8.
- **+ Dashboard** adds a tab; close a tab with the **✕** (stops its agents).
- **+ Pane** adds a terminal to the current dashboard; **Apply grid** reflows them.
- **▶ Start all** starts every pane in the tab — the easiest way to launch your hive.
- Everything is **saved automatically** to `config.json` and restored next time.

Suggested layouts:

| You run… | Try |
| --- | --- |
| ~6 agents (free plan) | One dashboard, `2 × 3` or `3 × 2`, then **Start all**. |
| ~12 agents | Two dashboards of `2 × 3`. |
| ~30 agents | Three+ dashboards (e.g. `2 × 4` each); group by project or purpose. |

---

## Providers & credentials

**Out of the box, nothing to configure.** Kilo's free **Gateway** is used when no key
is set, so `Interactive` / `Resume` / `Task` just work.

To use a provider you already pay for, set its API key as an **environment variable**
before starting Kiloton (or in `docker-compose.yml`). Keys are inherited by every
agent process:

| Variable | Use |
| --- | --- |
| `KILO_API_KEY` | Kilo Gateway / credits |
| `ANTHROPIC_API_KEY` | Anthropic Claude |
| `OPENAI_API_KEY` | OpenAI |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Google Gemini |
| (any provider key `kilo` supports) | Passed through unchanged |

> **Note:** Kiloton's own server variables are *not* inherited by agents. Anything
> starting with `KILOTON_` (and `KILO_BIN_PATH`) is stripped from each agent's
> environment, so an agent never sees the dashboard's port or config path. Your
> provider keys (above) are kept and passed through unchanged.

You can also pin a model per pane with the **model** field (e.g. `anthropic/claude-3-5-sonnet`)
and an **agent** with the agent field. These map to `kilo -m` / `--agent`.

---

## Configuration reference

**Environment variables (server)**

| Variable | Default | Purpose |
| --- | --- | --- |
| `KILOTON_PORT` | `7655` | HTTP/WebSocket port. |
| `KILOTON_HOST` | `127.0.0.1` | Interface to bind (localhost by default). Set `0.0.0.0` to expose on a network. |
| `KILOTON_CONFIG` | `./config.json` | Path to the saved layout file. |
| `KILO_BIN_PATH` | auto | Explicit path to the `kilo` binary if it isn't resolved automatically. |
| `KILOTON_NO_OPEN` | unset | Set to `1` to disable auto-opening the browser. Also `--no-open`. |
| `KILOTON_NO_ORIGIN_CHECK` | unset | Set to `1` to disable the same-origin guard on the API (only safe behind a reverse proxy that strips `Origin`, or on a fully trusted network). |

**Security:** Kiloton spawns real `kilo` processes (which can run tasks/commands), so
it binds to `127.0.0.1` by default. Only set `KILOTON_HOST=0.0.0.0` on a trusted
network, and never expose the port to the public internet. There is no auth on the
API/WebSocket — it is intended for local use only.

**`config.json`**

| Field | Meaning |
| --- | --- |
| `kiloBin` | `"auto"` (recommended) or a path. |
| `autostart` | If `true`, panes that have an `instanceId` are relaunched when the server starts. |
| `dashboards[]` | Each tab: `id`, `name`, `rows`, `cols`, and `panes[]`. |
| `panes[].mode` | `interactive` / `resume` / `task`. |
| `panes[].dir` | Working folder for the agent. |
| `panes[].model` / `agent` | Optional `-m` / `--agent` overrides. |
| `panes[].auto` | For `task`: pass `--auto` (self-approve). |
| `panes[].sessionId` | For `resume`: the session to reopen. |
| `panes[].task` | For `task`: the prompt. |
| `panes[].instanceId` / `status` / `exitCode` | Runtime state (managed for you). |

**Ops endpoints** (useful for headless / Docker / monitoring):

| Endpoint | Returns |
| --- | --- |
| `GET /api/health` | `{ ok, uptime, runningInstances, kiloVersion }` — process uptime, live pane count, and the installed Kilo CLI version. |
| `GET /api/instances` | `[{ paneId, status, exitCode }]` for every running/stopped instance. |
| `GET /api/version` | `{ version }` — the Kiloton dashboard version (matches `package.json`). |

`POST /api/config` validates its body (`dashboards` must be an array of well-formed
dashboards) and returns `400` otherwise; it also kills any orphaned agent whose pane no
longer exists in the saved layout.

---

## Docker

Everything — the dashboard **and** the Kilo agents it spawns — can run inside a
container.

### Build & run

```bash
docker build -t kiloton .
docker run --rm -p 7655:7655 \
  -v "$PWD/workspace:/workspace" \
  -v "$PWD/data:/data" \
  kiloton
```

Open <http://localhost:7655> and set each pane's **dir** to a path under
`/workspace`. The default pane directory is `/workspace`.

### docker compose

```bash
docker compose up --build
```

`docker-compose.yml` mounts `./workspace` (your code) and `./data` (Kiloton's layout,
survives restarts), and includes commented volumes to **share your host Kilo data and
config** so you can resume real host sessions and reuse host auth:

```yaml
# Linux/macOS:
- ${HOME}/.local/share/kilo:/root/.local/share/kilo
- ${HOME}/.config/kilo:/root/.config/kilo
# Windows (PowerShell ${USERPROFILE}):
- ${USERPROFILE}/.local/share/kilo:/root/.local/share/kilo
- ${USERPROFILE}/.config/kilo:/root/.config/kilo
```

Set provider keys in `docker-compose.yml` under `environment:` (e.g. `OPENAI_API_KEY`).

> The container has no browser, so `--no-open` is implied there; connect from your
> host machine's browser at the published port (on macOS / Windows with Docker
> Desktop that's simply <http://localhost:7655> — the published port is mapped to
> your host's localhost automatically).

---

## Running many agents (practical advice)

- **Group by dashboard.** Separating projects or teams into tabs keeps each grid
  readable and makes *Start all* meaningful per group.
- **Resources.** Each agent is a real `kilo` process. 6 is light; 30 is fine on a
  capable machine but uses more CPU/RAM — size the host accordingly.
- **Shared database.** All agents write to Kilo's global session database
  (`~/.local/share/kilo/kilo.db`). Under very heavy concurrent load you may occasionally
  see a SQLite lock error. If that happens, stagger starts (e.g. use *Start all*, which
  launches sequentially) or split agents across more dashboards. Normal interactive and
  task use is unaffected.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Browser didn't open | Visit the printed URL manually, or run `npm start -- --no-open` and open it yourself. |
| Pane shows `exited` immediately | The agent process ended (bad session id, auth, or model). Check the terminal output; for `resume`, confirm the id exists via **⟳ Sessions**. |
| "Port in use" | Another Kiloton is running, or set `KILOTON_PORT=7656` (or any free port). |
| Sessions list is empty | The dashboard isn't looking at your sessions — run it on the machine (or mounted volume, in Docker) that holds them. |
| Can't resume a host session in Docker | Mount your host `~/.local/share/kilo` and `~/.config/kilo` as shown above. |
| `kilo` not found | Reinstall the CLI globally (`npm install -g @kilocode/cli`), or set `KILO_BIN_PATH`. |

---

## Updating

**If you downloaded a ZIP** (the easy way): just download the new ZIP, replace
your project folder with the new files, then run `npm install` once and
`npm start` (or `node server.js`) again. Your `config.json` (your saved layout)
is separate and won't be touched, so your panes come back.

**If you used git**: updates are pulled straight from GitHub — no need to dig
through files by hand. Your layout (`config.json`) and `node_modules` are
git-ignored, so a pull never clobbers your setup.

```bash
npm run update      # git pull --ff-only + npm install
```

Then **restart the dashboard** (click the terminal and press `Ctrl+C`, then
`npm start` again) to pick up the new code. Run it whenever you want the latest
changes; it's safe to run often.

> Notes: `npm run update` needs a **git clone** — it runs `git pull`, so it won't
> work from a downloaded ZIP (use the ZIP steps above instead). `git pull
> --ff-only` only applies clean fast-forwards, so as long as you haven't edited
> tracked files it always updates cleanly. If you ever hit a conflict, reset your
> local changes (`git reset --hard`) and pull again — your `config.json` is
> untouched. For scheduled updates you can point a weekly task/scheduler at
> `npm run update`.

---

## Tests

The suite boots the real server and drives the actual `kilo` CLI — no browser or
network required (it proves the agent *process* starts, streams its TUI, and stops;
sending prompts is left to you).

```bash
npm test            # core suite + scaling to 6 agents (your typical case)
npm run test:stress # scales to 30 agents (power-user case)
```

It covers: server boot, asset serving, session listing, interactive/resume/task
lifecycles, restart, invalid inputs, unknown-pane 404s, multiple dashboards, autostart,
environment passthrough (`KILO_BIN_PATH` + provider keys — and that `KILOTON_*` vars are
*not* leaked to agents), model/agent passthrough (`-m` / `--agent`), the `/api/version`
endpoint, malformed-config `400`s, the `/api/health` and `/api/instances` shapes, and
concurrent scaling.

---

## Known issues

These are known limitations of the 0.1.0 release (not blockers, just expectations):

- **One viewer per pane.** A pane's terminal stream is delivered to a single
  browser tab. Opening the same pane in a second tab/window will "steal" the
  stream from the first. To watch from two places, open two separate panes.
- **Updates force-stop every Kilo instance.** `npm run update` (and the in-app
  *Update* button) reinstalls the global `kilo` CLI. On Windows the binary is
  file-locked by any running Kilo session, so **all** Kilo instances on the
  machine are force-stopped first — including the chat you may be using. The
  Kiloton server itself keeps running; restart your panes afterward.
- **Exited panes keep their layout slot.** When an agent finishes (or errors)
  the pane turns red and shows its exit code; it stays in the grid so you can
  read the output and click **Start** to relaunch. It is not auto-removed.
- **Docker `KILOTON_HOST` is `0.0.0.0`.** The compose file binds to all
  interfaces so your host browser can reach the container. Only run that on a
  trusted network (see [Security](#configuration-reference)).
- **SQLite lock under very heavy load.** See [Running many agents](#running-many-agents-practical-advice).

---

## License

MIT — see [LICENSE](./LICENSE).
