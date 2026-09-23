#!/usr/bin/env node
/**
 * pier one-shot installer / uninstaller / updater / version inspector (cross-platform: macOS / Linux / Windows).
 *
 * Usage:
 *   node install.mjs install  [--dev]                        # Install (default command, 'install' can be omitted)
 *   node install.mjs update   [--dev]                        # Refresh both halves in place to latest release (no prior uninstall)
 *   node install.mjs version  [--json]                       # Local vs npm latest
 *   node install.mjs uninstall [--dev]                       # Uninstall both halves
 *   node install.mjs --prepare                                # npm prepare: hooksPath + repo root bin link
 *   node install.mjs --help
 *
 * Modes:
 *   User mode (default): pi install npm:pi-pier
 *                   + herdr plugin install July24/pier/packages/pier-workbench --yes
 *   --dev Development mode: pi install <repo>/packages/pier-ext + herdr plugin link <repo>/packages/pier-workbench
 *                   (linked directory is live; code edits take effect immediately).
 * Distribution specs can be overridden via --pi-spec= / --herdr-spec= (for npm publish or fork scenarios).
 * Failure semantics: Each step provides manual equivalent command; step failure does not abort reporting (exitCode=1).
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const EXT_DIR = join(ROOT, 'packages', 'pier-ext');
const WB_DIR = join(ROOT, 'packages', 'pier-workbench');
const EXT_PATH = join(EXT_DIR, 'src', 'index.ts');
const IS_WIN = process.platform === 'win32';
const COMMANDS = ['install', 'uninstall', 'update', 'version', 'help'];

/** Workspace root is named pier-setup but npm does not bin-link it, so
 * `npx pier-setup@version` from the clone runs `sh -c pier-setup` against a
 * missing node_modules/.bin/pier-setup. Published tarball has no packages/. */
