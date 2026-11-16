// What depcage remembers between runs: per-project permissions and a history of what was
// blocked. Both live in the home folder, which a sandboxed command cannot write to, so the
// code being sandboxed cannot widen its own permissions or edit the record.
import fs from "node:fs";
import path from "node:path";

export const storeDir = (home) => path.join(home, ".config", "depcage");
const settingsFile = (home) => path.join(storeDir(home), "projects.json");
const historyFile = (home) => path.join(storeDir(home), "history.jsonl");

const KINDS = { net: "allowNet", read: "allowRead", write: "allowWrite", env: "keepEnv" };
export const ALLOW_KINDS = [...Object.keys(KINDS), "browser"];

function readAll(home) {
  try {
    const data = JSON.parse(fs.readFileSync(settingsFile(home), "utf8"));
    return data && typeof data.projects === "object" && data.projects ? data : { projects: {} };
  } catch { return { projects: {} }; }
}

/** Permissions remembered for one project, in the shape of command-line options. */
export function projectSettings(home, root) {
  const p = readAll(home).projects[root] || {};
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  return { allowNet: list(p.allowNet), allowRead: list(p.allowRead), allowWrite: list(p.allowWrite), keepEnv: list(p.keepEnv), browser: p.browser === true };
}

/** Adds or removes one remembered permission. Returns the project's settings afterwards. */
export function changeSetting(home, root, kind, value, remove = false) {
  const all = readAll(home);
  const p = (all.projects[root] ||= {});
  if (kind === "browser") {
    if (remove) delete p.browser; else p.browser = true;
  } else {
    const key = KINDS[kind];
    const next = new Set(Array.isArray(p[key]) ? p[key] : []);
    if (remove) next.delete(value); else next.add(value);
    if (next.size) p[key] = [...next].sort(); else delete p[key];
  }
  if (!Object.keys(p).length) delete all.projects[root];
  fs.mkdirSync(storeDir(home), { recursive: true });
  const tmp = settingsFile(home) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
  fs.renameSync(tmp, settingsFile(home));
  return projectSettings(home, root);
}

const MAX_HISTORY_BYTES = 2_000_000;

/** One line per command. Only names are kept: never argument values, never variable values. */
export function recordRun(home, entry) {
  try {
    fs.mkdirSync(storeDir(home), { recursive: true });
    const file = historyFile(home);
    try {
      if (fs.statSync(file).size > MAX_HISTORY_BYTES) {
        const lines = fs.readFileSync(file, "utf8").split("\n");
        fs.writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join("\n"));
      }
    } catch {}
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch {} // a record that cannot be written must never stop the command
}

export function readHistory(home) {
  let text;
  try { text = fs.readFileSync(historyFile(home), "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { const e = JSON.parse(line); if (e && typeof e.t === "string") out.push(e); } catch {}
  }
  return out;
}

/**
 * "npm install", "pnpm test": the tool and the word right after it, nothing else. A word that
 * follows an option could be that option's value (a token, a password), so it is never kept.
 */
export function commandLabel(argv) {
  const tool = path.basename(argv[0] || "");
  const word = argv[1] || "";
  return /^[A-Za-z][A-Za-z0-9:_.-]{0,40}$/.test(word) ? `${tool} ${word}` : tool;
}
