// Pure builders for the provider install guide. On win32 the install terminal
// is PowerShell, where a bare `npm` resolves to the npm.ps1 shim and the
// default execution policy blocks it ("running scripts is disabled on this
// system") — always call npm.cmd there.

const NPM_PACKAGES: Record<string, string> = {
  'claude-code-cli': '@anthropic-ai/claude-code',
  'codex': '@openai/codex',
  'gemini-cli': '@google/gemini-cli',
  // The app runs the `copilot` binary (session.rs provider_command), which
  // is this package — not `gh` with the old gh-copilot extension.
  'copilot': '@github/copilot',
};

/** Official Claude Code native installer (no Node, no root, installs to ~/.local/bin). */
export const CLAUDE_NATIVE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';

/**
 * One-line npm install command for the manual tab (shown text = executed text).
 * Never `sudo` on Linux: with Node from apt the global prefix is /usr, and the
 * fix for EACCES is a user prefix (see the troubleshoot box), not root.
 */
export function npmInstallCommand(platform: string, pkg: string): string {
  if (platform === 'win32') return `npm.cmd install -g ${pkg}`;
  return `npm install -g ${pkg}`;
}

/** Marker on every rc line the installer appends, so re-runs never duplicate it. */
export const PATH_MARKER = '# Added by PromptOps installer';

// Shared bash helpers for the macOS/Linux scripts.
// ensure_path: export a bin dir now and persist it in the rc files the agent
// PTY (`$SHELL -l -i`) and new terminals read, once per dir.
// npm_global_install: if the global prefix is not writable (Node from apt →
// /usr), switch npm to ~/.npm-global instead of failing with EACCES; never sudo.
const UNIX_HELPERS = [
  'ensure_path() {',
  '  case ":$PATH:" in *":$1:"*) ;; *) export PATH="$1:$PATH" ;; esac',
  '  case "$SHELL" in',
  '    *zsh) rcs="$HOME/.zshrc" ;;',
  '    *bash)',
  '      login="$HOME/.profile"',
  '      [ -f "$HOME/.bash_login" ] && login="$HOME/.bash_login"',
  '      [ -f "$HOME/.bash_profile" ] && login="$HOME/.bash_profile"',
  '      rcs="$login $HOME/.bashrc" ;;',
  '    *) rcs="$HOME/.profile" ;;',
  '  esac',
  `  line="export PATH=\\"$1:\\$PATH\\"  ${PATH_MARKER}"`,
  '  for rc in $rcs; do',
  '    if ! grep -qF "$line" "$rc" 2>/dev/null; then',
  '      [ -s "$rc" ] && [ -n "$(tail -c 1 "$rc")" ] && echo "" >> "$rc"',
  '      echo "$line" >> "$rc"',
  '      echo "Added $1 to PATH in $rc"',
  '    fi',
  '  done',
  '}',
  'npm_global_install() {',
  '  root="$(npm root -g 2>/dev/null || true)"',
  '  prefix="$(npm config get prefix 2>/dev/null || true)"',
  '  if [ -w "$root" ] || { [ -n "$root" ] && [ ! -e "$root" ] && [ -w "$prefix" ]; }; then',
  '    :',
  '  else',
  '    echo "The npm global folder ($prefix) is not writable by $(whoami)."',
  '    echo "Switching npm to a user folder (~/.npm-global): no sudo needed."',
  '    mkdir -p "$HOME/.npm-global"',
  '    npm config set prefix "$HOME/.npm-global"',
  '  fi',
  '  echo "Installing $1..."',
  '  if ! npm install -g "$1"; then',
  '    echo ""',
  '    echo "✗ Installation of $1 failed (see the npm messages above: network or permissions)."',
  '    echo "  Avoid running npm as root: the Manual tab shows how to use a user npm folder."',
  '    exit 1',
  '  fi',
  '  bin="$(npm config get prefix)/bin"',
  '  case "$bin" in "$HOME"/*) ensure_path "$bin" ;; esac',
  '}',
];

