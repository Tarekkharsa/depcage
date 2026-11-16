// `depcage demo`: runs a harmless simulated attack twice, without and with the sandbox,
// against a throw-away fake home folder. Also a self-test: it exits 1 if anything that
// should be blocked was not.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildPolicy } from "./policy.mjs";
import { runSandboxed, supportReason } from "./run.mjs";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bad = (s) => paint("31", s), good = (s) => paint("32", s), dim = (s) => paint("2", s), bold = (s) => paint("1", s);

function makeFixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "depcage-demo-")));
  const home = path.join(dir, "home"), project = path.join(dir, "project");
  const pkg = path.join(project, "node_modules", "handy-colors");
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(home, ".depcage-demo-home"), "marker: this is the fake home folder of depcage demo\n");
  fs.writeFileSync(path.join(home, ".npmrc"), "//registry.npmjs.org/:_authToken=npm_FAKE_DEMO_TOKEN\n");
  fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "FAKE DEMO SSH KEY\n");
  fs.writeFileSync(path.join(home, ".zshrc"), "# fake shell start-up file\n");
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "demo-project", private: true }) + "\n");
  fs.writeFileSync(path.join(project, ".env"), "PAYMENTS_KEY=sk_FAKE_DEMO\n");
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "handy-colors", version: "1.0.1", scripts: { postinstall: "node attack.cjs" } }) + "\n");
  fs.copyFileSync(fileURLToPath(new URL("./demo/attack.cjs", import.meta.url)), path.join(pkg, "attack.cjs"));
  return { dir, home, project, script: path.join(pkg, "attack.cjs") };
}

function startAttackerServer() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { try { received.push(JSON.parse(body)); } catch {} res.end("ok"); });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, received, url: `http://127.0.0.1:${server.address().port}/` })));
}

const parseResult = (text) => { const m = /DEMO_RESULT (.*)/.exec(text); return m ? JSON.parse(m[1]) : null; };

function runPlain(argv, cwd, env) {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (c) => (out += c));
    child.on("close", () => resolve(out));
  });
}

async function runCaged(argv, fx, env, options) {
  let accountHome = [];
  try { accountHome = [os.userInfo().homedir]; } catch {}
  const policy = buildPolicy({ argv, cwd: fx.project, home: fx.home, otherHomes: accountHome, env, platform: process.platform, options });
  let out = "";
  await runSandboxed({ argv, policy, cwd: fx.project, stdio: ["ignore", "pipe", "ignore"], onChild: (c) => c.stdout.on("data", (d) => (out += d)) });
  return out;
}

const ROWS = [
  ["read your npm login token (~/.npmrc)", (r) => r.npmToken !== null],
  ["read your SSH private key (~/.ssh)", (r) => r.sshKey !== null],
  ["read a cloud API token from the environment", (r) => r.envToken !== null],
  ["read the project's .env file", (r) => r.dotenv !== null],
  ["add a line to ~/.zshrc so it runs again later", (r) => r.persisted],
  ["send what it found to the attacker's server", (r) => r.sent],
];

export async function demo() {
  const reason = supportReason();
  if (reason) { console.error(`depcage: ${reason}`); return 2; }
  const fx = makeFixture();
  const attacker = await startAttackerServer();
  const env = { PATH: process.env.PATH, HOME: fx.home, DEMO_CLOUD_API_TOKEN: "FAKE_DEMO_CLOUD_TOKEN", DEMO_ATTACKER_URL: attacker.url };
  const argv = [process.execPath, fx.script];
  let failed = false;
  try {
    console.log(bold("depcage demo") + " — a simulated attack, harmless and offline");
    console.log(dim(`Fake home folder with fake secrets: ${fx.home}`));
    console.log(dim("Nothing real is read. The \"attacker's server\" is this program, on this computer.\n"));

    const stages = [
      { title: "During `npm install`: a dependency's install script tries to", options: { mode: "install" }, expectDotenv: false },
      { title: "During `npm test`: a dependency's code, loaded by your tests, tries to", options: { mode: "run", local: false }, expectDotenv: true },
    ];
    for (const stage of stages) {
      const plain = parseResult(await runPlain(argv, fx.project, env));
      const before = attacker.received.length;
      const caged = parseResult(await runCaged(argv, fx, env, stage.options));
      const leaked = attacker.received.length > before;
      if (!plain || !caged) { console.error("depcage: the demo script did not report a result"); return 1; }

      const width = Math.max(...ROWS.map((r) => r[0].length)) + 2;
      console.log(bold(stage.title));
      console.log("  " + "".padEnd(width) + "without depcage   with depcage");
      for (const [label, happened] of ROWS) {
        const isDotenv = label.includes(".env");
        const a = happened(plain) ? bad("yes".padEnd(18)) : "no".padEnd(18);
        let b;
        if (happened(caged) && isDotenv && stage.expectDotenv) b = "yes (tests need it)";
        else if (happened(caged)) { b = bad("NOT BLOCKED"); failed = true; }
        else b = good("blocked");
        console.log("  " + label.padEnd(width) + a + b);
      }
      if (leaked) { failed = true; console.log(bad("  The attacker's server received data from the sandboxed run.")); }
      console.log("");
    }
    const got = attacker.received[0] || {};
    console.log(`Without depcage the attacker's server received: ${Object.entries(got).filter(([, v]) => typeof v === "string").map(([, v]) => JSON.stringify(v.split("\n")[0].slice(0, 44))).join(", ")}`);
    console.log(`With depcage it received: ${failed ? bad("something — see above") : good("nothing")}`);
    console.log(dim("\nNote: the demo's server is on this computer, so the `npm test` part runs with --no-local."));
    console.log(dim("A real attacker's server is on the internet, which is blocked in every mode unless you allow a host."));
    return failed ? 1 : 0;
  } finally {
    attacker.server.close();
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
}
