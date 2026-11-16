// End-to-end: runs real commands through bin/depcage.mjs against a fake home folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/depcage.mjs", import.meta.url));
const supported = process.platform === "darwin" || process.platform === "linux";

function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "depcage-e2e-")));
  const home = path.join(dir, "home"), project = path.join(dir, "project");
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "FAKE KEY\n");
  fs.writeFileSync(path.join(home, ".npmrc"), "//registry.npmjs.org/:_authToken=FAKE\n");
  fs.writeFileSync(path.join(home, "notes.txt"), "not a secret\n");
  fs.writeFileSync(path.join(project, "package.json"), "{}");
  fs.writeFileSync(path.join(project, ".env"), "KEY=FAKE\n");
  return { dir, home, project };
}

function depcage(fx, args, env = {}) {
  return new Promise((resolve) => {
    let out = "", err = "";
    const child = spawn(process.execPath, [BIN, ...args], { cwd: fx.project, env: { PATH: process.env.PATH, HOME: fx.home, ...env } });
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}
const js = (code) => ["node", "-e", code];
const tryRead = (f) => `try{require('fs').readFileSync(${JSON.stringify(f)});console.log('READ')}catch(e){console.log('DENIED',e.code)}`;
const tryWrite = (f) => `try{require('fs').writeFileSync(${JSON.stringify(f)},'x');console.log('WROTE')}catch(e){console.log('DENIED',e.code)}`;

test("secrets in the home folder cannot be read; ordinary files can", { skip: !supported }, async () => {
  const fx = fixture();
  assert.match((await depcage(fx, js(tryRead(path.join(fx.home, ".ssh", "id_ed25519"))))).out, /DENIED/);
  assert.match((await depcage(fx, js(tryRead(path.join(fx.home, ".npmrc"))))).out, /DENIED/);
  assert.match((await depcage(fx, js(tryRead(path.join(fx.home, "notes.txt"))))).out, /READ/);
  assert.match((await depcage(fx, ["--allow-read", "~/.npmrc", ...js(tryRead(path.join(fx.home, ".npmrc")))])).out, /READ/);
});

test(".env is hidden from installs and readable by other commands", { skip: !supported }, async () => {
  const fx = fixture();
  assert.match((await depcage(fx, ["--mode", "install", ...js(tryRead(".env"))])).out, /DENIED/);
  assert.match((await depcage(fx, js(tryRead(".env")))).out, /READ/);
});

test("writes stay inside the project", { skip: !supported }, async () => {
  const fx = fixture();
  assert.match((await depcage(fx, js(tryWrite(path.join(fx.home, ".zshrc"))))).out, /DENIED/);
  assert.match((await depcage(fx, js(tryWrite(path.join(fx.dir, "outside.txt"))))).out, /DENIED/);
  assert.match((await depcage(fx, js(tryWrite("inside.txt")))).out, /WROTE/);
  assert.ok(fs.existsSync(path.join(fx.project, "inside.txt")));
  assert.ok(!fs.existsSync(path.join(fx.dir, "outside.txt")));
  assert.match((await depcage(fx, ["--allow-write", fx.dir, ...js(tryWrite(path.join(fx.dir, "outside.txt")))])).out, /WROTE/);
});

test("git hooks inside the project cannot be planted", { skip: !supported }, async () => {
  const fx = fixture();
  fs.mkdirSync(path.join(fx.project, ".git", "hooks"), { recursive: true });
  assert.match((await depcage(fx, js(tryWrite(".git/hooks/pre-commit")))).out, /DENIED/);
});

test("secret-looking environment variables do not reach the command", { skip: !supported }, async () => {
  const fx = fixture();
  const code = "console.log(JSON.stringify([process.env.GITHUB_TOKEN||null, process.env.PLAIN||null]))";
  const r = await depcage(fx, js(code), { GITHUB_TOKEN: "FAKE", PLAIN: "ok" });
  assert.equal(r.out.trim(), '[null,"ok"]');
  assert.match(r.err, /not passed on: GITHUB_TOKEN/);
  assert.equal((await depcage(fx, ["--keep-env", "GITHUB_TOKEN", ...js(code)], { GITHUB_TOKEN: "FAKE", PLAIN: "ok" })).out.trim(), '["FAKE","ok"]');
});

test("a server started inside the sandbox is reachable from inside it", { skip: !supported }, async () => {
  const fx = fixture();
  const code = "const s=require('http').createServer((q,r)=>r.end('ok')).listen(0,'127.0.0.1',()=>fetch('http://127.0.0.1:'+s.address().port).then(()=>console.log('SENT'),()=>console.log('FAILED')).finally(()=>s.close()))";
  assert.match((await depcage(fx, js(code))).out, /SENT/);
});

// macOS shares this computer's localhost with the sandbox in run mode. On Linux the sandbox
// always has a localhost of its own, so a server outside it is never reachable.
test("a server outside the sandbox: reachable in run mode on macOS only, never from installs or with --no-local", { skip: !supported }, async () => {
  const fx = fixture();
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; res.end("ok"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const code = `fetch('http://127.0.0.1:${server.address().port}/',{signal:AbortSignal.timeout(4000)}).then(()=>console.log('SENT'),()=>console.log('FAILED'))`;
  try {
    const shared = process.platform === "darwin";
    assert.match((await depcage(fx, js(code))).out, shared ? /SENT/ : /FAILED/);
    assert.equal(hits, shared ? 1 : 0);
    assert.match((await depcage(fx, ["--no-local", ...js(code)])).out, /FAILED/);
    assert.match((await depcage(fx, ["--mode", "install", ...js(code)])).out, /FAILED/);
    assert.equal(hits, shared ? 1 : 0);
  } finally { server.close(); }
});

test("exit codes pass through", { skip: !supported }, async () => {
  const fx = fixture();
  assert.equal((await depcage(fx, js("process.exit(7)"))).code, 7);
  assert.equal((await depcage(fx, js("process.exit(0)"))).code, 0);
  assert.equal((await depcage(fx, ["definitely-not-a-command-xyz"])).code, 127);
});

test("refuses to run with the home folder as the project", { skip: !supported }, async () => {
  const fx = fixture();
  const r = await new Promise((resolve) => {
    let err = "";
    const child = spawn(process.execPath, [BIN, "node", "-e", "console.log('RAN')"], { cwd: fx.home, env: { PATH: process.env.PATH, HOME: fx.home } });
    child.stderr.on("data", (c) => (err += c));
    let out = ""; child.stdout.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, err, out }));
  });
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.out, /RAN/);
});

test("the demo blocks every step it should", { skip: !supported }, async () => {
  const fx = fixture();
  const r = await depcage(fx, ["demo"], { HOME: os.homedir() });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /With depcage it received: nothing/);
});

test("stopping depcage also stops what the command left running", { skip: !supported }, async () => {
  const fx = fixture();
  const beat = path.join(fx.project, "beat.txt");
  // the parent exits on the signal without stopping its child, like a tool that leaves a dev server behind
  const childCode = `setInterval(()=>require('fs').writeFileSync(${JSON.stringify(beat)},String(Date.now())),50)`;
  const parentCode = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});console.log('READY');setInterval(()=>{},1000)`;
  const child = spawn(process.execPath, [BIN, "-q", ...js(parentCode)], { cwd: fx.project, env: { PATH: process.env.PATH, HOME: fx.home } });
  await new Promise((resolve) => child.stdout.on("data", (c) => String(c).includes("READY") && resolve()));
  while (!fs.existsSync(beat)) await new Promise((r) => setTimeout(r, 20));
  child.kill("SIGTERM");
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 143);
  const before = fs.readFileSync(beat, "utf8");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fs.readFileSync(beat, "utf8"), before, "the child kept running");
});
