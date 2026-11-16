// Turns "what command is being run, and where" into a sandbox policy.
// Pure functions: nothing here starts a process or reads a secret.
import fs from "node:fs";
import path from "node:path";

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const FETCH_AND_RUN = new Set(["npx", "pnpx", "bunx"]);
const VP_TOOLS = new Set(["vp", "vpx", "vpr"]);
// Sub-commands that fetch packages from the registry (and may run their install scripts).
const INSTALL_VERBS = new Set([
  "install", "i", "ci", "add", "update", "up", "upgrade", "rebuild", "dedupe", "remove", "uninstall", "rm", "un",
  "install-test", "it", "install-ci-test", "cit", "create", "init", "import", "fetch", "prune",
  "audit", "outdated", "install-scripts", "approve-builds", "view", "info", "show",
]);
// Fetch-and-run sub-commands differ per tool: `npm exec` downloads, `pnpm exec` does not.
const FETCH_VERBS = { npm: ["exec", "x"], pnpm: ["dlx"], yarn: ["dlx", "set"], bun: ["x"] }; // `yarn set version` downloads Yarn
const RUN_VERBS = new Set(["run", "run-script", "test", "t", "tst", "start", "stop", "restart", "exec", "node"]);

// Vite+ (`vp`) puts its own sub-commands in front of whichever package manager the project uses.
const VP_FETCH_VERBS = ["migrate", "dlx"];
const VP_RUN_VERBS = new Set([
  "dev", "build", "preview", "pack", "lint", "fmt", "format", "check", "staged", "cache", "config", "hooks",
  "toolchain", "list", "ls", "why", "explain", "link", "ln", "unlink", "help",
]);
// The order Vite+ itself uses to pick the package manager; with nothing declared it uses pnpm.
const VP_PM_FILES = [
  ["pnpm-workspace.yaml", "pnpm"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], [".yarnrc.yml", "yarn"],
  ["package-lock.json", "npm"], ["bun.lock", "bun"], ["bun.lockb", "bun"], [".pnpmfile.cjs", "pnpm"],
  ["pnpmfile.cjs", "pnpm"], ["bunfig.toml", "bun"], ["yarn.config.cjs", "yarn"],
];
const pmName = (spec) => /^(npm|pnpm|yarn|bun)(@|$)/.exec(typeof spec === "string" ? spec : "")?.[1];
export function vitePlusPackageManager(root, env = {}) {
  const forced = pmName(env.VP_PACKAGE_MANAGER);
  if (forced) return forced;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const declared = [pkg.packageManager, ...[pkg.devEngines?.packageManager].flat().map((d) => d?.name)];
    for (const d of declared) if (pmName(d)) return pmName(d);
  } catch {}
  for (const [file, pm] of VP_PM_FILES) if (fs.existsSync(path.join(root, file))) return pm;
  return "pnpm";
}

// Files and folders under the home directory that hold logins, keys or wallets.
// They are unreadable in every mode. A path that does not exist costs nothing.
export const SECRET_PATHS = [
  ".ssh", ".gnupg", ".netrc", ".git-credentials", ".password-store", ".vault-token",
  ".npmrc", ".yarnrc.yml", ".bunfig.toml", ".pypirc", ".gem/credentials", ".cargo/credentials", ".cargo/credentials.toml",
  ".aws", ".azure", ".kube", ".docker/config.json", ".terraform.d", ".config/gcloud", ".config/gh", ".config/hub", ".config/op",
  ".claude.json", ".claude/.credentials.json", ".codex/auth.json",
  ".config/depcage", // depcage's own record of projects, allowed hosts and history
  ".bash_history", ".zsh_history", ".node_repl_history", ".python_history",
  ".config/solana", ".ethereum", ".bitcoin", ".electrum",
  // browsers, password managers and wallets keep their data here
  "Library/Keychains", "Library/Cookies", "Library/Application Support",
  ".config/google-chrome", ".config/chromium", ".config/BraveSoftware", ".mozilla", ".local/share/keyrings",
];