function prepareRepo() {
  if (existsSync(join(ROOT, '.githooks'))) {
    try { execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' }); } catch { /* not a git checkout */ }
  }
  if (!existsSync(EXT_PATH)) return;
  const binDir = join(ROOT, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  const posix = join(binDir, 'pier-setup');
  const cmd = join(binDir, 'pier-setup.cmd');
  rmSync(posix, { force: true });
  rmSync(cmd, { force: true });
  if (IS_WIN) {
    writeFileSync(cmd, '@echo off\r\nnode "%~dp0\\..\\..\\install.mjs" %*\r\n');
    writeFileSync(posix, '#!/bin/sh\nexec node "$(dirname "$0")/../../install.mjs" "$@"\n');
    try { chmodSync(posix, 0o755); } catch { /* git-bash optional */ }
  } else {
    symlinkSync('../../install.mjs', posix);
  }
}

const argv = process.argv.slice(2);
if (argv[0] === '--prepare') {
  prepareRepo();
  process.exit(0);
}
const command = COMMANDS.includes(argv[0]) ? argv.shift() : null;
const flags = new Set(argv.filter((a) => (a.startsWith('--') && !a.includes('=')) || a === '-h' || a === '-v'));
const optValue = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? null;
const dev = flags.has('--dev');
const PI_SPEC = optValue('pi-spec') ?? 'npm:pi-pier';   // User mode defaults to npm release; --pi-spec=git:github.com/July24/pier tracks repo main
const HERDR_SPEC = optValue('herdr-spec') ?? 'July24/pier/packages/pier-workbench';

const log = (m) => console.log(m);
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };

/* ── Utility functions ────────────────────────────────────────────── */
function which(bin) {
  try {
    const out = execFileSync(IS_WIN ? 'where' : 'which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // 'where' may return multiple lines (one per PATH hit); pick the first existing line
    for (const line of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (existsSync(line)) return line;
    }
    return null;
  } catch {
    return null;
  }
}

function run(cmd, args, opts = {}) {
  // win32: npm global bin is a .cmd shim; spawning directly without shell triggers ENOENT/EINVAL, must run via cmd.exe;
  // also when shell:true, Node concatenates args with bare spaces (unquoted), breaking path args with spaces, so pre-join and quote.
  // POSIX uses native branch, preserving execFileSync(cmd, args) semantics.
  if (IS_WIN) {
    const cmdline = [cmd, ...args]
      .map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
      .join(' ');
    return execFileSync(cmdline, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true, ...opts }).trim();
  }
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function tryRun(cmd, args) {
  try { run(cmd, args); return true; } catch (e) { log(`  (${e.message.split('\n')[0]})`); return false; }
}

function parseVersion(s) {
  const m = String(s).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function geVersion(v, min) {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

function cmpSemver(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function readPkgVersion(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function npmLatest(name) {
  try {
    return run('npm', ['view', name, 'version'], { timeout: 15000 });
  } catch {
    return null;
  }
}


/* ── Environment check (pre-install) ────────────────────────────────── */
function checkEnv() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 22) die(`node ≥ 22 required, found ${process.versions.node}`);
  log(`✓ node ${process.versions.node}`);
  const piVersion = (() => { try { return parseVersion(run('pi', ['--version'])); } catch { return null; } })();
  if (!piVersion || !geVersion(piVersion, [0, 86, 0])) {
    die(`pi ≥ 0.86.0 required${piVersion ? `, found ${piVersion.join('.')}` : ' (pi not found or not runnable)'}. Install: npm i -g @earendil-works/pi-coding-agent`);
  }
  log(`✓ pi ${piVersion.join('.')}`);
  const herdrVersion = (() => { try { return parseVersion(run('herdr', ['--version'])); } catch { return null; } })();
  if (!herdrVersion || !geVersion(herdrVersion, [0, 9, 0])) {
    die(`herdr ≥ 0.9.0 required${herdrVersion ? `, found ${herdrVersion.join('.')}` : ' (herdr not found)'}. Install: https://herdr.dev/`);
  }
  log(`✓ herdr ${herdrVersion.join('.')}`);
  return { piVersion, herdrVersion };
}

/** pi extension source: user mode uses git/npm spec, dev mode uses local directory. */
const piSource = () => (dev ? EXT_DIR : PI_SPEC);


function piAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
}

/* ── Legacy git-mode registration migration ────────────────────────── */
// When legacy `pi install git:github.com/July24/pier` coexists with npm:pi-pier,
// both extensions register identical tools (todo_write / ask_user_question...), causing conflict at pi launch.
const LEGACY_GIT_SPEC = 'git:github.com/July24/pier';

function registeredPiPackages() {
  try {
    return JSON.parse(readFileSync(join(piAgentDir(), 'settings.json'), 'utf8'))?.packages ?? [];
  } catch { return []; }
}

/** Clean up legacy git-mode registration before install/update; if --pi-spec explicitly specifies that git source, treat it as target and keep it. */
function removeLegacyGitRegistration() {
  if (piSource() === LEGACY_GIT_SPEC) return;
  if (!registeredPiPackages().includes(LEGACY_GIT_SPEC)) return;
  if (tryRun('pi', ['remove', LEGACY_GIT_SPEC])) log(`✓ removed legacy git-mode registration (${LEGACY_GIT_SPEC}); using ${piSource()}`);
  else { console.error('✗ failed to remove legacy git-mode registration'); log(`  manual: pi remove ${LEGACY_GIT_SPEC}`); process.exitCode = 1; }
}

function npmNameFromSpec(spec) {
  if (!spec.startsWith('npm:')) return null;
  const rest = spec.slice(4);
  if (rest.startsWith('@')) {
    const slash = rest.indexOf('/');
    if (slash < 0) return rest;
    return `${rest.slice(0, slash)}/${rest.slice(slash + 1).split('@')[0]}`;
  }
  return rest.split('@')[0];
}

function extPathFromPiList() {
  let out;
  try { out = run('pi', ['list']); } catch { return null; }
  const lines = out.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const spec = lines[i].trim();
    const loc = lines[i + 1]?.trim();
    if (!loc) continue;
    if (!/pi-pier|pier-ext|july24\/pier/i.test(spec)) continue;
    for (const c of [join(loc, 'src', 'index.ts'), join(loc, 'packages', 'pier-ext', 'src', 'index.ts')]) {
      if (existsSync(c)) return c;
    }
  }
  return null;
}

/** User-mode extPath: pi's installed package, never the pier-setup npx cache. */
function resolveUserExtPath() {
  const candidates = [];
  const npmName = npmNameFromSpec(PI_SPEC);
  if (npmName) candidates.push(join(piAgentDir(), 'npm', 'node_modules', npmName, 'src', 'index.ts'));
  if (PI_SPEC.startsWith('git:')) {
    const hostPath = PI_SPEC.slice(4).replace(/^git@/, '').replace(/:/g, '/');
    candidates.push(
      join(piAgentDir(), 'git', hostPath, 'packages', 'pier-ext', 'src', 'index.ts'),
      join(piAgentDir(), 'git', hostPath, 'src', 'index.ts'),
    );
  }
  candidates.push(
    join(piAgentDir(), 'npm', 'node_modules', 'pi-pier', 'src', 'index.ts'),
    join(piAgentDir(), 'git', 'github.com', 'July24', 'pier', 'packages', 'pier-ext', 'src', 'index.ts'),
  );
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return extPathFromPiList();
}


function pkgDirFromExtPath(extPath) {
  let d = dirname(extPath);
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(d, 'package.json'))) return d;
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return null;
}

