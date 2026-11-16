#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { buildPolicy, directReason, resolveRoot, INFO_ONLY } from "../src/policy.mjs";
import { runSandboxed, supportReason } from "../src/run.mjs";
import { ALLOW_KINDS, changeSetting, commandLabel, projectSettings, readHistory, recordRun, storeDir } from "../src/store.mjs";

const HELP = `depcage — run a command with your secrets hidden, the network limited
and writes kept inside the project.

Usage
  depcage [options] <command> [args...]
  depcage setup                     sandbox the package manager commands you type, from now on
  depcage report                    what the sandbox blocked in this project
  depcage allow net <host>          remember a permission for this project (see below)
  depcage demo                      show a simulated attack with and without depcage

Examples
  depcage npm install               only the package registry is reachable
  depcage pnpm add left-pad
  depcage npm test                  no internet; local servers still work
  depcage node scripts/build.js

Options (before the command)
  --allow-net <host>     also allow this host (repeatable; *.example.com works)
  --allow-write <path>   also allow writing to this path (repeatable)
  --allow-read <path>    stop hiding this path, for example ~/.npmrc (repeatable)
  --keep-env <NAME>      pass this environment variable even if it looks secret
  --no-local             block connections to this computer (localhost) too
  --local                allow them (the default for everything except installs)
  --mode <install|run>   choose the policy by hand instead of from the command
  --browser              let the command start a browser (Playwright, Puppeteer) on macOS
  --print-policy         show the policy for this command and exit
  -q, --quiet            do not print the summary lines
  -h, --help
  -v, --version

depcage setup [--shell zsh|bash] [--remove]
  Adds a block to your shell start-up file. After that npm, npx, pnpm, yarn, bun and vp run
  inside the sandbox without typing depcage. Commands that need your account or change
  programs for the whole computer (npm publish, npm login, npm install -g) run without it.
  Skip the sandbox for one command with: DEPCAGE=off npm ...

depcage allow [--remove] <net HOST | read PATH | write PATH | env NAME | browser>
  Remembers a permission for the project you are in, so you do not repeat the option.
  Without arguments it shows what is remembered. Kept in ~/.config/depcage, which sandboxed
  commands cannot change.

depcage report [--all] [--days N]
  Network destinations that were blocked and variables that were held back, for this
  project or for all of them. The history never leaves this computer.
`;

const say = (line) => process.stderr.write(`\x1b[2mdepcage: ${line}\x1b[0m\n`);
const fail = (line) => { process.stderr.write(`depcage: ${line}\n`); process.exit(2); };

function parse(args) {
  const o = { allowNet: [], allowWrite: [], allowRead: [], keepEnv: [] };
  const lists = { "--allow-net": "allowNet", "--allow-write": "allowWrite", "--allow-read": "allowRead", "--keep-env": "keepEnv" };
  let i = 0, literal = false;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { i++; literal = true; break; }
    if (!a.startsWith("-")) break;
    const [flag, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = () => inline ?? args[++i] ?? fail(`${flag} needs a value`);
    if (lists[flag]) o[lists[flag]].push(value());
    else if (flag === "--mode") { o.mode = value(); if (!["install", "run"].includes(o.mode)) fail("--mode is install or run"); }
    else if (flag === "--no-local") o.local = false;
    else if (flag === "--local") o.local = true;
    else if (flag === "--browser") o.browser = true;
    else if (flag === "--auto") o.auto = true; // set by the shell hook from `depcage setup`
    else if (flag === "--print-policy") o.printPolicy = true;
    else if (flag === "-q" || flag === "--quiet") o.quiet = true;
    else if (flag === "-h" || flag === "--help") o.help = true;
    else if (flag === "-v" || flag === "--version") o.version = true;
    else fail(`unknown option ${flag}. Options go before the command; see depcage --help`);
  }
  // after `--` the next word is always a program to run, even if it is called "setup"
  return { options: o, argv: args.slice(i), literal };
}

function ownDirs() {
  const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dirs = [here, storeDir(os.homedir())]; // the tool's code and what it remembers
  try { dirs.push(path.dirname(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime/package.json"))); } catch {}
  return dirs;
}

function usesBrowserTests(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return ["@playwright/test", "playwright", "playwright-core", "puppeteer", "puppeteer-core"].some((n) => pkg.devDependencies?.[n] || pkg.dependencies?.[n]);
  } catch { return false; }
}

// $HOME can be pointed elsewhere; the account's real home holds secrets either way.
function accountHome() { try { return [os.userInfo().homedir]; } catch { return []; } }
const here = () => ({ cwd: process.cwd(), home: os.homedir(), otherHomes: accountHome() });

/** Runs a command as it is, with no sandbox. Used by the shell hook for account commands. */
function runDirect(argv) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
    const forward = (sig) => child.kill(sig);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, forward);
    child.on("error", (err) => { process.stderr.write(`depcage: ${argv[0]}: ${err.code === "ENOENT" ? "command not found" : err.message}\n`); resolve(127); });
    child.on("close", (code, signal) => resolve(signal ? 128 + (os.constants.signals[signal] || 1) : code ?? 1));
  });
}

