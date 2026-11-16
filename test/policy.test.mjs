import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectMode, findProjectRoot, buildPolicy, findOnPath } from "../src/policy.mjs";
import { denyExecMacOS } from "../src/run.mjs";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "depcage-test-")));
function fixture() {
  const dir = tmp(), home = path.join(dir, "home"), project = path.join(dir, "work", "app");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), "{}");
  return { dir, home, project };
}
const policyFor = (argv, fx, extra = {}) =>
  buildPolicy({ argv, cwd: fx.project, home: fx.home, env: { PATH: "/usr/bin" }, platform: "darwin", ...extra });

test("install commands are recognised", () => {
  for (const cmd of ["npm install", "npm i", "npm ci", "npm add x", "npm --loglevel silent install", "pnpm add x", "pnpm install",
    "yarn", "yarn add x", "bun install", "bun add x", "npx cowsay", "pnpm dlx x", "bunx x", "npm rebuild", "npm update"]) {
    assert.equal(detectMode(cmd.split(" ")), "install", cmd);
  }
});

test("everything else runs in run mode", () => {
  for (const cmd of ["npm test", "npm run build", "pnpm test", "yarn build", "bun test", "node build.js", "vitest", "npm", "tsc -p .",
    "npm run install-all", "pnpm exec vitest", "yarn exec jest", "npm test -- install"]) {
    assert.equal(detectMode(cmd.split(" ")), "run", cmd);
  }
});

test("project root is the git repository, else the nearest package.json", () => {
  const fx = fixture();
  assert.equal(findProjectRoot(path.join(fx.project, "src")), fx.project);
  fs.mkdirSync(path.join(fx.dir, "work", ".git"));
  assert.equal(findProjectRoot(path.join(fx.project, "src")), path.join(fx.dir, "work"));
});

test("install mode: registry only, no localhost, secrets and .env hidden, caches writable", () => {
  const fx = fixture();
  const p = policyFor(["npm", "install"], fx);
  assert.equal(p.mode, "install");
  assert.deepEqual(p.config.network.allowedDomains, ["registry.npmjs.org", "nodejs.org"]);
  assert.equal(p.config.network.allowLocalBinding, false);
  for (const f of [".ssh", ".npmrc", ".aws", ".config/gh"]) assert.ok(p.config.filesystem.denyRead.includes(path.join(fx.home, f)), f);
  assert.ok(p.config.filesystem.denyRead.includes(path.join(fx.project, ".env")));
  assert.deepEqual(p.config.filesystem.allowWrite.slice(0, 2), [fx.project, path.join(fx.home, ".npm", "_cacache")]);
  // folders whose programs run later, outside the sandbox, stay read-only
  for (const argv of [["npm", "install"], ["pnpm", "install"], ["bun", "install"], ["yarn"]]) {
    const w = policyFor(argv, fx).config.filesystem.allowWrite;
    for (const d of [".npm", ".npm/_npx", "Library/pnpm", ".bun", ".bun/install", ".yarn", ".yarn/bin"]) assert.ok(!w.includes(path.join(fx.home, d)), argv[0] + " " + d);
  }
  assert.ok(policyFor(["npx", "cowsay"], fx).config.filesystem.allowWrite.includes(path.join(fx.home, ".npm", "_npx")));
});

test("run mode: no internet, localhost allowed, only the project writable, .env readable", () => {
  const fx = fixture();
  const p = policyFor(["npm", "test"], fx);
  assert.equal(p.mode, "run");
  assert.deepEqual(p.config.network.allowedDomains, []);
  assert.equal(p.config.network.allowLocalBinding, true);
  assert.deepEqual(p.config.filesystem.allowWrite, [fx.project]);
  assert.ok(!p.config.filesystem.denyRead.includes(path.join(fx.project, ".env")));
  assert.equal(policyFor(["npm", "test"], fx, { options: { local: false } }).config.network.allowLocalBinding, false);
});

test("the account's real home is hidden too when $HOME points elsewhere", () => {
  const fx = fixture(), other = path.join(fx.dir, "realhome");
  fs.mkdirSync(other);
  const p = policyFor(["npm", "test"], fx, { otherHomes: [other] });
  assert.ok(p.config.filesystem.denyRead.includes(path.join(other, ".ssh")));
  assert.ok(p.config.filesystem.denyRead.includes(path.join(fx.home, ".ssh")));
});

