// The shell hook, remembered permissions and the report.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { directReason } from "../src/policy.mjs";
import { hookText, setup, stripHook } from "../src/hook.mjs";
import { changeSetting, commandLabel, projectSettings, readHistory, recordRun } from "../src/store.mjs";
import { formatReport } from "../src/report.mjs";

const BIN = fileURLToPath(new URL("../bin/depcage.mjs", import.meta.url));
const supported = process.platform === "darwin" || process.platform === "linux";
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "depcage-hook-")));
function fixture() {
  const dir = tmp(), home = path.join(dir, "home"), project = path.join(dir, "project");
  fs.mkdirSync(home); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "package.json"), "{}");
  return { dir, home, project };
}
const run = (fx, args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd: fx.project, encoding: "utf8", env: { PATH: process.env.PATH, HOME: fx.home, ...env } });

test("typed commands that need the account or the whole computer are not sandboxed; the rest are", () => {
  for (const cmd of ["npm publish", "npm login", "npm whoami", "npm install -g typescript", "pnpm add --global x", "npm version patch",
    "yarn global add x", "yarn npm publish", "yarn set version 4.1.0", "bun upgrade", "vp env use 24", "vp upgrade", "vp pm publish",
    "npm config set x y", "pnpm self-update", "npm --version", "npx --help"]) {
    assert.ok(directReason(cmd.split(" "), "darwin"), cmd);
  }
  for (const cmd of ["npm install", "npm i left-pad", "npm test", "npm run publish", "npm run build", "pnpm add x", "yarn", "bun install",
    "npx cowsay", "vp install", "vp test", "vp dev", "npm run dev", "npm start", "npm install config", "npm test -- -g pattern", "node x.js"]) {
    assert.equal(directReason(cmd.split(" "), "darwin"), null, cmd);
  }
  // Linux: a dev server inside the sandbox cannot be opened from the browser
  for (const cmd of ["npm run dev", "npm start", "pnpm dev", "yarn dev", "vp dev", "vp preview"]) assert.ok(directReason(cmd.split(" "), "linux"), cmd);
  for (const cmd of ["npm test", "npm run build", "npm install serve", "vp build"]) assert.equal(directReason(cmd.split(" "), "linux"), null, cmd);
});

test("setup adds one block, keeps the rest of the file, and removes it again", () => {
  const fx = fixture();
  const rc = path.join(fx.home, ".zshrc");
  fs.writeFileSync(rc, "export MINE=1\n");
  assert.deepEqual(setup({ shell: "zsh", home: fx.home }), { file: rc, changed: true });
  assert.equal(setup({ shell: "zsh", home: fx.home }).changed, false);
  const text = fs.readFileSync(rc, "utf8");
  assert.ok(text.startsWith("export MINE=1\n"));
  assert.equal(text.split(">>> depcage >>>").length, 2);
  assert.equal(stripHook(text), "export MINE=1\n");
  assert.equal(setup({ shell: "zsh", home: fx.home, remove: true }).changed, true);
  assert.equal(fs.readFileSync(rc, "utf8"), "export MINE=1\n");
  assert.equal(setup({ shell: "bash", home: fx.home }).file, path.join(fx.home, ".bashrc"));
  assert.throws(() => setup({ shell: "fish", home: fx.home }), /not supported/);
});

for (const shell of ["zsh", "bash"]) {
  const present = spawnSync(shell, ["-c", "exit 0"]).status === 0;
  test(`${shell}: the block wraps the package managers, keeps an existing vp function and can be skipped`, { skip: !present }, () => {
    const fx = fixture();
    const fake = path.join(fx.dir, "bin");
    fs.mkdirSync(fake);
    for (const name of ["depcage", "npm", "vp"]) fs.writeFileSync(path.join(fake, name), `#!/bin/sh\necho "${name}-program $*"\n`, { mode: 0o755 });
    const script = `vp() { echo "old-vp-function $*"; }\n${hookText()}\nnpm test\nDEPCAGE=off npm test\nvp env use 24\nvp build\n${hookText()}\nvp env list\n`;
    const out = spawnSync(shell, ["-c", script], { encoding: "utf8", env: { PATH: `${fake}:/usr/bin:/bin`, HOME: fx.home } });
    assert.deepEqual(out.stdout.trim().split("\n"), [
      "depcage-program --auto npm test", "npm-program test", "old-vp-function env use 24", "depcage-program --auto vp build", "old-vp-function env list",
    ], out.stderr);
  });
}