// Environment variables whose names look like credentials are not passed on.
const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|_AUTH$|^AUTH_|SESSION_?KEY)/i;
const SECRET_ENV_EXACT = new Set(["SSH_AUTH_SOCK", "GPG_AGENT_INFO", "AWS_SESSION_TOKEN", "PGPASSWORD"]);

// Where each package manager keeps downloads between runs (install mode may write there).
// Only download caches are listed. Folders that hold programs which are later run outside
// the sandbox (global installs, the package manager itself) are deliberately left out.
// `all` applies everywhere; `darwin` and `linux` only there. `optional` folders are
// writable when they exist but are not created for the user.
const CACHE_DIRS = {
  npm: { all: [".npm/_cacache", ".npm/_logs"], optional: [".npm/_update-notifier-last-checked"] },
  npx: { all: [".npm/_npx"] },
  pnpm: {
    all: [".local/state/pnpm"],
    darwin: ["Library/pnpm/store", "Library/Caches/pnpm"],
    linux: [".local/share/pnpm/store", ".cache/pnpm"],
  },
  yarn: { darwin: ["Library/Caches/Yarn"], linux: [".cache/yarn"], optional: [".yarn/berry"] },
  yarnBerry: { all: [".yarn/berry"] }, // downloads, metadata and index; Yarn's own programs live in ~/.yarn/bin and ~/.yarn/releases
  bun: { all: [".bun/install/cache"] },
  shared: { darwin: ["Library/Caches/node-gyp"], linux: [".cache/node-gyp"], optional: [".node-gyp"] },
};
const cacheDirs = (key, platform) => {
  const c = CACHE_DIRS[key] || {};
  const needed = [...(c.all || []), ...(c[platform] || [])];
  return { needed, all: [...needed, ...(c.optional || [])] };
};

// Yarn 2 and later keeps its downloads in a different place from Yarn 1.
function usesYarnBerry(root) {
  if (fs.existsSync(path.join(root, ".yarnrc.yml"))) return true;
  try { return /^yarn@(?!1\.)\d/.test(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).packageManager || ""); } catch { return false; }
}

const DEFAULT_INSTALL_HOSTS = ["registry.npmjs.org", "nodejs.org"];
const YARN_HOSTS = ["registry.yarnpkg.com", "repo.yarnpkg.com"];

// `npx vitest` with vitest already in node_modules downloads nothing: it is an ordinary run.
function runsLocalBin(argv, cwd, { files = false } = {}) {
  const args = argv.slice(1);
  let name;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { name = args[i + 1]; break; }
    if (/^(-p|--package|-c|--call)(=|$)/.test(a)) return false; // asks for a download, or a shell string
    if (a.startsWith("-")) continue;
    name = a; break;
  }
  if (!name) return false;
  // `vpx script.ts` runs a file that is already here
  if (files && /\.[cm]?[jt]sx?$/.test(name) && fs.existsSync(path.resolve(cwd, name))) return true;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return false; // a version or a scope means "fetch it"
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "node_modules", ".bin", name))) return true;
    if (dir === path.dirname(dir)) return false;
  }
}

export function detectMode(argv, cwd = process.cwd()) {
  const tool = path.basename(argv[0] || "");
  if (tool === "npx" || tool === "bunx") return runsLocalBin(argv, cwd) ? "run" : "install";
  if (tool === "vpx") return runsLocalBin(argv, cwd, { files: true }) ? "run" : "install";
  if (tool === "vpr") return "run"; // short for `vp run`
  if (FETCH_AND_RUN.has(tool)) return "install";
  const vp = tool === "vp";
  if (!PACKAGE_MANAGERS.has(tool) && !vp) return "run";
  const args = argv.slice(1), end = args.indexOf("--");
  const words = (end < 0 ? args : args.slice(0, end)).filter((a) => !a.startsWith("-"));
  if (words.length === 0) return tool === "yarn" ? "install" : "run"; // bare `yarn` installs
  const fetchVerbs = vp ? VP_FETCH_VERBS : FETCH_VERBS[tool];
  // The first word that is a known sub-command decides; option values are skipped over.
  for (const w of words) {
    if (fetchVerbs.includes(w) || INSTALL_VERBS.has(w)) return "install";
    if (RUN_VERBS.has(w) || (vp && VP_RUN_VERBS.has(w))) return "run";
  }
  return "run";
}

