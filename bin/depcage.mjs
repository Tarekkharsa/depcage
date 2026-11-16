#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { buildPolicy } from "../src/policy.mjs";
import { runSandboxed, supportReason } from "../src/run.mjs";

const HELP = `depcage — run a command with your secrets hidden, the network limited
and writes kept inside the project.

Usage
  depcage [options] <command> [args...]
  depcage demo                      show a simulated attack with and without depcage

Examples
  depcage npm install               only the package registry is reachable
  depcage pnpm add left-pad
  depcage npm test                  no internet; local servers still work
  depcage node scripts/build.js

Options
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
`;

const say = (line) => process.stderr.write(`\x1b[2mdepcage: ${line}\x1b[0m\n`);
const fail = (line) => { process.stderr.write(`depcage: ${line}\n`); process.exit(2); };

function parse(args) {
  const o = { allowNet: [], allowWrite: [], allowRead: [], keepEnv: [] };
  const lists = { "--allow-net": "allowNet", "--allow-write": "allowWrite", "--allow-read": "allowRead", "--keep-env": "keepEnv" };
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { i++; break; }
    if (!a.startsWith("-")) break;
    const [flag, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = () => inline ?? args[++i] ?? fail(`${flag} needs a value`);
    if (lists[flag]) o[lists[flag]].push(value());
    else if (flag === "--mode") { o.mode = value(); if (!["install", "run"].includes(o.mode)) fail("--mode is install or run"); }
    else if (flag === "--no-local") o.local = false;
    else if (flag === "--local") o.local = true;
    else if (flag === "--browser") o.browser = true;
    else if (flag === "--print-policy") o.printPolicy = true;
    else if (flag === "-q" || flag === "--quiet") o.quiet = true;
    else if (flag === "-h" || flag === "--help") o.help = true;
    else if (flag === "-v" || flag === "--version") o.version = true;
    else fail(`unknown option ${flag}. Options go before the command; see depcage --help`);
  }
  return { options: o, argv: args.slice(i) };
}

function ownDirs() {
  const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dirs = [here];
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

const { options, argv } = parse(process.argv.slice(2));
if (options.version) {
  console.log(JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  process.exit(0);
}
if (options.help || argv.length === 0) { process.stdout.write(HELP); process.exit(options.help ? 0 : 2); }

if (argv[0] === "demo" && argv.length === 1) {
  const { demo } = await import("../src/demo.mjs");
  process.exit(await demo());
}

const reason = supportReason();
if (reason) fail(`${reason} The command was not run.`);

let policy;
try {
  policy = buildPolicy({ argv, cwd: process.cwd(), home: os.homedir(), otherHomes: accountHome(), env: process.env, platform: process.platform, options, ownDirs: ownDirs(), uid: process.getuid?.() });
} catch (err) { fail(err.message); }

if (options.printPolicy) {
  console.log(JSON.stringify({ mode: policy.mode, project: policy.root, ...policy.config, withheldEnv: policy.withheldEnv }, null, 2));
  process.exit(0);
}

if (!options.quiet) {
  const net = policy.config.network.allowedDomains;
  const parts = [
    `${policy.mode} mode`,
    "internet: " + (net.length ? net.join(", ") : "off"),
    // Linux gives the sandbox a localhost of its own; macOS can share this computer's.
    "localhost: " + (process.platform === "linux" ? "private to the sandbox" : policy.allowLocal ? "on" : "off"),
    "writes: " + path.basename(policy.root) + "/" + (policy.mode === "install" ? " + package cache" : ""),
  ];
  say(parts.join(" · "));
  if (policy.systemTrust) say("pnpm may use the macOS certificate service (needed by pnpm 12)");
  if (policy.withheldEnv.length) say(`not passed on: ${policy.withheldEnv.join(", ")} (--keep-env NAME to pass one)`);
  if (policy.mode === "install" && !options.allowRead.length && fs.existsSync(path.join(os.homedir(), ".npmrc"))) {
    say("~/.npmrc is hidden, so private registry logins and registry settings in it do not apply (--allow-read ~/.npmrc to use it)");
  }
}

for (const dir of policy.ensureDirs) { try { fs.mkdirSync(dir, { recursive: true }); } catch {} }

try {
  const { code, blocked } = await runSandboxed({ argv, policy, cwd: process.cwd() });
  if (blocked.length && !options.quiet) {
    say(`blocked ${blocked.length} network destination${blocked.length > 1 ? "s" : ""}: ${blocked.slice(0, 8).join(", ")}${blocked.length > 8 ? ", …" : ""}`);
    say(`if you trust one, run again with: depcage --allow-net ${blocked[0].replace(/:\d+$/, "")} ${argv[0]} …`);
  }
  const hiddenRc = options.allowRead.length ? [] : [".npmrc", ".yarnrc.yml"].filter((f) => fs.existsSync(path.join(os.homedir(), f)));
  if (code !== 0 && path.basename(argv[0]) === "yarn" && hiddenRc.length && !options.quiet) {
    say(`yarn 1 stops when it cannot read ~/${hiddenRc[0]}. If that is the error above: depcage --allow-read ~/${hiddenRc[0]} ` + argv.join(" "));
  }
  if (code !== 0 && process.platform === "darwin" && !options.browser && !options.quiet && usesBrowserTests(policy.root)) {
    say("if a browser failed to start: Chromium needs one extra permission on macOS. Run again with: depcage --browser " + argv.join(" "));
  }
  if (code !== 0 && ["vp", "vpx"].includes(path.basename(argv[0])) && policy.mode === "install" && !options.quiet) {
    say("Vite+ cannot download Node.js or a package manager from inside depcage: those programs run outside it later, so their folder stays read-only. If that is the error above, fetch them once with: vp pm config get registry");
  }
  process.exit(code);
} catch (err) {
  fail(`${err.message} The command was not run.`);
}