function herdrPluginInfo() {
  let out;
  try { out = run('herdr', ['plugin', 'list']); } catch { return { installed: false, spec: null, sha: null }; }
  const line = out.split(/\r?\n/).find((l) => l.includes('pier.workbench'));
  if (!line) return { installed: false, spec: null, sha: null };
  const bracket = line.match(/\[([^\]]+)\]/);
  const spec = bracket ? bracket[1] : line.trim();
  const at = spec.lastIndexOf('@');
  const fullSha = at >= 0 && !spec.startsWith('local:') ? spec.slice(at + 1) : null;
  return { installed: true, spec, sha: fullSha ? fullSha.slice(0, 7) : null };
}

function collectStatus() {
  const installer = readPkgVersion(ROOT);
  const extPath = dev ? (existsSync(EXT_PATH) ? EXT_PATH : null) : resolveUserExtPath();
  const extDir = extPath ? pkgDirFromExtPath(extPath) : null;
  return {
    product: (extDir ? readPkgVersion(extDir) : null) || installer,
    mode: dev ? 'dev' : 'user',
    installer: { name: 'pier-setup', version: installer },
    piExt: { spec: piSource(), version: extDir ? readPkgVersion(extDir) : null, path: extDir },
    herdr: herdrPluginInfo(),
    latest: { 'pier-setup': npmLatest('pier-setup'), 'pi-pier': npmLatest('pi-pier') },
  };
}

/* ── Commands ─────────────────────────────────────────────────────── */
function usage() {
  log(`pier-setup — install / update / inspect pier (pi-pier + pier.workbench)

Usage:
  pier-setup [install] [--dev]
  pier-setup update    [--dev]
  pier-setup version   [--json]
  pier-setup uninstall [--dev]

  npx pier-setup@latest          # recommended user install
  npx pier-setup@latest update   # refresh both halves to newest release
  npx pier-setup@latest version  # local vs npm latest

  --pi-spec= / --herdr-spec= override distribution sources
  --dev  local link (clone); the linked directories are live`);
}

function version() {
  const s = collectStatus();
  if (flags.has('--json')) {
    log(JSON.stringify(s, null, 2));
    return;
  }
  log(`pier ${s.product ?? 'not installed'}${s.mode === 'dev' ? '  (dev, local link)' : ''}`);
  log('');
  log(`  installer   pier-setup      ${s.installer.version ?? 'unknown'}    (this CLI)`);
  log(`  pi ext      ${s.piExt.spec}    ${s.piExt.version ?? 'not installed'}    ${s.piExt.path ?? ''}`);
  const herdrVer = s.herdr.installed ? (s.herdr.sha ?? s.herdr.spec) : 'not installed';
  log(`  herdr       pier.workbench  ${herdrVer}    ${s.herdr.spec ?? ''}`);
  log('');
  const ls = s.latest['pier-setup'] ?? 'unavailable (offline?)';
  const lp = s.latest['pi-pier'] ?? 'unavailable (offline?)';
  log(`  npm latest  pier-setup ${ls}    pi-pier ${lp}`);
  if (s.installer.version && s.piExt.version && s.installer.version !== s.piExt.version) {
    log(`\n⚠ mismatch: installer ${s.installer.version} ≠ pi-pier ${s.piExt.version}`);
  }
  const target = s.latest['pi-pier'];
  if (s.piExt.version && target && cmpSemver(s.piExt.version, target) < 0) {
    log(`\nupdate available → ${target}    npx pier-setup@latest update`);
  }
}

