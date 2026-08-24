#!/usr/bin/env node
/**
 * herdr 插件事件钩子：pane.agent_status_changed → blocked 时发通知。
 *
 * 由 herdr 在事件发生时调用，注入 HERDR_PLUGIN_EVENT_JSON（事件 JSON）与
 * HERDR_SOCKET_PATH。本脚本只读事件、向 socket 发 notification.show。
 *
 * 说明：herdr 插件 v1 的 [[events]] 钩子按事件触发；本脚本保持极简
 * （一次性进程，无长驻资源）。
 */
import * as net from 'node:net';

const SOCKET = process.env.HERDR_SOCKET_PATH;
const rawEvent = process.env.HERDR_PLUGIN_EVENT_JSON;

if (!rawEvent) {
  process.exit(0); // 无事件载荷（link 校验/手工调用），静默退出
}

let event;
try {
  event = JSON.parse(rawEvent);
} catch {
  process.exit(0);
}

// 只关心 agent 状态迁移到 blocked（人类闸门信号）
if (event?.type !== 'pane.agent_status_changed') process.exit(0);
const data = event.data ?? {};
if (data.agent !== 'pi') process.exit(0); // 收紧闸：只对 pier 管的 pi subagent 发人类闸门通知
if (data.agent_status !== 'blocked') process.exit(0);

if (!SOCKET) process.exit(2);

const TARGET = process.platform === 'win32'
  ? (SOCKET.startsWith('\\\\.\\pipe\\') ? SOCKET : '\\\\.\\pipe\\' + SOCKET)
  : SOCKET;

const title = `Subagent blocked: ${data.agent ?? 'agent'}`;
const message = `Pane ${data.pane_id ?? '?'} needs a human decision${data.title ? ` — ${data.title}` : ''}`;

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(TARGET);
    sock.setEncoding('utf8');
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; sock.destroy(); reject(new Error('timeout')); } }, 5000);
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

request('notification.show', { title, message }).catch(() => process.exit(1));