// Commands that manage your account, programs installed for the whole computer, or the tool
// itself. They need exactly what the sandbox hides, so the shell hook runs them without it
// (and says so). This list is only used for commands coming from the hook.
const DIRECT_VERBS = {
  all: ["login", "logout", "adduser", "add-user", "whoami", "publish", "unpublish", "deprecate", "token", "owner", "access",
    "team", "org", "profile", "stage", "dist-tag", "version", "config", "completion", "doctor", "self-update"],
  npm: ["c", "help"],
  pnpm: ["setup", "env", "server"],
  yarn: ["global", "policies", "npm", "set"],
  bun: ["upgrade"],
  vp: ["env", "upgrade", "implode", "hooks", "help"],
};
export const INFO_ONLY = "it only prints information";
const DEV_SERVER_WORDS = new Set(["dev", "start", "serve", "preview"]);

/** Why a typed command should run without the sandbox, or null when it should run inside it. */
export function directReason(argv, platform = process.platform) {
  const tool = path.basename(argv[0] || "");
  const args = argv.slice(1), end = args.indexOf("--");
  if (args.length && args.every((a) => ["-v", "-V", "--version", "-h", "--help"].includes(a))) return INFO_ONLY;
  if (!PACKAGE_MANAGERS.has(tool) && tool !== "vp") return null;
  const own = end < 0 ? args : args.slice(0, end);
  if (own.some((a) => a === "-g" || a === "--global" || a === "--location=global")) return "it installs or changes programs for the whole computer";
  const words = own.filter((a) => !a.startsWith("-"));
  const direct = new Set([...DIRECT_VERBS.all, ...DIRECT_VERBS[tool]]);
  const fetchVerbs = tool === "vp" ? VP_FETCH_VERBS : FETCH_VERBS[tool];
  for (const [i, w] of words.entries()) {
    if (direct.has(w)) return "it needs your account, or changes settings outside the project";
    const runs = RUN_VERBS.has(w) || (tool === "vp" && VP_RUN_VERBS.has(w));
    // Linux gives the sandbox a network of its own, so a dev server inside it cannot be opened.
    if (platform === "linux" && (DEV_SERVER_WORDS.has(w) || (runs && DEV_SERVER_WORDS.has(words[i + 1])))) {
      return "a dev server inside the Linux sandbox cannot be opened from your browser";
    }
    if (runs || fetchVerbs.includes(w) || INSTALL_VERBS.has(w)) return null;
  }
  return null;
}

export function packageManagerOf(argv, root, env = {}) {
  const tool = path.basename(argv[0] || "");
  if (tool === "npx") return "npm";
  if (tool === "pnpx") return "pnpm";
  if (tool === "bunx") return "bun";
  if (VP_TOOLS.has(tool)) return root ? vitePlusPackageManager(root, env) : null;
  return PACKAGE_MANAGERS.has(tool) ? tool : null;
}

const isInside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