/** Plain bash lines of the macOS/Linux installer, or null when there is none. */
function unixScriptLines(provider: string, platform: string): string[] | null {
  const pkg = NPM_PACKAGES[provider];

  if (pkg) {
    const nodeInstall = platform === 'darwin'
      ? [
          'if ! command -v node &>/dev/null; then',
          '  echo "Node.js not found. Installing via Homebrew..."',
          '  if ! command -v brew &>/dev/null; then',
          '    echo "Homebrew not found. Installing..."',
          '    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          // Apple silicon installs to /opt/homebrew, Intel Macs to /usr/local.
          '    eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"',
          '  fi',
          '  brew install node',
          'else',
          '  echo "Node.js $(node --version) found"',
          'fi',
        ]
      : [
          // NodeSource's setup script is Debian/Ubuntu only: use the distro's
          // own package on Fedora/RHEL and Arch, and stop with a clear message
          // elsewhere instead of failing halfway.
          'if ! command -v node &>/dev/null; then',
          '  if command -v apt-get &>/dev/null; then',
          '    echo "Node.js not found. Installing via NodeSource..."',
          '    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -',
          '    sudo apt-get install -y nodejs',
          '  elif command -v dnf &>/dev/null; then',
          '    echo "Node.js not found. Installing with dnf..."',
          '    sudo dnf install -y nodejs npm',
          '  elif command -v pacman &>/dev/null; then',
          '    echo "Node.js not found. Installing with pacman..."',
          '    sudo pacman -S --needed --noconfirm nodejs npm',
          '  else',
          '    echo "Node.js not found. Install Node.js 22 or newer (https://nodejs.org), then click Retry."',
          '    exit 1',
          '  fi',
          'else',
          '  echo "Node.js $(node --version) found"',
          'fi',
        ];

    // Claude: official native installer first (no Node, no root); npm only as
    // a fallback when neither curl nor wget is available or it fails.
    const body = provider === 'claude-code-cli'
      ? [
          'installed=0',
          'if command -v curl &>/dev/null; then',
          '  echo "Installing Claude Code with the official native installer..."',
          `  if ${CLAUDE_NATIVE_INSTALL}; then installed=1; fi`,
          'elif command -v wget &>/dev/null; then',
          '  echo "Installing Claude Code with the official native installer..."',
          '  if wget -qO- https://claude.ai/install.sh | bash; then installed=1; fi',
          'fi',
          'if [ "$installed" = 1 ]; then',
          '  ensure_path "$HOME/.local/bin"',
          '  claude --version || true',
          'else',
          '  echo "Native installer unavailable or failed: falling back to npm."',
          ...nodeInstall.map((l) => '  ' + l),
          `  npm_global_install ${pkg}`,
          'fi',
        ]
      : [
          ...nodeInstall,
          'echo ""',
          `npm_global_install ${pkg}`,
        ];

    return [
      'set -e',
      'set -o pipefail',
      'echo "=== PromptOps Auto-Installer ==="',
      'echo ""',
      ...UNIX_HELPERS,
      ...body,
      'echo ""',
      'echo "Done! Click Retry to verify."',
    ];
  }

  // Cursor: the app runs the Cursor CLI (`cursor-agent`), installed by
  // Cursor's script on macOS and Linux. On Windows it is installed by hand.
  if (provider === 'cursor') {
    return [
      'set -e',
      'echo "=== PromptOps Auto-Installer ==="',
      'echo ""',
      'echo "Installing the Cursor CLI (cursor-agent)..."',
      'curl https://cursor.com/install -fsS | bash',
      'echo ""',
      'echo "Done! Click Retry to verify."',
    ];
  }

  return null;
}

/**
 * macOS/Linux installer as a standalone script file (the desktop app writes it
 * to disk and the PTY only gets `installerRunCommand`). Typed whole, a ~2 KB
 * script overflows the tty input queue (~1 KB on macOS) and bash drops characters.
 * Empty on win32 (PowerShell stays typed) or when the provider has none.
 */
export function buildInstallScriptFile(provider: string, platform: string): string {
  if (platform === 'win32') return '';
  const lines = unixScriptLines(provider, platform);
  return lines ? ['#!/usr/bin/env bash', ...lines].join('\n') + '\n' : '';
}

/** Short line typed into the PTY to run a script file written by the desktop app. */
export function installerRunCommand(scriptPath: string): string {
  return `bash '${scriptPath.replace(/'/g, `'\\''`)}'\r`;
}

/**
 * Installer typed straight into the PTY: PowerShell on win32, a bash heredoc
 * on macOS/Linux (fallback when the script cannot go through a file, e.g.
 * a WSL shell on Windows).
 */
export function buildInstallScript(provider: string, platform: string): string {
  const pkg = NPM_PACKAGES[provider];

  if (platform === 'win32') {
    if (!pkg) return '';
    return [
      '& {',
      '  $ErrorActionPreference = "Stop"',
      '  Write-Host "=== PromptOps Auto-Installer ===" -ForegroundColor Cyan',
      '  if (!(Get-Command node -ErrorAction SilentlyContinue)) {',
      '    Write-Host "Node.js not found. Installing..." -ForegroundColor Yellow',
      '    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements',
      '    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")',
      '  } else {',
      '    Write-Host "Node.js found" -ForegroundColor Green',
      '  }',
      `  Write-Host "Installing ${pkg}..." -ForegroundColor Yellow`,
      `  npm.cmd install -g ${pkg}`,
      '  Write-Host ""',
      '  Write-Host "Done! Click Retry to verify." -ForegroundColor Green',
      '}',
    ].join('\r') + '\r';
  }

  const lines = unixScriptLines(provider, platform);
  if (!lines) return '';
  // Read the script from fd 3 so Homebrew, sudo and npm keep the PTY on
  // stdin: with the script on stdin the Homebrew installer runs
  // non-interactively and aborts at its sudo prompt.
  return ["bash /dev/fd/3 3<< 'PROMPTOPS_INSTALL'", ...lines, 'PROMPTOPS_INSTALL'].join('\r') + '\r';
}