async function setupCommand(args) {
  const { setup } = await import("../src/hook.mjs");
  let shell = path.basename(process.env.SHELL || ""), remove = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--remove") remove = true;
    else if (args[i] === "--shell") shell = args[++i] || fail("--shell needs a value");
    else if (args[i].startsWith("--shell=")) shell = args[i].slice(8);
    else fail(`unknown setup option ${args[i]}`);
  }
  let result;
  try { result = setup({ shell, home: os.homedir(), env: process.env, remove }); } catch (err) { fail(err.message); }
  const file = result.file.replace(os.homedir(), "~");
  if (remove) console.log(result.changed ? `Removed the depcage block from ${file}. Open a new terminal to finish.` : `There is no depcage block in ${file}.`);
  else {
    console.log(result.changed ? `Added the depcage block to ${file}.` : `${file} already has the current depcage block.`);
    console.log(`Open a new terminal (or run: source ${file}). From then on npm, npx, pnpm, yarn, bun and vp`);
    console.log("commands you type run inside the sandbox. Scripts, editors and CI are not affected.");
    console.log("Skip it for one command with DEPCAGE=off in front. Undo with: depcage setup --remove");
    if (process.platform === "linux") console.log("On Linux, dev servers (npm run dev, npm start) run without the sandbox, because a server inside it cannot be opened from your browser.");
  }
  return 0;
}

function allowCommand(args) {
  const remove = args.includes("--remove");
  const [kind, value, ...extra] = args.filter((a) => a !== "--remove");
  const home = os.homedir();
  let root;
  try { root = resolveRoot(here()); } catch (err) { fail(err.message); }
  const show = (s) => {
    const rows = [["net", s.allowNet], ["read", s.allowRead], ["write", s.allowWrite], ["env", s.keepEnv], ["browser", s.browser ? ["yes"] : []]].filter(([, v]) => v.length);
    console.log(`Remembered for ${path.basename(root)}:` + (rows.length ? "" : " nothing"));
    for (const [k, v] of rows) console.log(`  ${k.padEnd(8)} ${v.join(", ")}`);
  };
  if (!kind) { show(projectSettings(home, root)); return 0; }
  if (!ALLOW_KINDS.includes(kind) || extra.length) fail("usage: depcage allow [--remove] <net HOST | read PATH | write PATH | env NAME | browser>");
  if (kind !== "browser" && !value) fail(`depcage allow ${kind} needs a value`);
  let stored = value;
  if (kind === "net" && !/^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(value)) fail(`"${value}" does not look like a host name (example.com or *.example.com)`);
  if (kind === "env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) fail(`"${value}" does not look like a variable name`);
  if (kind === "read" || kind === "write") stored = path.resolve(value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value);
  try { show(changeSetting(home, root, kind, stored, remove)); } catch (err) { fail(`could not save: ${err.message}`); }
  return 0;
}

async function reportCommand(args) {
  const { formatReport } = await import("../src/report.mjs");
  let days = 30, all = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--all") all = true;
    else if (args[i] === "--days") days = Number(args[++i]);
    else if (args[i].startsWith("--days=")) days = Number(args[i].slice(7));
    else fail(`unknown report option ${args[i]}`);
  }
  if (!(days > 0)) fail("--days needs a number above 0");
  let root = null;
  if (!all) { try { root = resolveRoot(here()); } catch { all = true; } }
  process.stdout.write(formatReport(readHistory(os.homedir()), { root: all ? null : root, days, color: process.stdout.isTTY }));
  return 0;
}

