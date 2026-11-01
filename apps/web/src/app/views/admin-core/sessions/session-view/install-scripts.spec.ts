import {
  buildInstallScript,
  buildInstallScriptFile,
  CLAUDE_NATIVE_INSTALL,
  installerRunCommand,
  npmInstallCommand,
  PATH_MARKER,
} from './install-scripts';

/**
 * Regression guard for the Windows execution-policy fix.
 *
 * On win32 the install terminal is PowerShell: a bare `npm` resolves to the
 * npm.ps1 shim, which the default execution policy blocks ("running scripts
 * is disabled on this system"). Every npm invocation generated for win32
 * must therefore call `npm.cmd`, while macOS/Linux keep the bare `npm`.
 */
describe('install-scripts — win32 npm.cmd invariant', () => {
  const NPM_PROVIDERS: Array<[string, string]> = [
    ['claude-code-cli', '@anthropic-ai/claude-code'],
    ['codex', '@openai/codex'],
    ['gemini-cli', '@google/gemini-cli'],
  ];

  for (const [provider, pkg] of NPM_PROVIDERS) {
    it(`win32 auto-install for ${provider} uses npm.cmd and never bare npm`, () => {
      const script = buildInstallScript(provider, 'win32');
      expect(script).toContain(`npm.cmd install -g ${pkg}`);
      expect(script).not.toContain('npm install -g');
    });

    it(`darwin/linux auto-install for ${provider} uses the safe npm helper, never npm.cmd or sudo npm`, () => {
      for (const platform of ['darwin', 'linux']) {
        const script = buildInstallScript(provider, platform);
        expect(script).toContain(`npm_global_install ${pkg}`);
        expect(script).toContain('npm install -g "$1"');
        expect(script).not.toContain('npm.cmd');
        expect(script).not.toContain('sudo npm');
      }
    });
  }

  it('win32 script is typed into the PTY line by line (CR-joined, trailing CR)', () => {
    const script = buildInstallScript('claude-code-cli', 'win32');
    expect(script.endsWith('\r')).toBeTrue();
    expect(script).not.toContain('\n');
  });

  it('copilot installs the copilot CLI the app runs (npm @github/copilot), not the gh extension', () => {
    const copilotWin = buildInstallScript('copilot', 'win32');
    expect(copilotWin).toContain('npm.cmd install -g @github/copilot');
    expect(copilotWin).not.toContain('gh extension');
    for (const platform of ['darwin', 'linux']) {
      expect(buildInstallScript('copilot', platform)).toContain('npm_global_install @github/copilot');
    }
  });

  it('cursor scripts are npm-free', () => {

    const cursor = buildInstallScript('cursor', 'darwin');
    expect(cursor).toContain('https://cursor.com');
    expect(cursor).not.toContain('npm');
  });

  it('cursor installs the CLI the app runs (cursor-agent), not the editor, and has no Windows script', () => {
    for (const platform of ['darwin', 'linux']) {
      expect(buildInstallScript('cursor', platform)).toContain('curl https://cursor.com/install -fsS | bash');
    }
    expect(buildInstallScript('cursor', 'win32')).toBe('');
  });

  it('typed npm scripts keep the terminal on stdin (fd 3) and never sudo npm', () => {
    for (const platform of ['darwin', 'linux']) {
      const script = buildInstallScript('codex', platform);
      expect(script.startsWith("bash /dev/fd/3 3<< 'PROMPTOPS_INSTALL'")).toBeTrue();
      expect(script).not.toContain('sudo npm');
    }
    expect(buildInstallScript('codex', 'linux')).toContain('setup_22.x');
  });

  it('linux npm install falls back to a user prefix when the global one is not writable (EACCES)', () => {
    const script = buildInstallScriptFile('gemini-cli', 'linux');
    expect(script).toContain('npm config get prefix');
    expect(script).toContain('npm config set prefix "$HOME/.npm-global"');
    expect(script).toContain(PATH_MARKER);
    expect(script).toContain('set -o pipefail');
  });

  it('claude on darwin/linux uses the native installer (curl, then wget) with npm as last resort', () => {
    for (const platform of ['darwin', 'linux']) {
      const script = buildInstallScriptFile('claude-code-cli', platform);
      expect(script).toContain(CLAUDE_NATIVE_INSTALL);
      expect(script).toContain('wget -qO- https://claude.ai/install.sh | bash');
      expect(script).toContain('ensure_path "$HOME/.local/bin"');
      expect(script).toContain('npm_global_install @anthropic-ai/claude-code');
      expect(script.indexOf(CLAUDE_NATIVE_INSTALL)).toBeLessThan(script.indexOf('npm_global_install @anthropic-ai/claude-code'));
    }
  });

  it('script file is a plain bash script: shebang, LF lines, no heredoc wrapper', () => {
    const script = buildInstallScriptFile('codex', 'darwin');
    expect(script.startsWith('#!/usr/bin/env bash\n')).toBeTrue();
    expect(script).not.toContain('\r');
    expect(script).not.toContain('PROMPTOPS_INSTALL');
  });

  it('script file is empty on win32 and for providers without an installer', () => {
    expect(buildInstallScriptFile('claude-code-cli', 'win32')).toBe('');
    expect(buildInstallScriptFile('generic-shell', 'linux')).toBe('');
  });

  it('run command single-quotes the path, escaping embedded quotes', () => {
    expect(installerRunCommand("/Users/a b/it's/install.sh")).toBe("bash '/Users/a b/it'\\''s/install.sh'\r");
  });

  it('unknown provider yields an empty script', () => {
    expect(buildInstallScript('generic-shell', 'win32')).toBe('');
  });
});

describe('install-scripts — manual-tab npm command', () => {
  const pkg = '@anthropic-ai/claude-code';

  it('matches the platform pill: npm.cmd on win32, bare npm elsewhere (never sudo)', () => {
    expect(npmInstallCommand('linux', pkg)).toBe(`npm install -g ${pkg}`);
    expect(npmInstallCommand('win32', pkg)).toBe(`npm.cmd install -g ${pkg}`);
    expect(npmInstallCommand('darwin', pkg)).toBe(`npm install -g ${pkg}`);
  });
});
