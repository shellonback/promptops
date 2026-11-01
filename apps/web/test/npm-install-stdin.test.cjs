'use strict';
// The npm auto-installer runs in the provider install terminal: the script is
// read from fd 3 so the installers it starts (Homebrew, sudo, npm) still read
// the user's answers from the terminal on stdin.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname,
  '../src/app/views/admin-core/sessions/session-view/install-scripts.ts'), 'utf8');
const loaded = { exports: {} };
new Function('exports', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(loaded.exports);

for (const [platform, prefixWritable] of [['darwin', true], ['linux', true], ['linux', false]]) {
  test(`npm installer on ${platform} (prefix ${prefixWritable ? 'writable' : 'root-owned'}) keeps stdin for prompts`, {
    skip: process.platform === 'win32',
  }, () => {
    // Every external command is mocked: nothing is installed.
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'po-npm-'));
    const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'po-home-'));
    fs.mkdirSync(path.join(dir, 'lib/node_modules'), { recursive: true });
    if (!prefixWritable) fs.chmodSync(path.join(dir, 'lib/node_modules'), 0o500);
    const mocks = `
      node() { echo v22.0.0; }
      brew() { return 0; }
      npm() {
        if [ "$1" = root ]; then echo "${dir}/lib/node_modules"; return 0; fi
        if [ "$1" = config ]; then [ "$2" = get ] && echo "${dir}"; [ "$2" = set ] && echo "NPM_PREFIX_SET $4"; return 0; fi
        IFS= read -r answer || return 1
        [ "$answer" = Y ] || return 2
        echo "NPM_INSTALL $*"
      }
      sudo() { echo SUDO; "$@"; }
      export -f node brew npm sudo
    `;
    const script = loaded.exports.buildInstallScript('codex', platform).replaceAll('\r', '\n');
    const result = spawnSync('bash', ['-c', mocks + script], {
      input: 'Y\n', encoding: 'utf8', timeout: 5000, env: { ...process.env, HOME: home },
    });
    fs.chmodSync(path.join(dir, 'lib/node_modules'), 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /NPM_INSTALL install -g @openai\/codex/);
    // Never sudo: a root-owned prefix switches npm to a user folder instead.
    assert.equal(/SUDO/.test(result.stdout), false);
    assert.equal(/NPM_PREFIX_SET .*\.npm-global/.test(result.stdout), !prefixWritable);
  });
}