test("secret-looking environment variables are withheld unless kept", () => {
  const fx = fixture();
  const env = { PATH: "/usr/bin", NPM_TOKEN: "a", GITHUB_TOKEN: "b", AWS_SECRET_ACCESS_KEY: "c", MY_API_KEY: "d", SSH_AUTH_SOCK: "/x", NODE_ENV: "test", DATABASE_URL: "postgres://localhost/x" };
  const p = policyFor(["npm", "test"], fx, { env, options: { keepEnv: ["NPM_TOKEN"] } });
  assert.deepEqual(p.withheldEnv, ["AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "MY_API_KEY", "SSH_AUTH_SOCK"]);
  assert.equal(p.env.NPM_TOKEN, "a");
  assert.equal(p.env.NODE_ENV, "test");
  assert.equal(p.env.DATABASE_URL, "postgres://localhost/x");
  assert.equal(p.env.GITHUB_TOKEN, undefined);
});

test("extra hosts, registries from the project .npmrc, and --allow-read", () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.project, ".npmrc"), "@acme:registry=https://npm.acme.example/\n//npm.acme.example/:_authToken=${ACME_TOKEN}\n");
  const p = policyFor(["npm", "ci"], fx, { options: { allowNet: ["github.com"], allowRead: ["~/.npmrc"] } });
  assert.deepEqual(p.config.network.allowedDomains, ["registry.npmjs.org", "nodejs.org", "npm.acme.example", "github.com"]);
  assert.ok(!p.config.filesystem.denyRead.includes(path.join(fx.home, ".npmrc")));
  assert.ok(p.config.filesystem.denyRead.includes(path.join(fx.home, ".ssh")));
});

test("refuses a home folder or the disk root as the project", () => {
  const fx = fixture();
  assert.throws(() => buildPolicy({ argv: ["npm", "test"], cwd: fx.home, home: fx.home, env: {}, platform: "darwin" }), /project/);
  assert.throws(() => buildPolicy({ argv: ["npm", "test"], cwd: fx.dir, home: fx.home, env: {}, platform: "darwin" }), /project/);
});

test("the tool's own files are write-protected when they live inside the project", () => {
  const fx = fixture(), own = path.join(fx.project, "node_modules", "depcage");
  fs.mkdirSync(own, { recursive: true });
  assert.deepEqual(policyFor(["npm", "test"], fx, { ownDirs: [own, "/somewhere/else"] }).config.filesystem.denyWrite, [own]);
});

test("daemon clients on PATH are found, with their real paths", () => {
  const fx = fixture(), bin = path.join(fx.dir, "bin"), realBin = path.join(fx.dir, "cellar");
  fs.mkdirSync(bin); fs.mkdirSync(realBin);
  fs.writeFileSync(path.join(realBin, "watchman"), "#!/bin/sh\n", { mode: 0o755 });
  fs.symlinkSync(path.join(realBin, "watchman"), path.join(bin, "watchman"));
  assert.deepEqual(findOnPath(["watchman"], `/nonexistent:${bin}`).sort(), [path.join(bin, "watchman"), path.join(realBin, "watchman")].sort());
  assert.deepEqual(findOnPath(["watchman"], "/usr/bin-nope"), []);
});

test("exec-deny rule is added once, and refused when the profile is not as expected", () => {
  const wrapped = "sandbox-exec -p '(version 1)\n(allow process-exec)\n(allow process-fork)' sh -c true";
  const out = denyExecMacOS(wrapped, ["/opt/homebrew/bin/watchman"]);
  assert.ok(out.includes('(allow process-exec)\n(deny process-exec (literal "/opt/homebrew/bin/watchman"))\n(allow process-fork)'));
  assert.equal(denyExecMacOS(wrapped, []), wrapped);
  assert.throws(() => denyExecMacOS("sandbox-exec -p '(version 1)'", ["/x/watchman"]), /unexpected shape/);
  assert.throws(() => denyExecMacOS(wrapped, ['/x/wat"chman']), /unusual path/);
});

