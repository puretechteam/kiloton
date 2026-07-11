// D6 — optional `KILOTON_TOKEN` auth for the API and the WebSocket upgrade.
//
// When `KILOTON_TOKEN` is set at boot the server requires it on every request
// and WebSocket upgrade, so `KILOTON_HOST=0.0.0.0` on a LAN is actually safe to
// expose. The token is accepted via either:
//   - the `Authorization: Bearer <token>` header,
//   - a `?token=<token>` query parameter, or
//   - the `kiloton_token` cookie (set by `GET /` once a valid `?token=` is
//     seen, so a LAN browser can auto-present it on asset/API/WS requests).
//
// When no token is configured the guard is a no-op and behaviour is unchanged
// (local-only, as before).
//
// S1: a browser top-level navigation (and the assets/WS it pulls in) can't send
// an `Authorization` header, so we also accept the token via the `kiloton_token`
// cookie. The `GET /` route sets that cookie once a valid `?token=` is seen, so
// the dashboard is reachable on a LAN.

import crypto from "crypto";
import { Buffer } from "node:buffer";

// Constant-time token comparison that never throws: handles undefined inputs
// and length mismatches (returns false rather than throwing, which
// `crypto.timingSafeEqual` would on unequal-length buffers).
export function tokenMatches(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function tokenFromCookie(req) {
  const cookie = req.headers && req.headers.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === "kiloton_token") return part.slice(i + 1).trim();
  }
  return null;
}

export function createAuth(token) {
  const enabled = !!token;
  const expected = token || "";

  function tokenFromReq(req) {
    const auth = req.headers && req.headers.authorization;
    if (auth && /^Bearer\s+/i.test(auth)) {
      return auth.replace(/^Bearer\s+/i, "").trim();
    }
    try {
      const u = new URL(req.url, "http://localhost");
      const t = u.searchParams.get("token");
      if (t) return t;
    } catch {}
    // S1: same-origin cookie (set by `GET /` after a valid `?token=`).
    return tokenFromCookie(req);
  }

  function httpMiddleware(req, res, next) {
    if (!enabled) return next();
    const t = tokenFromReq(req);
    if (tokenMatches(t, expected)) return next();
    res.status(401).json({ error: "unauthorized" });
  }

  // Returns true when the request/ws-upgrade is allowed to proceed. The cookie
  // path (S1) is covered via tokenFromReq.
  function wsAllowed(req) {
    if (!enabled) return true;
    const t = tokenFromReq(req);
    return tokenMatches(t, expected);
  }

  return { enabled, expected, httpMiddleware, wsAllowed, tokenFromReq, tokenMatches };
}
