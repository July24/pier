#!/usr/bin/env node
/**
 * pier 一键安装/卸载/更新/查版本（跨平台：macOS / Linux / Windows）。
 *
 * 用法：
 *   node install.mjs install  [--dev] [--hmr-dev] [--force]   # 安装（默认命令，可省略 install）
 *   node install.mjs update   [--dev] [--hmr-dev]             # 原地刷新两半区到最新发行（不先卸载）
 *   node install.mjs version  [--json]                        # 本地 vs npm latest
 *   node install.mjs uninstall [--dev] [--purge]              # 卸载；--purge 连 boot-config.json 一起删
 *   node install.mjs --prepare                                # npm prepare：hooksPath + 仓库根 bin 链接
 *   node install.mjs --help
 *
 * 模式：
 *   用户模式（默认）：pi install npm:pi-pier
 *                   + herdr plugin install July24/pier/packages/pier-workbench --yes
 *                   boot-config.json 写 herdr plugin config-dir；extPath 指向 pi 已安装的
 *                   pi-pier（~/.pi/agent/npm/...），不是 pier-setup 包内的仓库路径。
 *   --dev 开发模式：pi install <repo>/packages/pier-ext + herdr plugin link <repo>/packages/pier-workbench
 *                   （link 目录是活的，改码即生效；update 只重写 boot-config）。
 * 发行规格可用 --pi-spec= / --herdr-spec= 覆盖（npm 发布或 fork 场景）。
 * 失败语义：每步给出手动等价命令；步骤失败不阻断报告（exitCode=1）。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const EXT_DIR = join(ROOT, 'packages', 'pier-ext');
const WB_DIR = join(ROOT, 'packages', 'pier-workbench');
const DEV_BOOT_CONFIG = join(WB_DIR, 'scripts', 'boot-config.json');
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
const PI_SPEC = optValue('pi-spec') ?? 'npm:pi-pier';   // 用户模式默认 npm 发行版；--pi-spec=git:github.com/July24/pier 可跟随仓库 main
const HERDR_SPEC = optValue('herdr-spec') ?? 'July24/pier/packages/pier-workbench';

const log = (m) => console.log(m);
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };

/* ── 工具函数 ────────────────────────────────────────────────────── */
function which(bin) {
  try {
    const out = execFileSync(IS_WIN ? 'where' : 'which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // where 可能多行（PATH 逐条命中），取第一条存在的
    for (const line of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (existsSync(line)) return line;
    }
    return null;
  } catch {
    return null;
  }
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
    return execFileSync('npm', ['view', name, 'version'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
    }).trim();
  } catch {
    return null;
  }
}

/** herdr 插件配置目录（用户模式 boot-config 落点；插件已注册才存在路径语义）。 */
function herdrConfigDir() {
  try { return run('herdr', ['plugin', 'config-dir', 'pier.workbench']); } catch { return null; }
}

/* ── 环境校验（install 前置） ────────────────────────────────────── */
function checkEnv() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 22) die(`node ≥ 22 required, found ${process.versions.node}`);
  log(`✓ node ${process.versions.node}`);
  const piVersion = (() => { try { return parseVersion(run('pi', ['--version'])); } catch { return null; } })();
  if (!piVersion || !geVersion(piVersion, [0, 84, 0])) {
    die(`pi ≥ 0.84 required${piVersion ? `, found ${piVersion.join('.')}` : ' (pi not found or not runnable)'}. Install: npm i -g @earendil-works/pi-coding-agent`);
  }
  log(`✓ pi ${piVersion.join('.')}`);
  const herdrVersion = (() => { try { return parseVersion(run('herdr', ['--version'])); } catch { return null; } })();
  if (!herdrVersion || !geVersion(herdrVersion, [0, 8, 0])) {
    die(`herdr ≥ 0.8.0 required${herdrVersion ? `, found ${herdrVersion.join('.')}` : ' (herdr not found)'}. Install: https://herdr.dev/`);
  }
  log(`✓ herdr ${herdrVersion.join('.')}`);
  return { piVersion, herdrVersion };
}