test("pnpm installs get the store lock path and the system trust service; nothing else does", () => {
  const fx = fixture();
  const p = policyFor(["pnpm", "install"], fx, { uid: 501 });
  assert.ok(p.config.filesystem.allowWrite.includes("/tmp/pnpm-store-operation-locks-501"));
  assert.equal(p.config.enableWeakerNetworkIsolation, true);
  assert.equal(policyFor(["npm", "install"], fx, { uid: 501 }).config.enableWeakerNetworkIsolation, undefined);
  assert.equal(policyFor(["pnpm", "test"], fx, { uid: 501 }).config.enableWeakerNetworkIsolation, undefined);
});

test("a stray package.json, lockfile or git repository in the home folder does not widen the project", () => {
  const fx = fixture(), project = path.join(fx.home, "code", "app");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), "{}");
  fs.writeFileSync(path.join(fx.home, "package.json"), "{}");
  fs.writeFileSync(path.join(fx.home, "package-lock.json"), "{}");
  fs.mkdirSync(path.join(fx.home, ".git"));
  const p = buildPolicy({ argv: ["npm", "test"], cwd: project, home: fx.home, env: {}, platform: "darwin" });
  assert.equal(p.root, project);
});

test("a workspace root with a lockfile is the project when run from a package inside it", () => {
  const fx = fixture(), pkg = path.join(fx.project, "packages", "a");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), "{}");
  assert.equal(findProjectRoot(pkg), pkg);
  fs.writeFileSync(path.join(fx.project, "pnpm-lock.yaml"), "");
  assert.equal(findProjectRoot(pkg), fx.project);
});

test("npx of a program already installed in the project is an ordinary run; anything else is an install", () => {
  const fx = fixture(), bin = path.join(fx.project, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "vitest"), "");
  const sub = path.join(fx.project, "src");
  assert.equal(detectMode(["npx", "vitest", "run"], sub), "run");
  assert.equal(detectMode(["bunx", "vitest"], sub), "run");
  assert.equal(detectMode(["npx", "--no-install", "vitest"], sub), "run");
  for (const cmd of ["npx cowsay hi", "npx vitest@3 run", "npx -p vitest vitest", "npx --package=vitest vitest", "npx @scope/tool", "pnpx vitest", "npx -c vitest"]) {
    assert.equal(detectMode(cmd.split(" "), sub), "install", cmd);
  }
});

test("cache folders for the platform are listed for creation; optional and foreign ones are not", () => {
  const fx = fixture();
  const mac = policyFor(["pnpm", "install"], fx);
  assert.ok(mac.ensureDirs.includes(path.join(fx.home, "Library/pnpm/store")));
  assert.ok(!mac.ensureDirs.some((d) => d.includes(".local/share")));
  const linux = policyFor(["yarn"], fx, { platform: "linux" });
  assert.ok(linux.ensureDirs.includes(path.join(fx.home, ".cache/yarn")));
  assert.ok(!linux.ensureDirs.some((d) => d.includes("Library") || d.includes("berry")));
  assert.deepEqual(policyFor(["npm", "test"], fx).ensureDirs, []);
  assert.ok(policyFor(["npm", "ci"], fx, { env: { npm_config_cache: "/data/npm-cache" } }).config.filesystem.allowWrite.includes("/data/npm-cache"));
});

test("Node's proxy setting is only switched on where it is silent", () => {
  const fx = fixture();
  assert.equal(policyFor(["npm", "test"], fx, { nodeMajor: 24 }).env.NODE_USE_ENV_PROXY, "1");
  assert.equal(policyFor(["npm", "test"], fx, { nodeMajor: 22 }).env.NODE_USE_ENV_PROXY, undefined);
});

