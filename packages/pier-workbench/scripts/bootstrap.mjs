#!/usr/bin/env node
/**
 * v1.3 M7 主 tab 引导（D28）：herdr 插件 [[events]] workspace.created / worktree.opened 钩子。
 *
 * 触发时 workspace.create 已自带一个 tab + root pane（实测 schema：workspace_created
 * 信封含 workspace/tab/root_pane）——引导不是新建 tab，而是：
 *   1. 幂等判定：该 workspace 已有 pi 主控 pane（agent=pi 或 title 含 ⏳）→ 跳过；
 *   2. 在 root pane（或该 workspace 首个 pane）注入 pi 启动命令（pane.send_text + CR，
 *      与子 pane 通道同款，实测可直达 stdin）；
 *   3. tab.rename → mainTabLabel；
 *   4. 引导记录追加到 HERDR_PLUGIN_STATE_DIR/boot.jsonl（[[startup]] 恢复用）。
 * M22：不再开 todo-board；不再自动补常驻 pane。
 * 失败全部降级为日志 + 非零退出；事件钩子错误不影响 herdr server。
 */
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const SOCKET = process.env.HERDR_SOCKET_PATH;
const here = path.dirname(fileURLToPath(import.meta.url));
// v1.3 M7 实测：herdr 未注入 HERDR_PLUGIN_STATE_DIR（连目录都没有）→
// 引导记录与历史记录同约定，落 ~/.pi/agent/herdr-pi/boot.jsonl（插件/扩展两侧同读）。
const BOOT_FILE = path.join(os.homedir(), '.pi', 'agent', 'herdr-pi', 'boot.jsonl');

// 配置解析：用户模式（plugin install）配置在 HERDR_PLUGIN_CONFIG_DIR（herdr 管理的
// checkout 会被 reinstall 替换，配置不能落在插件目录里）；dev 模式（link）回退
// scripts/boot-config.json（本仓库内，模板 .example.json）。
function readBootConfig(here) {
  const candidates = [
    process.env.HERDR_PLUGIN_CONFIG_DIR ? path.join(process.env.HERDR_PLUGIN_CONFIG_DIR, 'boot-config.json') : null,
    path.join(here, 'boot-config.json'),
  ].filter(Boolean);
  for (const f of candidates) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* 下一处 */ }
  }
  return null;
}

let config = null;
try {
  config = readBootConfig(here);
  if (!config) throw new Error('no boot-config.json in HERDR_PLUGIN_CONFIG_DIR or scripts/');
} catch (e) {
  console.error('[bootstrap] ' + e.message);
  process.exit(0);
}

const TARGET = process.platform === 'win32' && SOCKET
  ? (SOCKET.startsWith('\\\\.\\pipe\\') ? SOCKET : '\\\\.\\pipe\\' + SOCKET)
  : SOCKET;

function request(method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(TARGET);
    sock.setEncoding('utf8');
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; sock.destroy(); reject(new Error(method + ' timeout')); } }, timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ id: '1', method, params }) + '\n'));
    sock.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      sock.destroy();
      let msg;
      try { msg = JSON.parse(buf.slice(0, i).trim()); } catch { return reject(new Error('bad frame')); }
      msg.error ? reject(new Error(`${msg.error.code}: ${msg.error.message}`)) : resolve(msg.result);
    });
    sock.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
  });
}

function deepFindFirst(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  if (typeof obj[key] === 'string') return obj[key];
  for (const v of Object.values(obj)) {
    const r = deepFindFirst(v, key, depth + 1);
    if (r) return r;
  }
  return null;
}

async function main() {
  // 收紧闸（场景 B 隔离）：autoBootstrap=false 时新 workspace 不自动注入 pi
  //（用户想在 herdr 里跑其他 agent 时关掉本开关即可；默认 true = 产品行为不变）。
  if (config.autoBootstrap === false) {
    console.log('[bootstrap] autoBootstrap disabled; skip');
    process.exit(0);
  }
  let event = {};
  try { event = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? '{}'); } catch { /* 留空 */ }
  const wsId = event?.workspace?.workspace_id ?? deepFindFirst(event, 'workspace_id') ?? '';
  if (!wsId) {
    console.error('[bootstrap] no workspace_id in event payload');
    process.exit(0);
  }
  const panes = (await request('pane.list', {})).panes ?? [];
  const wsPanes = panes.filter((p) => p.workspace_id === wsId);
  // D91 图标换代表：新 title 头 ▶…，旧会话 ⏳…（双匹配保幂等）
  const hasMaster = wsPanes.some((p) => p.agent === 'pi' || (typeof p.title === 'string' && /⏳|▶/.test(p.title)));
  if (hasMaster) {
    console.log(`[bootstrap] workspace ${wsId} already has a master pi; skip`);
    process.exit(0);
  }

  const rootPaneId = event?.root_pane?.pane_id ?? deepFindFirst(event, 'pane_id') ?? '';
  const target = wsPanes.find((p) => p.pane_id === rootPaneId) ?? wsPanes[0];
  if (!target) {
    console.error('[bootstrap] workspace has no pane to launch into');
    process.exit(0);
  }

  // 档1 hmr 开发姿态（d87）：hmrDev=true 时 master 启动线带 --expose-internals +
  // PI_HERDR_HMR=1（双闸；bootstrap.ts 缺一即零 watcher）。默认 false = 生产姿态不变。
  // 启动行按平台出 shell 语法：win32=PowerShell（& + '' 转义 + $env:），POSIX=sh（'\'' 转义 + env 前缀）。
  const hmrDev = config.hmrDev === true;
  const cliParts = [config.piNode, config.piCli];
  if (hmrDev) cliParts.splice(1, 0, '--expose-internals');
  // D97：master 也 fullscreen（窄格静帧前提）；PI_HERDR_TUI=regular 逃生
  if (process.env.PI_HERDR_TUI !== 'regular') cliParts.push('--tui-mode', 'fullscreen');
  cliParts.push('-e', config.extPath);
  const quote = (s) => (process.platform === 'win32' ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, `'\\''`)}'`);
  const cli = (process.platform === 'win32' ? '& ' : '') + cliParts.map(quote).join(' ');
  const launch = hmrDev
    ? (process.platform === 'win32' ? `$env:PI_HERDR_HMR='1'; ${cli}` : `PI_HERDR_HMR=1 ${cli}`)
    : cli;
  await request('pane.send_text', { pane_id: target.pane_id, text: launch + '\r' });

  const tabId = event?.tab?.tab_id ?? deepFindFirst(event, 'tab_id') ?? target.tab_id ?? '';
  if (tabId && config.mainTabLabel) {
    try { await request('tab.rename', { tab_id: tabId, label: config.mainTabLabel }); } catch (e) { console.error('[bootstrap] rename failed: ' + e.message); }
  }

  try {
    fs.mkdirSync(path.dirname(BOOT_FILE), { recursive: true });
    fs.appendFileSync(BOOT_FILE,
      JSON.stringify({ workspace_id: wsId, tab_id: tabId, pane_id: target.pane_id, cwd: target.cwd ?? '', ts: Date.now() }) + '\n');
  } catch (e) {
    console.error('[bootstrap] boot record write failed: ' + e.message);
  }
  console.log(`[bootstrap] main tab ready: ws=${wsId} tab=${tabId} pane=${target.pane_id}`);
  process.exit(0);
}

main().catch((e) => { console.error('[bootstrap] ' + e.message); process.exit(1); });