// The folder the command may write to: the enclosing git repository, else the topmost
// folder that looks like a workspace root (package.json plus a lockfile), else the
// nearest folder with a package.json, else the current folder. The search never climbs
// to a home folder or above it: a stray package.json or a dotfiles repository there
// must not turn the whole home folder into "the project".
const ROOT_MARKERS = ["pnpm-workspace.yaml", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
export function findProjectRoot(cwd, homes = []) {
  let nearest = null, workspace = null;
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (homes.some((h) => isInside(h, dir))) break;
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (fs.existsSync(path.join(dir, "package.json"))) {
      nearest ??= dir;
      if (ROOT_MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) workspace = dir;
    }
    if (dir === path.dirname(dir)) break;
  }
  return workspace || nearest || cwd;
}

// Programs that talk to a daemon outside the sandbox. Letting a sandboxed command
// reach that daemon would be a way out (watchman can run commands for its clients),
// and a half-working watchman makes Jest 30 exit 0 without running any test.
// So they are made impossible to start, and tools fall back as if they were not installed.
const DAEMON_CLIENTS = ["watchman"];

export function findOnPath(names, pathVar) {
  const found = new Set();
  for (const dir of (pathVar || "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const file = path.join(dir, name);
      try { fs.accessSync(file, fs.constants.X_OK); found.add(file); found.add(fs.realpathSync.native(file)); } catch {}
    }
  }
  return [...found];
}

function registryHostsFrom(text) {
  const hosts = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:@[^:=\s]+:)?registry\s*=\s*["']?(https?:\/\/[^\s"']+)/.exec(line);
    if (m) try { hosts.push(new URL(m[1]).hostname); } catch {}
  }
  return hosts;
}

function splitEnv(env, keep) {
  const passed = {}, withheld = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const secret = SECRET_ENV_EXACT.has(name) || SECRET_ENV.test(name);
    if (secret && !keep.has(name)) withheld.push(name); else passed[name] = value;
  }
  return { passed, withheld: withheld.sort() };
}

const expandHome = (p, home) => (p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p);

const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

/** The folder a command may write to. Throws when that would be the home folder or the whole disk. */
export function resolveRoot({ cwd, home, otherHomes = [] }) {
  const homes = [...new Set([real(home), ...otherHomes.map(real)])];
  const root = findProjectRoot(real(cwd), homes);
  if (root === path.parse(root).root || homes.some((h) => isInside(h, root))) {
    throw new Error(`refusing to treat ${root} as the project folder. Run depcage from inside a project.`);
  }
  return root;
}

/**
 * @param {object} o
 * @param {string[]} o.argv       the command to run
 * @param {string} o.cwd
 * @param {string} o.home         the user's home directory ($HOME)
 * @param {string[]} o.otherHomes other spellings of it (the account's own entry), hidden the same way
 * @param {object} o.env
 * @param {string} o.platform     process.platform
 * @param {object} o.options      parsed command-line options
 * @param {string[]} o.ownDirs    folders holding this tool's own code
 * @param {number} [o.uid]        numeric user id, used for per-user lock paths
 */
