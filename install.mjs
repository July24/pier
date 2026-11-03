#!/usr/bin/env node
/**
 * pier one-shot installer / uninstaller / updater / version inspector (cross-platform: macOS / Linux / Windows).
 *
 * Usage:
 *   node install.mjs install  [--dev]                        # Install (default command, 'install' can be omitted)
 *   node install.mjs update   [--dev]                        # Refresh the pi extension in place to latest release (no prior uninstall)
 *   node install.mjs version  [--json]                       # Local vs npm latest
 *   node install.mjs uninstall [--dev]                       # Uninstall the pi extension
 *   node install.mjs --prepare                                # npm prepare: hooksPath + repo root bin link
 *   node install.mjs --help
 *
 * Modes:
 *   User mode (default): pi install npm:pi-pier
 *   --dev Development mode: pi install <repo>/packages/pier-ext
 *                   (linked directory is live; code edits take effect immediately).
 * The extension runs inside a herdr-core (`hc`) terminal; the Herdr app only displays those terminals.
 * `hc` is a preflight requirement; `herdr-app` presence is reported as information, never enforced.
 * The distribution spec can be overridden via --pi-spec= (for npm publish or fork scenarios).
 * Legacy: install / update / uninstall offer to remove the herdr TUI plugin pier.workbench (pier ≤ 0.4.3,
 *   git tag tui-final); --remove-legacy / --keep-legacy answer up front, non-interactive runs keep it.
 * Failure semantics: Each step provides manual equivalent command; step failure does not abort reporting (exitCode=1).
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const EXT_DIR = join(ROOT, 'packages', 'pier-ext');
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

function readPkgJson(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

const readPkgVersion = (dir) => readPkgJson(dir)?.version ?? null;
const readPkgName = (dir) => readPkgJson(dir)?.name ?? null;

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
  if (!piVersion || !geVersion(piVersion, [1, 5, 0])) {
    die(`pi ≥ 1.5.0 required${piVersion ? `, found ${piVersion.join('.')}` : ' (pi not found or not runnable)'}. Install: npm i -g @earendil-works/pi-coding-agent`);
  }
  log(`✓ pi ${piVersion.join('.')}`);
  const hcVersion = (() => { try { return parseVersion(run('hc', ['--version'])); } catch { return null; } })();
  if (!hcVersion || !geVersion(hcVersion, [0, 1, 16])) {
    die(`herdr-core (hc) ≥ 0.1.16 required${hcVersion ? `, found ${hcVersion.join('.')}` : ' (hc not found or not runnable)'}. Install: curl -fsSL https://releases.herdr.dev/core/install.sh | sh`);
  }
  log(`✓ hc ${hcVersion.join('.')}`);
  log(which('herdr-app')
    ? 'ℹ herdr-app found (optional: it displays the core terminals)'
    : 'ℹ herdr-app not found (optional: install the Herdr app if you want to see the terminals)');
  return { piVersion, hcVersion };
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

/** A `packages` entry is a string spec or `{ source }`; local paths are relative to the agent dir. */
function packageSource(entry) {
  return typeof entry === 'string' ? entry : (typeof entry?.source === 'string' ? entry.source : null);
}

function localPackageDir(src) {
  if (/^(npm|git|https?|ssh):/.test(src)) return null;
  return resolve(piAgentDir(), src.startsWith('~/') ? join(homedir(), src.slice(2)) : src);
}

/** Registered sources that load pier's extension (npm, git, or a local checkout of pi-pier). */
function registeredPierSources() {
  return registeredPiPackages().map(packageSource).filter((src) => {
    if (!src) return false;
    if (npmNameFromSpec(src) === 'pi-pier' || /^git:.*july24\/pier/i.test(src)) return true;
    const dir = localPackageDir(src);
    return dir !== null && readPkgName(dir) === 'pi-pier';
  });
}

function sameSource(registered, target) {
  const dir = localPackageDir(registered);
  if (dir !== null) return localPackageDir(target) === dir;
  const name = npmNameFromSpec(registered);
  return name !== null ? npmNameFromSpec(target) === name : registered === target;
}