function update() {
  checkEnv();
  removeLegacyGitRegistration();
  const me = readPkgVersion(ROOT);
  const latestSetup = npmLatest('pier-setup');
  if (latestSetup && me && cmpSemver(me, latestSetup) < 0) {
    log(`⚠ installer ${me} < latest ${latestSetup} — re-run: npx pier-setup@latest update`);
  }
  if (dev) {
    log('dev mode: local link is live; pull the repo yourself (no installer-managed files to refresh).');
  } else {
    if (tryRun('pi', ['update', piSource()])) log(`✓ pi extension updated (${piSource()})`);
    else if (tryRun('pi', ['install', piSource()])) log(`✓ pi extension installed (${piSource()})`);
    else { console.error('✗ pi update/install failed'); log(`  manual: pi update ${piSource()}`); process.exitCode = 1; }
    if (tryRun('herdr', ['plugin', 'install', HERDR_SPEC, '--yes'])) log(`✓ herdr plugin updated (${HERDR_SPEC})`);
    else { console.error('✗ herdr plugin update failed'); log(`  manual: herdr plugin install ${HERDR_SPEC} --yes`); process.exitCode = 1; }
  }
  log('');
  version();
}

function install() {
  checkEnv();
  removeLegacyGitRegistration();

  if (dev) {
    if (tryRun('pi', ['install', piSource()])) log('✓ pi extension installed (packages/pier-ext, local)');
    else { console.error('✗ pi install failed'); log(`  manual: pi install ${EXT_DIR}`); process.exitCode = 1; }
    if (tryRun('herdr', ['plugin', 'link', WB_DIR])) log('✓ herdr plugin linked (packages/pier-workbench, local)');
    else { console.error('✗ herdr plugin link failed'); log(`  manual: herdr plugin link ${WB_DIR}`); process.exitCode = 1; }
  } else {
    if (tryRun('pi', ['install', piSource()])) log(`✓ pi extension installed (${PI_SPEC})`);
    else { console.error('✗ pi install failed'); log(`  manual: pi install ${PI_SPEC}`); process.exitCode = 1; }
    if (tryRun('herdr', ['plugin', 'install', HERDR_SPEC, '--yes'])) log(`✓ herdr plugin installed (${HERDR_SPEC})`);
    else { console.error('✗ herdr plugin install failed'); log(`  manual: herdr plugin install ${HERDR_SPEC}`); process.exitCode = 1; }
  }

  log(`
pier installed (${dev ? 'dev mode: local paths, code changes are live' : 'user mode: managed checkouts'}). Next:
  1. start herdr, open/create a workspace and run \`pi\` inside a pane
  2. inside pi, ask the model to use todo_write / subagent tools`);
}

function uninstall() {
  if (tryRun('pi', ['remove', piSource()])) log('✓ pi extension removed');
  else { console.error('✗ pi remove failed'); log(`  manual: pi remove ${piSource()}`); process.exitCode = 1; }

  if (dev) {
    if (tryRun('herdr', ['plugin', 'unlink', 'pier.workbench'])) log('✓ herdr plugin unlinked (files kept)');
    else { console.error('✗ herdr plugin unlink failed'); log('  manual: herdr plugin unlink pier.workbench'); process.exitCode = 1; }
  } else {
    if (tryRun('herdr', ['plugin', 'uninstall', 'pier.workbench'])) log('✓ herdr plugin uninstalled (managed checkout removed)');
    else { console.error('✗ herdr plugin uninstall failed'); log('  manual: herdr plugin uninstall pier.workbench'); process.exitCode = 1; }
  }
  log('\npier uninstalled.');
}

if (command === 'help' || flags.has('--help') || flags.has('-h')) usage();
else if (command === 'version' || flags.has('--version') || flags.has('-v')) version();
else if (command === 'uninstall') uninstall();
else if (command === 'update') update();
else install();
