// Pure directory-path helper shared by the browser client and the server.
//
// File explorers (e.g. Windows "Copy as path") hand back a path wrapped in
// quotes; strip a single layer of surrounding single/double quotes so the
// directory still resolves. No DOM / node APIs — safe to import in the browser
// and in unit tests.

export function cleanDir(v) {
  if (!v) return "";
  let s = String(v).trim();
  while ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}
