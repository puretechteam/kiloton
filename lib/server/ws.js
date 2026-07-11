// D2 — WebSocket TUI bridge, registered against an existing `WebSocketServer`.
//
// Forwards terminal I/O between the browser and the pane's PTY, plus `resize`
// control messages. Auth (D6) and the same-origin guard (already a global
// middleware) are enforced on the upgrade here too.

export function attachWs(server, wss, ctx) {
  const { S, auth, originOk, ENFORCE_ORIGIN } = ctx;

  wss.on("connection", (ws, req) => {
    // D6: require the token on the upgrade when one is configured.
    if (auth.enabled && !auth.wsAllowed(req)) {
      ws.close();
      return;
    }
    if (ENFORCE_ORIGIN && !originOk(req)) {
      ws.close();
      return;
    }
    const paneId = decodeURIComponent((req.url || "").split("?")[0].split("/").pop());
    const inst = S.instances.get(paneId);
    if (!inst || !inst.pty) {
      ws.close();
      return;
    }
    if (inst.ws && inst.ws !== ws) { try { inst.ws.close(); } catch {} }
    inst.ws = ws;
    ws.send(JSON.stringify({ type: "status", status: inst.status, exitCode: inst.exitCode }));

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
        S.resizeInstance(inst, msg.cols, msg.rows);
      } else if (msg.type === "data" && typeof msg.data === "string") {
        inst.pty.write(msg.data);
      }
    });

    ws.on("close", () => {
      if (inst.ws === ws) inst.ws = null;
      // A3: if the agent already exited, the viewer detaching is the last
      // chance to clean up the leaked Map entry.
      if (inst.status === "exited" && S.instances.get(paneId) === inst) {
        S.instances.delete(paneId);
      }
    });
  });
}
