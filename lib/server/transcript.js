// Bounded, efficient transcript capture for a running pane.
//
// Every byte the PTY emits is appended here so a client can fetch a pane's
// *full* transcript (Q6) — far beyond the client's small scrollback ring. The
// buffer is capped at `maxBytes` and behaves as a FIFO: once the cap is hit the
// oldest chunks are dropped, so a long-lived agent can't grow the server's
// memory without bound.

export function makeTranscriptRing(maxBytes = 2_000_000) {
  let parts = [];
  let size = 0;
  return {
    append(d) {
      d = String(d);
      if (!d) return;
      parts.push(d);
      size += d.length;
      while (size > maxBytes && parts.length > 1) {
        size -= parts[0].length;
        parts.shift();
      }
    },
    toString() {
      return parts.join("");
    },
    get length() {
      return size;
    },
    clear() {
      parts = [];
      size = 0;
    },
  };
}