const { options, argv, literal } = parse(process.argv.slice(2));
if (process.env.DEPCAGE_QUIET === "1") options.quiet = true;
if (options.version) {
  console.log(JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  process.exit(0);
}
if (options.help || argv.length === 0) { process.stdout.write(HELP); process.exit(options.help ? 0 : 2); }

if (!literal && !options.auto) {
  if (argv[0] === "demo" && argv.length === 1) {
    const { demo } = await import("../src/demo.mjs");
    process.exit(await demo());
  }
  if (argv[0] === "setup") process.exit(await setupCommand(argv.slice(1)));
  if (argv[0] === "allow") process.exit(allowCommand(argv.slice(1)));
  if (argv[0] === "report") process.exit(await reportCommand(argv.slice(1)));
}

const home = os.homedir();
const started = Date.now();
const record = (root, mode, code, blocked = [], withheld = []) =>
  recordRun(home, { t: new Date(started).toISOString(), root, cmd: commandLabel(argv), mode, code, ms: Date.now() - started, blocked, withheld });

// A command that is already inside the sandbox (a project script that calls depcage, started
// from a sandboxed `npm run`) cannot start a second one, and does not need to. The marker alone
// is not trusted: the home folder must also be read-only, as it only is inside the sandbox.
function alreadyInside() {
  if (process.env.DEPCAGE_INSIDE !== "1") return false;
  try { fs.accessSync(home, fs.constants.W_OK); return false; } catch { return true; }
}
if (alreadyInside()) process.exit(await runDirect(argv));

const reason = supportReason();
if (reason && options.auto) process.exit(await runDirect(argv)); // the hook must never break a shell
if (reason) fail(`${reason} The command was not run.`);

if (options.auto) {
  const why = directReason(argv);
  if (why) {
    if (why === INFO_ONLY) process.exit(await runDirect(argv));
    if (!options.quiet) say(`not sandboxed: ${why}`);
    const code = await runDirect(argv);
    let root = process.cwd();
    try { root = resolveRoot(here()); } catch {}
    record(root, "direct", code);
    process.exit(code);
  }
}

let policy;
try {
  const root = resolveRoot(here());
  const saved = projectSettings(home, root);
  for (const key of ["allowNet", "allowRead", "allowWrite", "keepEnv"]) options[key] = [...new Set([...saved[key], ...options[key]])];
  options.browser ||= saved.browser;
  policy = buildPolicy({ argv, ...here(), env: process.env, platform: process.platform, options, ownDirs: ownDirs(), uid: process.getuid?.() });
} catch (err) {
  if (options.auto) fail(`${err.message}\nThe command was not run. To run it without the sandbox: DEPCAGE=off ${argv.join(" ")}`);
  fail(err.message);
}

if (options.printPolicy) {
  console.log(JSON.stringify({ mode: policy.mode, project: policy.root, ...policy.config, withheldEnv: policy.withheldEnv }, null, 2));
  process.exit(0);
}

const npmrcHidden = !options.allowRead.length && fs.existsSync(path.join(home, ".npmrc"));
if (!options.quiet) {
  const net = policy.config.network.allowedDomains;
  const internet = "internet: " + (net.length ? net.join(", ") : "off");
  if (options.auto) {
    // typed many times a day: one line
    const held = policy.withheldEnv.length;
    say(`${policy.mode} mode · ${internet}` + (held ? ` · ${held} secret-looking variable${held > 1 ? "s" : ""} held back` : ""));
  } else {
    say([
      `${policy.mode} mode`, internet,
      // Linux gives the sandbox a localhost of its own; macOS can share this computer's.
      "localhost: " + (process.platform === "linux" ? "private to the sandbox" : policy.allowLocal ? "on" : "off"),
      "writes: " + path.basename(policy.root) + "/" + (policy.mode === "install" ? " + package cache" : ""),
    ].join(" · "));
    if (policy.systemTrust) say("pnpm may use the macOS certificate service (needed by pnpm 12)");
    if (policy.withheldEnv.length) say(`not passed on: ${policy.withheldEnv.join(", ")} (--keep-env NAME to pass one)`);
    if (policy.mode === "install" && npmrcHidden) {
      say("~/.npmrc is hidden, so private registry logins and registry settings in it do not apply (--allow-read ~/.npmrc to use it)");
    }
  }
}

policy.env.DEPCAGE_INSIDE = "1";
for (const dir of policy.ensureDirs) { try { fs.mkdirSync(dir, { recursive: true }); } catch {} }

try {
  const { code, blocked } = await runSandboxed({ argv, policy, cwd: process.cwd() });
  record(policy.root, policy.mode, code, blocked, policy.withheldEnv);
  const typed = options.auto ? argv.join(" ") : "depcage " + argv.join(" ");
  if (blocked.length && !options.quiet) {
    const host = blocked[0].replace(/:\d+$/, "");
    say(`blocked ${blocked.length} network destination${blocked.length > 1 ? "s" : ""}: ${blocked.slice(0, 8).join(", ")}${blocked.length > 8 ? ", …" : ""}`);
    say(`if you trust one: depcage allow net ${host}   (remembered for this project), or once: depcage --allow-net ${host} ${argv[0]} …`);
  }
  if (code !== 0 && !options.quiet) {
    const hiddenRc = options.allowRead.length ? [] : [".npmrc", ".yarnrc.yml"].filter((f) => fs.existsSync(path.join(home, f)));
    if (path.basename(argv[0]) === "yarn" && hiddenRc.length) {
      say(`yarn 1 stops when it cannot read ~/${hiddenRc[0]}. If that is the error above: depcage allow read ~/${hiddenRc[0]}`);
    } else if (options.auto && policy.mode === "install" && npmrcHidden) {
      say("~/.npmrc is hidden. If a private registry refused the install: depcage allow read ~/.npmrc");
    }
    if (process.platform === "darwin" && !options.browser && usesBrowserTests(policy.root)) {
      say("if a browser failed to start: Chromium needs one extra permission on macOS. Remember it with: depcage allow browser");
    }
    if (["vp", "vpx"].includes(path.basename(argv[0])) && policy.mode === "install") {
      say("Vite+ cannot download Node.js or a package manager from inside depcage: those programs run outside it later, so their folder stays read-only. If that is the error above, fetch them once with: DEPCAGE=off vp pm config get registry");
    }
    // not after every failing test run: only when the sandbox is a likely cause
    if (options.auto && (blocked.length || policy.mode === "install")) say(`to run it once without the sandbox: DEPCAGE=off ${typed}`);
  }
  process.exit(code);
} catch (err) {
  fail(`${err.message} The command was not run.`);
}
