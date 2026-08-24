#!/usr/bin/env node
/**
 * M23 档 1：pane.focused / pane.created → 焦点热力 reflow。
 * 档1 收尾：宿主瘦身——env/socket/状态文件（进程边界）留宿主，
 * 域逻辑在 ../src/reflow.ts（cordis 插件，经第二棵树挂载）。
 */
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createWorkbenchApp } from '../src/app.ts';
import reflowPlugin, { parseEventEnv } from '../src/reflow.ts';

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
  const app = await createWorkbenchApp();
  try {
    app.root.provide('workbench.deps', {
      ev,
      request,
      loadState,
      saveState,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      // 档2 语义桥：事件时拉一次 agent 状态快照（D3 合规——事件驱动非轮询）
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
      // 收紧闸（场景 B 隔离）：含 pi pane 的 tab 集合——非 pi tab（claude code /
      // codex / 纯 shell 的 tab）不 reflow，pier 只管 pi 工作台自己的 tab。
      piTabIds: async () => {
        const tabs = new Set();
        try {
          const result = await request('pane.list', {});
          for (const p of result?.panes ?? []) if (p?.agent === 'pi' && p?.tab_id) tabs.add(p.tab_id);
        } catch { /* 快照失败 = 空集合 → 保守不动 */ }
        return tabs;
      },
    });
    await app.root.plugin(reflowPlugin);
  } finally {
    await app.root.fiber.dispose();
  }
}

main().catch(() => process.exit(1));
