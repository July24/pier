#!/usr/bin/env node
/**
 * M23：pane.focused / created / closed / agent_status_changed → 焦点热力 reflow。
 * 不经 cordis：user-mode plugin checkout 没有 @deepseek-ai/cordis。
 */
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseEventEnv, runReflow } from '../src/reflow.ts';

const SOCKET = process.env.HERDR_SOCKET_PATH;
const TARGET = process.platform === 'win32' && SOCKET
  ? (SOCKET.startsWith('\\\\.\\pipe\\') ? SOCKET : '\\\\.\\pipe\\' + SOCKET)
  : SOCKET;

const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR
  || path.join(os.homedir(), '.pi', 'agent', 'herdr-pi');
const STATE_FILE = path.join(STATE_DIR, 'tab-layout.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { tabs: {}, panes: {}, debounce: null };
  }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

function request(method, params = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!TARGET) return reject(new Error('no socket'));
    const sock = net.createConnection(TARGET);
    sock.setEncoding('utf8');
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        sock.destroy();
        reject(new Error(method + ' timeout'));
      }
    }, timeoutMs);
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
    sock.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

function parseEvent() {
  return parseEventEnv();
}

async function main() {
  const ev = parseEvent();
  await runReflow({
    ev,
    request,
    loadState,
    saveState,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    listAgentStatuses: async () => {
      try {
        const result = await request('pane.list', {});
        const panes = result?.panes ?? [];
        const map = {};
        for (const p of panes) if (p?.pane_id && p?.agent_status) map[p.pane_id] = p.agent_status;
        return map;
      } catch {
        return {};
      }
    },
    piTabIds: async () => {
      const tabs = new Set();
      try {
        const result = await request('pane.list', {});
        for (const p of result?.panes ?? []) if (p?.agent === 'pi' && p?.tab_id) tabs.add(p.tab_id);
      } catch { /* 快照失败 = 空集合 → 保守不动 */ }
      return tabs;
    },
  });
}

main().catch(() => process.exit(1));
