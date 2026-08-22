#!/usr/bin/env node
/**
 * v1.3 M7 布局恢复（D28）：herdr 插件 [[startup]] 钩子（会话恢复 + socket 就绪后跑一次）。
 * 读 HERDR_PLUGIN_STATE_DIR/boot.jsonl（bootstrap 追加的引导记录），对每条：
 *  - tab 已消失 → workspace 还活着就 layout.apply 重建 main tab（cwd 来自记录）；
 *  - tab 在、pane 没了 → focus+split 新 pane 重灌启动命令；
 *  - pane 在且已是 pi → 跳过；pane 在但被重置（非 pi）→ 重灌启动命令。
 * one-shot：跑完退出（herdr 官方 startup 语义：不是守护进程）。
 */
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const SOCKET = process.env.HERDR_SOCKET_PATH;
const here = path.dirname(fileURLToPath(import.meta.url));
// 与 bootstrap 同约定：~/.pi/agent/herdr-pi/boot.jsonl（实测 HERDR_PLUGIN_STATE_DIR 未注入）。
const BOOT_FILE = path.join(os.homedir(), '.pi', 'agent', 'herdr-pi', 'boot.jsonl');

let config = null;
try {
  config = JSON.parse(fs.readFileSync(path.join(here, 'boot-config.json'), 'utf8'));
} catch {
  console.error('[restore-layout] boot-config.json missing/broken');
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

function readBootRecords() {
  try {
    if (!fs.existsSync(BOOT_FILE)) return [];
    return fs.readFileSync(BOOT_FILE, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && typeof r.workspace_id === 'string');
  } catch {
    return [];
  }
}

/** 深度优先找第一个字符串字段（herdr 信封形状多样，id 位置不一；取代 JSON 正则）。 */
function deepFindId(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  if (typeof obj[key] === 'string') return obj[key];
  for (const v of Object.values(obj)) {
    const r = deepFindId(v, key, depth + 1);
    if (r) return r;
  }
  return null;
}

async function relaunchInPane(paneId) {
  const launch = `& '${config.piNode}' '${config.piCli}' -e '${config.extPath}'`;
  await request('pane.send_text', { pane_id: paneId, text: launch + '\r' });
}

async function main() {
  const records = readBootRecords();
  console.log(`[restore-layout] ${records.length} boot record(s)`);
  const panes = (await request('pane.list', {})).panes ?? [];

  for (const rec of records) {
    const wsPanes = panes.filter((p) => p.workspace_id === rec.workspace_id);
    let tab = null;
    try { tab = (await request('tab.get', { tab_id: rec.tab_id }))?.tab ?? null; } catch { /* tab 没了 */ }

    if (!tab) {
      // 主 tab 消失：workspace 还活着就重建（关最后一个 tab 会连 workspace 一起关，故仅剩重建路径）
      let ws = null;
      try { ws = (await request('workspace.get', { workspace_id: rec.workspace_id }))?.workspace ?? null; } catch { /* ws 没了 */ }
      if (!ws) { console.log(`[restore-layout] ws ${rec.workspace_id} gone; skip`); continue; }
      const cwd = rec.cwd || process.cwd();
      let created = null;
      try {
        created = await request('layout.apply', {
          tab_label: config.mainTabLabel,
          root: { type: 'pane', command: [config.piNode, config.piCli, '-e', config.extPath], cwd },
        });
      } catch (e) {
        console.error(`[restore-layout] rebuild failed: ${e.message}`);
        continue;
      }
      console.log(`[restore-layout] ws ${rec.workspace_id}: main tab rebuilt`);
      continue;
    }

    const paneAlive = wsPanes.some((p) => p.pane_id === rec.pane_id);
    if (!paneAlive) {
      // tab 在、pane 没了 → 新 pane 重灌
      const anchor = wsPanes.find((p) => p.tab_id === rec.tab_id);
      if (!anchor) continue;
      try {
        await request('pane.focus', { pane_id: anchor.pane_id });
        const split = await request('pane.split', { direction: 'right', cwd: rec.cwd || undefined });
        const paneId = deepFindId(split, 'pane_id') ?? '';
        if (paneId) await relaunchInPane(paneId);
        console.log(`[restore-layout] ws ${rec.workspace_id}: master pane relaunched (${paneId})`);
      } catch (e) {
        console.error(`[restore-layout] pane rebuild failed: ${e.message}`);
      }
      continue;
    }

    // pane 活着：没跑 pi（被重置成 shell）→ 重灌
    const p = wsPanes.find((x) => x.pane_id === rec.pane_id);
    const isPi = p?.agent === 'pi' || (typeof p?.title === 'string' && /⏳|▶/.test(p.title));
    if (!isPi) {
      try { await relaunchInPane(rec.pane_id); console.log(`[restore-layout] ws ${rec.workspace_id}: pane ${rec.pane_id} relaunched`); }
      catch (e) { console.error(`[restore-layout] relaunch failed: ${e.message}`); }
    } else {
      console.log(`[restore-layout] ws ${rec.workspace_id}: main pane healthy; skip`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error('[restore-layout] ' + e.message); process.exit(1); });
