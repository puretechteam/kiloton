// Tiny centralized logger so the `[lifecycle]` tag and the log sink stay
// consistent across server + spawn code without pulling in a dependency.

function line(msg) {
  return `[lifecycle] ${msg}`;
}

export function log(level, msg) {
  if (level === "error") console.error(line(msg));
  else console.log(line(msg));
}
