const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname,
  '../src/app/views/admin-core/sessions/session-view/install-scripts.ts'), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
});
const loaded = { exports: {} };
new Function('exports', outputText)(loaded.exports);

for (const platform of ['darwin', 'linux']) {
  test(`Copilot installer on ${platform} installs the copilot CLI and preserves stdin for confirmations`, {
    skip: process.platform === 'win32',
  }, () => {
    // Mock all external commands: no installations, network or authentication.
    const mocks = `
      node() { echo v22.0.0; }
      brew() { return 0; }
      sudo() { "$@"; }
      npm() {
        if [ "$1" = root ]; then echo "$TMPDIR_NPM/lib/node_modules"; return 0; fi
        if [ "$1" = config ]; then [ "$2" = get ] && echo "$TMPDIR_NPM"; return 0; fi
        IFS= read -r answer || return 1
        [ "$answer" = Y ] || return 2
        echo "CONFIRMATION_RECEIVED $*"
      }
      export -f node brew sudo npm
    `;
    const script = loaded.exports.buildInstallScript('copilot', platform).replaceAll('\r', '\n');
    // Writable global folder and a throwaway HOME: nothing outside tmp is touched.
    const npmDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'po-npm-'));
    fs.mkdirSync(path.join(npmDir, 'lib/node_modules'), { recursive: true });
    const result = spawnSync('bash', ['-c', mocks + script], {
      input: 'Y\n', encoding: 'utf8', timeout: 5000,
      env: { ...process.env, HOME: npmDir, TMPDIR_NPM: npmDir },
    });
    fs.rmSync(npmDir, { recursive: true, force: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /CONFIRMATION_RECEIVED install -g @github\/copilot/);
  });
}

test('Linux installer picks the distro package manager when Node.js is missing', {
  skip: process.platform === 'win32',
}, () => {
  const script = loaded.exports.buildInstallScript('codex', 'linux').replaceAll('\r', '\n');
  // Fedora-like system: no node, no apt-get, dnf present. `command -v` is
  // overridden so the real system's tools do not matter.
  const mocks = `
    command() {
      if [ "$1" = -v ]; then
        case "$2" in dnf) return 0 ;; node) [ -f "$TMPMARK" ] && return 0 || return 1 ;; *) return 1 ;; esac
      fi
      builtin command "$@"
    }
    sudo() { "$@"; }
    dnf() { echo "DNF $*"; touch "$TMPMARK"; }
    npm() { if [ "$1" = prefix ]; then echo /tmp; else echo "NPM $*"; fi; }
    node() { echo v22.0.0; }
    export -f command sudo dnf npm node
  `;
  const mark = path.join(require('node:os').tmpdir(), `po-install-${process.pid}`);
  try {
    const result = spawnSync('bash', ['-c', mocks + script], {
      input: '', encoding: 'utf8', timeout: 5000, env: { ...process.env, TMPMARK: mark },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /DNF install -y nodejs npm/);
    assert.match(result.stdout, /NPM install -g @openai\/codex/);
    assert.doesNotMatch(result.stdout, /nodesource/i);
  } finally {
    fs.rmSync(mark, { force: true });
  }
});