export function buildPolicy({ argv, cwd, home, otherHomes = [], env, platform, options = {}, ownDirs = [], uid, nodeMajor = Number(process.versions.node.split(".")[0]) }) {
  cwd = real(cwd); home = real(home);
  const homes = [...new Set([home, ...otherHomes.map(real)])];
  const mode = options.mode || detectMode(argv, cwd);
  const root = resolveRoot({ cwd, home, otherHomes });
  const abs = (p) => path.resolve(cwd, expandHome(p, home));
  const allowRead = (options.allowRead || []).map(abs);

  let denyRead = homes.flatMap((h) => SECRET_PATHS.map((p) => path.join(h, p)))
    .filter((p) => !allowRead.some((a) => a === p))
    // a project that lives inside a hidden folder would be unusable
    .filter((p) => !isInside(root, p));
  if (mode === "install") denyRead.push(path.join(root, ".env"), path.join(root, ".env.*"));
  // bubblewrap cannot hide a path that is not there, and has nothing to hide then
  if (platform === "linux") denyRead = denyRead.filter((p) => p.includes("*") || fs.existsSync(p));

  const allowWrite = [root, ...(options.allowWrite || []).map(abs)];
  // Cache folders that must exist before the command starts: inside the sandbox their
  // parent folder is read-only, so the package manager could not create them itself.
  const ensureDirs = [];
  const pm = packageManagerOf(argv, root, env);
  if (mode === "install") {
    const tool = path.basename(argv[0]);
    const fetchAndRun = tool === "npx" || tool === "vpx" || (tool === "vp" && argv.includes("dlx"))
      || (tool === "npm" && argv.some((a) => a === "exec" || a === "x"));
    const berry = pm === "yarn" && usesYarnBerry(root);
    for (const key of [pm || "npm", ...(berry ? ["yarnBerry"] : []), ...(fetchAndRun ? ["npx"] : []), "shared"]) {
      const { needed, all } = cacheDirs(key, platform);
      for (const d of all) allowWrite.push(path.join(home, d));
      for (const d of needed) ensureDirs.push(path.join(home, d));
    }
    // a cache moved with npm's own setting is followed
    if (env.npm_config_cache) { allowWrite.push(abs(env.npm_config_cache)); ensureDirs.push(abs(env.npm_config_cache)); }
    // pnpm 12 keeps its store lock in /tmp, whatever TMPDIR says
    if (pm === "pnpm" && uid !== undefined) allowWrite.push(`/tmp/pnpm-store-operation-locks-${uid}`, `/private/tmp/pnpm-store-operation-locks-${uid}`);
  }
  // A sandboxed command must not be able to rewrite the sandbox itself.
  const denyWrite = ownDirs.map(real).filter((d) => allowWrite.some((w) => isInside(d, w)));

  let allowedDomains = [];
  if (mode === "install") {
    allowedDomains.push(...DEFAULT_INSTALL_HOSTS);
    if (pm === "yarn") allowedDomains.push(...YARN_HOSTS);
    for (const file of new Set([path.join(root, ".npmrc"), path.join(cwd, ".npmrc")])) {
      try { allowedDomains.push(...registryHostsFrom(fs.readFileSync(file, "utf8"))); } catch {}
    }
    for (const [k, v] of Object.entries(env)) {
      if (/^npm_config_(.*:)?registry$/i.test(k) && v) try { allowedDomains.push(new URL(v).hostname); } catch {}
    }
  }
  allowedDomains.push(...(options.allowNet || []));
  allowedDomains = [...new Set(allowedDomains)];

  const allowLocal = options.local ?? mode === "run";
  const { passed, withheld } = splitEnv(env, new Set(options.keepEnv || []));
  // Node's own fetch/http only use the sandbox proxy when told to. Without this an
  // allowed host would be unreachable from Node code, and a blocked one would not be reported.
  // Node 22 understands the setting but prints a warning in every process, so it is left off there.
  if (nodeMajor >= 24) passed.NODE_USE_ENV_PROXY = "1";

  const config = {
    network: { allowedDomains, deniedDomains: [], allowLocalBinding: allowLocal },
    filesystem: { denyRead, allowRead: [], allowWrite, denyWrite },
  };
  const denyExec = findOnPath(DAEMON_CLIENTS, env.PATH);
  // macOS gets an exec-deny rule (see run.mjs). Linux has no such rule; hiding the file
  // makes it unusable there instead. (The Linux path has not been tested yet.)
  if (platform === "linux") config.filesystem.denyRead.push(...denyExec);
  // pnpm 12 is a native program that checks certificates through the macOS trust service,
  // which the sandbox closes by default. Opened for pnpm installs only; see README, "Limits".
  const systemTrust = platform === "darwin" && mode === "install" && pm === "pnpm";
  if (systemTrust) config.enableWeakerNetworkIsolation = true;
  return { mode, root, config, env: passed, withheldEnv: withheld, allowLocal, denyExec, systemTrust, ensureDirs, browser: Boolean(options.browser) };
}
