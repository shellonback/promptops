#!/usr/bin/env node
/**
 * Builds promptops-termd (the external PTY host) for a target and places it where
 * Tauri looks for `bundle.externalBin` sidecars:
 *   src-tauri/binaries/promptops-termd-<target-triple>[.exe]
 * The Tauri bundle copies it next to the app executable (without the suffix),
 * where termd_link.rs finds it. Run it before each release `tauri build`
 * (with --config src-tauri/tauri.sidecar.conf.json), including Linux container builds.
 *
 * Usage: node scripts/build-termd.js <target-triple> [--xwin]
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TERMD_DIR = path.join(ROOT, 'termd');
const BIN_DIR = path.join(ROOT, 'src-tauri', 'binaries');

const triple = process.argv[2];
if (!triple) {
  console.error('usage: node scripts/build-termd.js <target-triple> [--xwin]');
  process.exit(2);
}
const isWindows = triple.includes('windows');
const useXwin = isWindows && (process.argv.includes('--xwin') || process.platform !== 'win32');
const cargo = useXwin ? 'cargo xwin build' : 'cargo build';

console.log(`\n→ termd ${triple} (${cargo})`);
execSync(`${cargo} --release --target ${triple}`, {
  cwd: TERMD_DIR,
  stdio: 'inherit',
  env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:/opt/homebrew/opt/llvm/bin:${process.env.PATH}` },
});

const exe = isWindows ? 'promptops-termd.exe' : 'promptops-termd';
const built = path.join(TERMD_DIR, 'target', triple, 'release', exe);
if (!fs.existsSync(built)) {
  console.error(`✖ termd binary not found: ${built}`);
  process.exit(1);
}
fs.mkdirSync(BIN_DIR, { recursive: true });
const dst = path.join(BIN_DIR, `promptops-termd-${triple}${isWindows ? '.exe' : ''}`);
fs.copyFileSync(built, dst);
fs.chmodSync(dst, 0o755);
console.log(`   ${path.relative(ROOT, dst)} (${Math.round(fs.statSync(dst).size / 1024)} KB)`);