/** Human/CLI form of a registered source: local entries become absolute (`pi remove` takes them). */
function displaySource(src) {
  const dir = localPackageDir(src);
  return dir !== null ? dir : src;
}

/**
 * Before install/update: drop the legacy git-mode registration (unless it is the explicit target),
 * and refuse when pier is registered from any other source — two registrations load every pier
 * tool twice and pi rejects the duplicate at launch.
 */
function reconcilePierRegistrations() {
  for (const src of registeredPierSources()) {
    if (sameSource(src, piSource())) continue;
    if (src === LEGACY_GIT_SPEC) {
      if (tryRun('pi', ['remove', LEGACY_GIT_SPEC])) log(`✓ removed legacy git-mode registration (${LEGACY_GIT_SPEC}); using ${piSource()}`);
      else { console.error('✗ failed to remove legacy git-mode registration'); log(`  manual: pi remove ${LEGACY_GIT_SPEC}`); process.exitCode = 1; }
      continue;
    }
    const switchHint = localPackageDir(src) !== null && !dev ? ', or keep it and rerun with --dev'
      : dev && localPackageDir(src) === null ? ', or keep it and rerun without --dev' : '';
    die(`pier is already registered in pi from ${displaySource(src)}; adding ${piSource()} would load every pier tool twice.\n  Remove it first: pi remove ${displaySource(src)}${switchHint}`);
  }
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

/** Read-only `hc --version` probe for the status command (checkEnv dies on failure; this does not). */
function hcVersionString() {
  try {
    const v = parseVersion(run('hc', ['--version']));
    return v ? v.join('.') : null;
  } catch {
    return null;
  }
}

/* ── Legacy TUI-era pier (herdr plugin pier.workbench) ─────────────── */
// pier ≤ 0.4.3 (git tag `tui-final`) shipped a herdr TUI plugin next to the pi extension.
// The core-based pier no longer uses it; it keeps reacting to herdr TUI events if left behind.
const LEGACY_PLUGIN_ID = 'pier.workbench';

/** `{ local: boolean }` when herdr lists pier.workbench, else null (no herdr, no server, not installed). */
function legacyWorkbench() {
  if (!which('herdr')) return null;
  try {
    const plugins = JSON.parse(run('herdr', ['plugin', 'list', '--json'], { timeout: 15000 }))?.result?.plugins;
    if (Array.isArray(plugins)) {
      const p = plugins.find((x) => x?.plugin_id === LEGACY_PLUGIN_ID || x?.name === 'pier-workbench');
      return p ? { local: p.source?.kind === 'local' } : null;
    }
  } catch { /* older herdr: text listing below */ }
  try {
    const line = run('herdr', ['plugin', 'list'], { timeout: 15000 }).split(/\r?\n/).find((l) => l.includes(LEGACY_PLUGIN_ID));
    return line ? { local: line.includes('local:') } : null;
  } catch { return null; }
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); } finally { rl.close(); }
}

/** Offer to remove the TUI-era plugin. `--remove-legacy` / `--keep-legacy` skip the prompt; non-interactive runs keep it. */
async function offerLegacyRemoval() {
  const legacy = legacyWorkbench();
  if (!legacy) return;
  const [verb, what] = legacy.local ? ['unlink', 'unlinked (files kept)'] : ['uninstall', 'uninstalled'];
  const manual = `herdr plugin ${verb} ${LEGACY_PLUGIN_ID}`;
  log(`ℹ found the old herdr TUI plugin ${LEGACY_PLUGIN_ID} (pier ≤ 0.4.3); the herdr-core pier does not use it`);
  const remove = flags.has('--remove-legacy') ? true
    : flags.has('--keep-legacy') ? false
    : await confirm(`  remove it now (${manual})?`);
  if (!remove) { log(`  kept. Remove later: ${manual}`); return; }
  if (tryRun('herdr', ['plugin', verb, LEGACY_PLUGIN_ID])) log(`✓ ${LEGACY_PLUGIN_ID} ${what}; herdr itself is untouched`);
  else { console.error(`✗ failed to remove ${LEGACY_PLUGIN_ID}`); log(`  manual: ${manual}`); process.exitCode = 1; }
}

