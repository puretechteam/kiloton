import { execFile } from "child_process";
import { getKiloCommand } from "./spawn.js";

export function listSessions() {
  return new Promise((resolve, reject) => {
    const [node, bin] = getKiloCommand();
    execFile(
      node,
      [bin, "session", "list"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) {
          reject(err);
          return;
        }
        const out = stdout || "";
        const fromJson = parseJson(out);
        if (fromJson) return resolve(fromJson);
        resolve(parseText(out));
      }
    );
  });
}

function normalize(s) {
  const id = s.id || (s.session && s.session.id) || "";
  if (!id) return null;
  return {
    id,
    title: s.title || s.name || s.summary || s.session?.title || "",
    updated: s.updated || s.time || s.timestamp || "",
  };
}

function parseJson(out) {
  try {
    const data = JSON.parse(out);
    const arr = Array.isArray(data) ? data : Array.isArray(data?.sessions) ? data.sessions : null;
    if (!arr) return null;
    const mapped = arr.map(normalize).filter(Boolean);
    return mapped.length ? mapped : null;
  } catch {
    return null;
  }
}

function parseText(out) {
  const res = [];
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\r/g, "").trim();
    if (!/^ses_/.test(line)) continue;
    const parts = line.split(/\s{2,}/);
    if (parts.length >= 3) {
      res.push({
        id: parts[0],
        title: parts.slice(1, -1).join(" "),
        updated: parts[parts.length - 1],
      });
    }
  }
  return res;
}
