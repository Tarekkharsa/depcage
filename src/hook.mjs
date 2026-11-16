// `depcage setup`: a block in the shell start-up file, so package manager commands that you
// type run inside the sandbox without writing `depcage` in front of them.
import fs from "node:fs";
import path from "node:path";

const START = "# >>> depcage >>>";
const END = "# <<< depcage <<<";
const WRAPPED = ["npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx"];

export function hookText() {
  return `${START}
# Added by \`depcage setup\`. Package manager commands typed in this shell run inside the
# depcage sandbox. Remove with \`depcage setup --remove\`.
# Skip the sandbox for one command with: DEPCAGE=off npm ...
_depcage_run() {
  if [ "\${DEPCAGE-}" = "off" ] || ! command -v depcage >/dev/null 2>&1; then
    command "$@"
  else
    command depcage --auto "$@"
  fi
}
${WRAPPED.map((c) => `${c}() { _depcage_run ${c} "$@"; }`).join("\n")}
# Vite+ has a shell function of its own for \`vp env use\`; it is kept and still used for
# the commands that manage Vite+ itself.
if command -v vp >/dev/null 2>&1; then
  if ! typeset -f _depcage_prev_vp >/dev/null 2>&1; then
    if typeset -f vp >/dev/null 2>&1; then
      eval "_depcage_prev_$(typeset -f vp)"
    else
      _depcage_prev_vp() { command vp "$@"; }
    fi
  fi
  vp() {
    case "\${1-}" in
      env|upgrade|implode) _depcage_prev_vp "$@" ;;
      *) if [ "\${DEPCAGE-}" = "off" ]; then _depcage_prev_vp "$@"; else _depcage_run vp "$@"; fi ;;
    esac
  }
  vpx() { _depcage_run vpx "$@"; }
  vpr() { _depcage_run vpr "$@"; }
fi
${END}
`;
}

export function rcFile(shell, home, env = {}) {
  if (shell === "zsh") return path.join(env.ZDOTDIR || home, ".zshrc");
  if (shell === "bash") return path.join(home, ".bashrc");
  return null;
}

export const stripHook = (text) => {
  const start = text.indexOf(START), end = text.indexOf(END);
  if (start < 0 || end < start) return text;
  return (text.slice(0, start).replace(/\n+$/, "\n") + text.slice(end + END.length).replace(/^\n/, "")).replace(/^\n+$/, "");
};

/** @returns {{file: string, changed: boolean}} */
export function setup({ shell, home, env = {}, remove = false }) {
  const file = rcFile(shell, home, env);
  if (!file) throw new Error(`the shell "${shell}" is not supported yet (zsh and bash are). Use --shell zsh or --shell bash.`);
  let before = "";
  try { before = fs.readFileSync(file, "utf8"); } catch {}
  let after = stripHook(before);
  if (!remove) after = after + (after && !after.endsWith("\n") ? "\n" : "") + (after ? "\n" : "") + hookText();
  if (after === before) return { file, changed: false };
  fs.writeFileSync(file, after);
  return { file, changed: true };
}
