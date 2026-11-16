// Runs one command inside the sandbox and reports what was blocked.
// Fails closed: if the sandbox cannot be set up, the command is not run at all.
import { spawn, execFileSync } from "node:child_process";
import { constants as osConstants } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

// Every process started under `pid`, with its start time (so a reused pid is never mistaken for it).
function descendants(pid) {
  let out;
  try { out = execFileSync("ps", ["-axo", "pid=,ppid=,lstart="], { encoding: "utf8" }); } catch { return new Map(); }
  const rows = out.split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(l)).filter(Boolean);
  const found = new Map(), queue = [pid];
  while (queue.length) {
    const parent = queue.shift();
    for (const [, p, pp, started] of rows) if (+pp === parent && !found.has(+p)) { found.set(+p, started.trim()); queue.push(+p); }
  }
  return found;
}
const startedAt = (pid) => {
  try { return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { return ""; }
};

// A signal sent to depcage alone (a stop button, a supervisor) only reaches the first process.
// Some tools then exit and leave their children running, for example a dev server. Those get a
// moment to finish by themselves and are then stopped.
async function stopLeftovers(procs) {
  const alive = () => [...procs].filter(([pid, started]) => startedAt(pid) === started).map(([pid]) => pid);
  for (const [signal, waitMs] of [[null, 500], ["SIGTERM", 1500], ["SIGKILL", 0]]) {
    if (signal) for (const pid of alive()) { try { process.kill(pid, signal); } catch {} }
    for (let waited = 0; waited < waitMs && alive().length; waited += 50) await sleep(50);
    if (!alive().length) return;
  }
}

const quote = (args) => args.map((a) => (/^[A-Za-z0-9_\/:=.,@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");

// Yarn 2 and later ignores HTTPS_PROXY and reads variables of its own. The sandbox proxy is
// only known inside the sandbox, so it is copied there, just before the command starts.
const YARN_PROXY = '[ -n "$HTTPS_PROXY" ] && export YARN_HTTPS_PROXY="$HTTPS_PROXY" YARN_HTTP_PROXY="${HTTP_PROXY:-$HTTPS_PROXY}"; exec ';

// The sandbox runtime has no setting for "this program may not be started", so on macOS
// the rule is added to the profile it generates. A rule can only be added if the profile
// has the expected shape; otherwise the run is refused rather than left half-protected.
const EXEC_ALLOW = "(allow process-exec)\n";
export function denyExecMacOS(wrapped, programs) {
  if (!programs.length) return wrapped;
  const unsafe = programs.find((p) => !/^[A-Za-z0-9_\/.@+-]+$/.test(p));
  if (unsafe) throw new Error(`cannot block a program with an unusual path: ${unsafe}`);
  if (wrapped.split(EXEC_ALLOW).length !== 2) throw new Error("the sandbox profile has an unexpected shape (unsupported sandbox-runtime version?)");
  const rule = `(deny process-exec ${programs.map((p) => `(literal "${p}")`).join(" ")})\n`;
  return wrapped.replace(EXEC_ALLOW, EXEC_ALLOW + rule);
}

// Chromium (Playwright, Puppeteer) passes ports between its own processes through a named
// channel. The sandbox refuses unknown names, so the browser stops at start. Only with --browser.
const CHROMIUM_CHANNEL = String.raw`(global-name-regex #"^org\.chromium\.Chromium\.MachPortRendezvousServer\.[0-9]+$")`;
export function allowBrowserMacOS(wrapped) {
  if (wrapped.split(EXEC_ALLOW).length !== 2) throw new Error("the sandbox profile has an unexpected shape (unsupported sandbox-runtime version?)");
  return wrapped.replace(EXEC_ALLOW, EXEC_ALLOW + `(allow mach-register ${CHROMIUM_CHANNEL})\n(allow mach-lookup ${CHROMIUM_CHANNEL})\n`);
}

export function supportReason(platform = process.platform) {
  if (platform === "darwin" || platform === "linux") return null;
  if (platform === "win32") return "Windows is not supported yet. It works inside WSL 2.";
  return `the platform "${platform}" is not supported.`;
}

/**
 * @returns {Promise<{code: number, blocked: string[]}>} exit code of the command and the
 *   network destinations that were refused.
 */
export async function runSandboxed({ argv, policy, cwd, stdio = "inherit", onChild }) {
  const reason = supportReason();
  if (reason) throw new Error(reason);
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  const deps = SandboxManager.checkDependencies();
  if (deps.errors.length) throw new Error("the sandbox cannot start: " + deps.errors.join("; "));

  await SandboxManager.initialize(policy.config);
  let child;
  try {
    let wrapped = await SandboxManager.wrapWithSandbox(YARN_PROXY + quote(argv));
    if (process.platform === "darwin") wrapped = denyExecMacOS(wrapped, policy.denyExec || []);
    if (process.platform === "darwin" && policy.browser) wrapped = allowBrowserMacOS(wrapped);
    child = spawn(wrapped, { shell: true, stdio, cwd, env: policy.env });
    onChild?.(child);
  } catch (err) {
    await SandboxManager.reset().catch(() => {});
    throw err;
  }
  const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
  let leftovers = new Map();
  const forward = (sig) => {
    leftovers = new Map([...leftovers, ...descendants(child.pid)]);
    child.kill(sig);
  };
  for (const sig of SIGNALS) process.on(sig, forward);

  const result = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  }).finally(async () => {
    if (leftovers.size) await stopLeftovers(leftovers);
    for (const sig of SIGNALS) process.off(sig, forward);
  });

  const blocked = new Set();
  for (const v of SandboxManager.getSandboxViolationStore().getViolations(1000)) {
    const m = /^deny network-outbound (\S+)/.exec(v.line);
    if (m) blocked.add(m[1]);
  }
  try { SandboxManager.cleanupAfterCommand?.(); } catch {}
  await SandboxManager.reset().catch(() => {});

  const code = result.signal ? 128 + (osConstants.signals[result.signal] || 1) : result.code ?? 1;
  return { code, blocked: [...blocked].sort() };
}