function collectStatus() {
  const installer = readPkgVersion(ROOT);
  // Report what pi actually loads, not the spec this run would install.
  const registered = registeredPierSources();
  const registeredDir = registered.map(localPackageDir).find((d) => d !== null);
  const extDir = dev
    ? (existsSync(EXT_PATH) ? EXT_DIR : null)
    : registeredDir ?? (() => { const p = resolveUserExtPath(); return p ? pkgDirFromExtPath(p) : null; })();
  const spec = registered.length > 0
    ? registered.map((src) => (localPackageDir(src) !== null ? `local:${localPackageDir(src)}` : src)).join(', ')
    : piSource();
  return {
    product: (extDir ? readPkgVersion(extDir) : null) || installer,
    mode: dev ? 'dev' : 'user',
    installer: { name: 'pier-setup', version: installer },
    piExt: { spec, version: extDir ? readPkgVersion(extDir) : null, path: extDir },
    core: { version: hcVersionString(), app: which('herdr-app') !== null },
    latest: { 'pier-setup': npmLatest('pier-setup'), 'pi-pier': npmLatest('pi-pier') },
  };
}

/* ── Commands ─────────────────────────────────────────────────────── */
function usage() {
  log(`pier-setup — install / update / inspect pier (pi-pier on herdr-core)

Usage:
  pier-setup [install] [--dev]
  pier-setup update    [--dev]
  pier-setup version   [--json]
  pier-setup uninstall [--dev]

  npx pier-setup@latest          # recommended user install
  npx pier-setup@latest update   # refresh the pi extension to the newest release
  npx pier-setup@latest version  # local vs npm latest

  --pi-spec= override the pi extension source
  --dev  local link (clone); the linked directory is live
  --remove-legacy / --keep-legacy  answer the "remove the old herdr TUI plugin
         pier.workbench?" prompt up front (non-interactive runs keep it)

  The last herdr TUI release is git tag tui-final (pier 0.4.3): npx pier-setup@0.4.3`);
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
  log(`  core        hc              ${s.core.version ?? 'not installed'}${s.core.app ? `    herdr-app found` : ''}`);
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

async function update() {
  checkEnv();
  reconcilePierRegistrations();
  await offerLegacyRemoval();
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
  }
  log('');
  version();
}

async function install() {
  checkEnv();
  reconcilePierRegistrations();
  await offerLegacyRemoval();

  if (dev) {
    if (tryRun('pi', ['install', piSource()])) log('✓ pi extension installed (packages/pier-ext, local)');
    else { console.error('✗ pi install failed'); log(`  manual: pi install ${EXT_DIR}`); process.exitCode = 1; }
  } else {
    if (tryRun('pi', ['install', piSource()])) log(`✓ pi extension installed (${PI_SPEC})`);
    else { console.error('✗ pi install failed'); log(`  manual: pi install ${PI_SPEC}`); process.exitCode = 1; }
  }

  log(`
pier installed (${dev ? 'dev mode: local path, code changes are live' : 'user mode: managed checkout'}). Next:
  1. start herdr-core and open a terminal (\`hc run\`, or the Herdr app's new-terminal action)
  2. run \`pi\` inside that terminal
  3. inside pi, ask the model to use todo_write / subagent tools`);
}

async function uninstall() {
  // Every registered pier source goes, not just piSource(): switching modes (local --dev → npm)
  // must leave pi clean, or the next install dies on the duplicate-registration guard.
  const targets = [...new Set([...registeredPierSources().map(displaySource), piSource()])];
  let removed = false;
  for (const src of targets) {
    if (tryRun('pi', ['remove', src])) { log(`✓ pi extension removed (${src})`); removed = true; }
    else { console.error(`✗ pi remove failed (${src})`); log(`  manual: pi remove ${src}`); process.exitCode = 1; }
  }
  if (!removed) log('ℹ no pier registration found in pi');
  await offerLegacyRemoval();
  log('\npier uninstalled. herdr-core and the Herdr app are independent and were left untouched.');
}

if (command === 'help' || flags.has('--help') || flags.has('-h')) usage();
else if (command === 'version' || flags.has('--version') || flags.has('-v')) version();
else if (command === 'uninstall') await uninstall();
else if (command === 'update') await update();
else await install();
