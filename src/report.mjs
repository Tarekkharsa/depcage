// `depcage report`: what the sandbox stopped, from the history depcage keeps on this computer.
import path from "node:path";

const times = (n) => (n === 1 ? "1 time" : `${n} times`);

function tally(items) {
  const m = new Map();
  for (const i of items) m.set(i, (m.get(i) || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * @param {object[]} history entries from readHistory()
 * @param {object} o
 * @param {string|null} o.root   project to report on, or null for every project
 * @param {number} o.days
 * @param {number} [o.now]
 * @returns {string}
 */
export function formatReport(history, { root, days, now = Date.now(), color = false }) {
  const bold = (s) => (color ? `\x1b[1m${s}\x1b[0m` : s);
  const dim = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  const since = now - days * 86_400_000;
  const runs = history.filter((e) => Date.parse(e.t) >= since && (root === null || e.root === root));
  const where = root === null ? "all projects" : path.basename(root);
  const lines = [bold(`depcage report: ${where}, last ${days} days`), ""];
  if (!runs.length) {
    lines.push("No commands recorded yet. Run a command through depcage first, for example: depcage npm test");
    return lines.join("\n") + "\n";
  }

  const caged = runs.filter((e) => e.mode !== "direct"), direct = runs.filter((e) => e.mode === "direct");
  const installs = caged.filter((e) => e.mode === "install").length;
  lines.push(`  Commands run inside the sandbox   ${caged.length}  (${installs} installs, ${caged.length - installs} others)`);
  if (direct.length) {
    lines.push(`  Commands run without it           ${direct.length}  ${dim("(" + tally(direct.map((e) => e.cmd)).slice(0, 4).map(([c, n]) => `${c} ×${n}`).join(", ") + ")")}`);
  }
  if (root === null) lines.push(`  Projects                          ${new Set(runs.map((e) => e.root)).size}`);

  const blocked = caged.flatMap((e) => (e.blocked || []).map((host) => ({ host, cmd: e.cmd })));
  lines.push("", bold("  Network destinations blocked"));
  if (!blocked.length) lines.push("    none");
  for (const [host, n] of tally(blocked.map((b) => b.host)).slice(0, 15)) {
    const by = tally(blocked.filter((b) => b.host === host).map((b) => b.cmd)).slice(0, 2).map(([c]) => c).join(", ");
    lines.push(`    ${host.padEnd(38)} ${times(n).padEnd(10)} ${dim("from: " + by)}`);
  }

  const held = tally(caged.flatMap((e) => e.withheld || []));
  lines.push("", bold("  Secret-looking environment variables held back"));
  if (!held.length) lines.push("    none");
  for (const [name, n] of held.slice(0, 15)) lines.push(`    ${name.padEnd(38)} ${dim("in " + n + " of " + caged.length + " commands")}`);

  lines.push("", dim("  Secrets in your home folder were unreadable in every sandboxed command. Blocked attempts to"), dim("  read or write files are not listed: the command sees them as ordinary errors."));
  return lines.join("\n") + "\n";
}