/** pi 半区源：用户模式 git 规格，dev 模式本地目录。 */
const piSource = () => (dev ? EXT_DIR : PI_SPEC);

/* ── boot-config 探测与写入 ──────────────────────────────────────── */
function probePiRuntime() {
  const piBin = which('pi');
  // bin 是 node shim：realpath 落到 .../pi-coding-agent/dist/cli.js（npm 布局，win/posix 同构）
  if (piBin) {
    try {
      const real = realpathSync(piBin);
      if (real.endsWith('cli.js') && existsSync(real)) {
        return { piCli: real, piNode: process.execPath };
      }
    } catch { /* 落到兜底 */ }
  }
  // npm root -g 兜底：pi 不在 PATH（nvm shim 等）时按全局布局拼
  try {
    const gRoot = run('npm', ['root', '-g']);
    const cand = join(gRoot, '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
    if (existsSync(cand)) return { piCli: cand, piNode: process.execPath };
  } catch { /* npm 不可用 */ }
  return null;
}

function piAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
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

function writeBootConfig(hmrDev, force) {
  const probed = probePiRuntime();
  if (!probed) die('cannot locate pi cli.js (tried: pi shim realpath, npm root -g). Fill boot-config.json manually.');
  let extPath;
  if (dev) {
    if (!existsSync(EXT_PATH)) die(`pier-ext entry missing: ${EXT_PATH} (repo layout broken?)`);
    extPath = EXT_PATH;
  } else {
    extPath = resolveUserExtPath();
    if (!extPath) die(`cannot locate installed pier-ext (npm:pi-pier / git clone). Did \`pi install ${piSource()}\` succeed?`);
  }

  const config = {
    mainTabLabel: 'main',
    piNode: probed.piNode,
    piCli: probed.piCli,
    extPath,
    workbenchPluginId: 'pier.workbench',
    hmrDev,
  };

  const target = dev ? DEV_BOOT_CONFIG : join(herdrConfigDir() ?? die('cannot resolve herdr plugin config-dir (is pier.workbench installed?)'), 'boot-config.json');
  if (existsSync(target) && !force) {
    let existing = null;
    try { existing = JSON.parse(readFileSync(target, 'utf8')); } catch { /* 视为损坏 */ }
    if (existing) {
      log(`• ${target} exists, diff (existing → new):`);
      for (const k of Object.keys(config)) {
        if (existing[k] !== config[k]) log(`    ${k}: ${JSON.stringify(existing[k])} → ${JSON.stringify(config[k])}`);
      }
      log('  kept existing (use --force to overwrite)');
      return;
    }
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(config, null, 2) + '\n');
  log(`✓ boot-config.json ${force ? 'overwritten (--force)' : 'written'} → ${target}`);
  log(`  piNode = ${config.piNode}`);
  log(`  piCli  = ${config.piCli}`);
  log(`  extPath = ${config.extPath}`);
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

/* ── 命令 ────────────────────────────────────────────────────────── */
function usage() {
  log(`pier-setup — install / update / inspect pier (pi-pier + pier.workbench)

Usage:
  pier-setup [install] [--dev] [--hmr-dev] [--force]
  pier-setup update    [--dev] [--hmr-dev]
  pier-setup version   [--json]
  pier-setup uninstall [--dev] [--purge]

  npx pier-setup@latest          # recommended user install
  npx pier-setup@latest update   # refresh both halves to newest release
  npx pier-setup@latest version  # local vs npm latest

  --pi-spec= / --herdr-spec= override distribution sources
  --dev  local link (clone); update only rewrites boot-config`);
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
  const me = readPkgVersion(ROOT);
  const latestSetup = npmLatest('pier-setup');
  if (latestSetup && me && cmpSemver(me, latestSetup) < 0) {
    log(`⚠ installer ${me} < latest ${latestSetup} — re-run: npx pier-setup@latest update`);
  }
  const hmrDev = flags.has('--hmr-dev');
  if (dev) {
    log('dev mode: local link is live; pull the repo yourself. Refreshing boot-config only.');
    writeBootConfig(hmrDev, true);
  } else {
    if (tryRun('pi', ['update', piSource()])) log(`✓ pi extension updated (${piSource()})`);
    else if (tryRun('pi', ['install', piSource()])) log(`✓ pi extension installed (${piSource()})`);
    else { console.error('✗ pi update/install failed'); log(`  manual: pi update ${piSource()}`); process.exitCode = 1; }
    if (tryRun('herdr', ['plugin', 'install', HERDR_SPEC, '--yes'])) log(`✓ herdr plugin updated (${HERDR_SPEC})`);
    else { console.error('✗ herdr plugin update failed'); log(`  manual: herdr plugin install ${HERDR_SPEC} --yes`); process.exitCode = 1; }
    writeBootConfig(hmrDev, true);
  }
  log('');
  version();
}

function install() {
  const hmrDev = flags.has('--hmr-dev');
  const force = flags.has('--force');
  checkEnv();

  if (dev) {
    if (tryRun('pi', ['install', piSource()])) log('✓ pi extension installed (packages/pier-ext, local)');
    else { console.error('✗ pi install failed'); log(`  manual: pi install ${EXT_DIR}`); process.exitCode = 1; }
    if (tryRun('herdr', ['plugin', 'link', WB_DIR])) log('✓ herdr plugin linked (packages/pier-workbench, local)');
    else { console.error('✗ herdr plugin link failed'); log(`  manual: herdr plugin link ${WB_DIR}`); process.exitCode = 1; }
    writeBootConfig(hmrDev, force);
  } else {
    if (tryRun('pi', ['install', piSource()])) log(`✓ pi extension installed (${PI_SPEC})`);
    else { console.error('✗ pi install failed'); log(`  manual: pi install ${PI_SPEC}`); process.exitCode = 1; }
    if (tryRun('herdr', ['plugin', 'install', HERDR_SPEC, '--yes'])) log(`✓ herdr plugin installed (${HERDR_SPEC})`);
    else { console.error('✗ herdr plugin install failed'); log(`  manual: herdr plugin install ${HERDR_SPEC}`); process.exitCode = 1; }
    writeBootConfig(hmrDev, force);
  }

  log(`
pier installed (${dev ? 'dev mode: local paths, code changes are live' : 'user mode: managed checkouts'}). Next:
  1. start herdr, open/create a workspace — the main tab auto-bootstraps a pi session
  2. inside pi, ask the model to use todo_write / subagent tools`);
}

function uninstall() {
  const purge = flags.has('--purge');
  if (tryRun('pi', ['remove', piSource()])) log('✓ pi extension removed');
  else { console.error('✗ pi remove failed'); log(`  manual: pi remove ${piSource()}`); process.exitCode = 1; }

  if (dev) {
    if (tryRun('herdr', ['plugin', 'unlink', 'pier.workbench'])) log('✓ herdr plugin unlinked (files kept)');
    else { console.error('✗ herdr plugin unlink failed'); log('  manual: herdr plugin unlink pier.workbench'); process.exitCode = 1; }
    if (purge && existsSync(DEV_BOOT_CONFIG)) { rmSync(DEV_BOOT_CONFIG); log('✓ dev boot-config.json purged'); }
  } else {
    if (tryRun('herdr', ['plugin', 'uninstall', 'pier.workbench'])) log('✓ herdr plugin uninstalled (managed checkout removed)');
    else { console.error('✗ herdr plugin uninstall failed'); log('  manual: herdr plugin uninstall pier.workbench'); process.exitCode = 1; }
    if (purge) {
      const dir = herdrConfigDir();
      const f = dir ? join(dir, 'boot-config.json') : null;
      if (f && existsSync(f)) { rmSync(f); log('✓ boot-config.json purged'); }
    }
  }
  log(`\npier uninstalled.${purge ? '' : ' (boot-config.json kept; use --purge to remove)'}`);
}

if (command === 'help' || flags.has('--help') || flags.has('-h')) usage();
else if (command === 'version' || flags.has('--version') || flags.has('-v')) version();
else if (command === 'uninstall') uninstall();
else if (command === 'update') update();
else install();