test("Vite+ commands: installs and runs are told apart", () => {
  for (const cmd of ["vp install", "vp i", "vp add x", "vp remove x", "vp update", "vp dedupe", "vp outdated", "vp rebuild", "vp dlx cowsay",
    "vp create", "vp migrate", "vp info react", "vp pm approve-builds", "vp -C packages/app install", "vpx cowsay"]) {
    assert.equal(detectMode(cmd.split(" ")), "install", cmd);
  }
  for (const cmd of ["vp dev", "vp build", "vp test", "vp lint", "vp fmt --check", "vp check", "vp preview", "vp pack", "vp run build",
    "vp run install-all", "vp exec vitest", "vp node script.js", "vp staged", "vp cache clean", "vp list", "vp why x", "vp", "vpr build",
    "vp env use 24", "vp test -- install"]) {
    assert.equal(detectMode(cmd.split(" ")), "run", cmd);
  }
  const fx = fixture();
  fs.mkdirSync(path.join(fx.project, "node_modules", ".bin"), { recursive: true });
  fs.writeFileSync(path.join(fx.project, "node_modules", ".bin", "vitest"), "");
  fs.writeFileSync(path.join(fx.project, "script.ts"), "");
  assert.equal(detectMode(["vpx", "vitest"], fx.project), "run");
  assert.equal(detectMode(["vpx", "script.ts"], fx.project), "run");
  assert.equal(detectMode(["vpx", "missing.ts"], fx.project), "install");
});

test("Vite+ installs get the caches of the package manager the project uses", () => {
  const cases = [
    [{ packageManager: "npm@11.20.0" }, [], ".npm/_cacache", false],
    [{ devEngines: { packageManager: { name: "bun", version: "^1.4.0" } } }, [], ".bun/install/cache", false],
    [{}, ["yarn.lock"], "Library/Caches/Yarn", false],
    [{}, ["package-lock.json"], ".npm/_cacache", false],
    [{ packageManager: "npm@11.20.0" }, ["pnpm-lock.yaml"], ".npm/_cacache", false], // the declaration wins
    [{}, [], "Library/pnpm/store", true], // nothing declared: Vite+ uses pnpm
  ];
  for (const [pkg, files, cache, trust] of cases) {
    const fx = fixture();
    fs.writeFileSync(path.join(fx.project, "package.json"), JSON.stringify(pkg));
    for (const f of files) fs.writeFileSync(path.join(fx.project, f), "");
    const p = policyFor(["vp", "install"], fx);
    const label = JSON.stringify(pkg) + " " + files;
    assert.equal(p.mode, "install", label);
    assert.ok(p.config.filesystem.allowWrite.includes(path.join(fx.home, cache)), label);
    assert.equal(p.systemTrust, trust, label);
    // Vite+ keeps Node.js and the package managers here; they run outside the sandbox later
    assert.ok(!p.config.filesystem.allowWrite.some((w) => w.includes("vite-plus")), label);
  }
  const fx = fixture();
  const forced = policyFor(["vp", "install"], fx, { env: { PATH: "/usr/bin", VP_PACKAGE_MANAGER: "bun@1.4.0" } });
  assert.ok(forced.config.filesystem.allowWrite.includes(path.join(fx.home, ".bun/install/cache")));
  fs.writeFileSync(path.join(fx.project, "package.json"), JSON.stringify({ packageManager: "npm@11.20.0" }));
  assert.ok(policyFor(["vp", "dlx", "cowsay"], fx).config.filesystem.allowWrite.includes(path.join(fx.home, ".npm", "_npx")));
  assert.equal(policyFor(["vp", "test"], fx).mode, "run");
});

test("Yarn 2+ projects get Yarn's own download folder; --browser adds only the Chromium channel", async () => {
  const fx = fixture();
  assert.ok(!policyFor(["yarn", "install"], fx).ensureDirs.includes(path.join(fx.home, ".yarn/berry")));
  fs.writeFileSync(path.join(fx.project, ".yarnrc.yml"), "nodeLinker: node-modules\n");
  const p = policyFor(["yarn", "install"], fx);
  assert.ok(p.ensureDirs.includes(path.join(fx.home, ".yarn/berry")));
  assert.ok(!p.config.filesystem.allowWrite.includes(path.join(fx.home, ".yarn")));
  assert.equal(detectMode(["yarn", "set", "version", "4.18.1"]), "install");
  assert.equal(p.browser, false);
  assert.equal(policyFor(["npm", "test"], fx, { options: { browser: true } }).browser, true);
  const { allowBrowserMacOS } = await import("../src/run.mjs");
  const out = allowBrowserMacOS("a\n(allow process-exec)\nb");
  assert.match(out, /\(allow process-exec\)\n\(allow mach-register \(global-name-regex #"\^org\\\.chromium\\\.Chromium\\\.MachPortRendezvousServer/);
  assert.throws(() => allowBrowserMacOS("no exec rule here"));
});
