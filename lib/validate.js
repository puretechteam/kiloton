// Validate an incoming dashboard config body. Returns a human-readable error
// string, or `null` when the config is acceptable. Kept in its own module so it
// can be unit-tested without booting the server (server.js imports it).

const START_MODES = new Set(["interactive", "task", "resume"]);

export function validateConfig(body) {
  if (!body || !Array.isArray(body.dashboards)) {
    return "dashboards must be an array";
  }
  for (const d of body.dashboards) {
    if (!d || typeof d.id !== "string" || typeof d.name !== "string" ||
        typeof d.rows !== "number" || typeof d.cols !== "number" ||
        !Array.isArray(d.panes)) {
      return "each dashboard needs id/name/rows/cols/panes";
    }
    for (const p of d.panes) {
      if (!p || typeof p.id !== "string") {
        return "each pane needs a string id";
      }
    }
  }
  const seen = new Set();
  for (const d of body.dashboards) {
    for (const p of d.panes) {
      if (seen.has(p.id)) return "pane ids must be unique across all dashboards";
      seen.add(p.id);
    }
  }
  return null;
}

// D4: validate the body of `POST /api/instances`. Rejects a bad `mode`, a
// missing `task` in task mode, and out-of-range `rows`/`cols`. Returns a
// human-readable error string, or `null` when the input is acceptable. The
// trimming/normalization of the accepted values happens in
// `normalizeStartInput` (server.js), kept separate so the same shape check can
// be unit-tested without spawning anything.
export function validateStartInput(body) {
  if (!body || typeof body !== "object") return "body must be an object";
  if (body.paneId !== undefined && typeof body.paneId !== "string") {
    return "paneId must be a string";
  }
  if (body.mode !== undefined && typeof body.mode !== "string") {
    return "mode must be a string";
  }
  if (body.mode !== undefined && !START_MODES.has(body.mode)) {
    return `invalid mode: ${body.mode}`;
  }
  if (body.mode === "task" &&
      (!body.task || typeof body.task !== "string" || !body.task.trim())) {
    return "task mode requires a non-empty task";
  }
  if (body.rows !== undefined &&
      (!Number.isInteger(body.rows) || body.rows < 1 || body.rows > 500)) {
    return "rows must be an integer between 1 and 500";
  }
  if (body.cols !== undefined &&
      (!Number.isInteger(body.cols) || body.cols < 1 || body.cols > 500)) {
    return "cols must be an integer between 1 and 500";
  }
  return null;
}