test("remembered permissions are stored per project and only names reach the history", () => {
  const fx = fixture();
  assert.deepEqual(projectSettings(fx.home, fx.project).allowNet, []);
  changeSetting(fx.home, fx.project, "net", "api.example.com");
  changeSetting(fx.home, fx.project, "browser");
  assert.deepEqual(projectSettings(fx.home, fx.project), { allowNet: ["api.example.com"], allowRead: [], allowWrite: [], keepEnv: [], browser: true });
  assert.deepEqual(projectSettings(fx.home, "/another/project").allowNet, []);
  changeSetting(fx.home, fx.project, "net", "api.example.com", true);
  changeSetting(fx.home, fx.project, "browser", undefined, true);
  assert.equal(fs.readFileSync(path.join(fx.home, ".config/depcage/projects.json"), "utf8").includes(fx.project), false);

  assert.equal(commandLabel(["npm", "install", "left-pad"]), "npm install");
  assert.equal(commandLabel(["/usr/local/bin/npm", "--otp", "secretvalue", "publish"]), "npm");
  assert.equal(commandLabel(["node", "--token=abc123"]), "node");
  assert.equal(commandLabel(["curl", "https://user:pw@example.com/x?key=1"]), "curl");
  recordRun(fx.home, { t: new Date().toISOString(), root: fx.project, cmd: "npm test", mode: "run", code: 0, ms: 5, blocked: ["example.com:443"], withheld: ["API_KEY"] });
  assert.equal(readHistory(fx.home).length, 1);
});

test("the report counts blocked destinations and held-back variables for one project or all", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");
  const e = (root, cmd, mode, blocked = [], daysAgo = 1) => ({ t: new Date(now - daysAgo * 86_400_000).toISOString(), root, cmd, mode, code: 0, ms: 1, blocked, withheld: mode === "direct" ? [] : ["API_KEY"] });
  const history = [e("/w/app", "npm install", "install"), e("/w/app", "npm test", "run", ["example.com:443"]), e("/w/app", "npm test", "run", ["example.com:443"]),
    e("/w/app", "npm publish", "direct"), e("/w/other", "pnpm build", "run", ["tracker.example.net:443"]), e("/w/app", "npm test", "run", ["old.example.org:443"], 90)];
  const one = formatReport(history, { root: "/w/app", days: 30, now });
  assert.match(one, /depcage report: app, last 30 days/);
  assert.match(one, /inside the sandbox\s+3\s+\(1 installs, 2 others\)/);
  assert.match(one, /without it\s+1\s+\(npm publish ×1\)/);
  assert.match(one, /example\.com:443\s+2 times\s+from: npm test/);
  assert.match(one, /API_KEY\s+in 3 of 3 commands/);
  assert.ok(!one.includes("tracker.example.net") && !one.includes("old.example.org"));
  assert.match(formatReport(history, { root: null, days: 30, now }), /tracker\.example\.net:443/);
  assert.match(formatReport([], { root: "/w/app", days: 30, now }), /No commands recorded yet/);
});

test("end to end: allow is remembered, the hook mode skips account commands, the store cannot be changed from inside", { skip: !supported }, () => {
  const fx = fixture();
  assert.match(run(fx, ["allow", "net", "api.example.com"]).stdout, /net\s+api\.example\.com/);
  assert.ok(JSON.parse(run(fx, ["--print-policy", "npm", "test"]).stdout).network.allowedDomains.includes("api.example.com"));
  assert.equal(run(fx, ["allow", "net", "not a host"]).status, 2);

  const info = run(fx, ["--auto", "npm", "--version"]);
  assert.match(info.stdout, /^\d+\.\d+\.\d+/);
  assert.equal(info.stderr, "");

  // a sandboxed command tries to give itself more permissions, even with the folder above made writable
  const store = path.join(fx.home, ".config", "depcage", "projects.json");
  const attack = `try{require('fs').writeFileSync(${JSON.stringify(store)},'{"projects":{}}');console.log('WROTE')}catch(e){console.log('DENIED')}`;
  assert.match(run(fx, ["--allow-write", path.join(fx.home, ".config"), "node", "-e", attack]).stdout, /DENIED/);
  assert.match(fs.readFileSync(store, "utf8"), /api\.example\.com/);

  const report = run(fx, ["report"]).stdout;
  assert.match(report, /inside the sandbox\s+1/);
  // from the home folder, the hook refuses instead of running unsandboxed
  const atHome = spawnSync(process.execPath, [BIN, "--auto", "npx", "cowsay"], { cwd: fx.home, encoding: "utf8", env: { PATH: process.env.PATH, HOME: fx.home } });
  assert.equal(atHome.status, 2);
  assert.match(atHome.stderr, /DEPCAGE=off npx cowsay/);
});
