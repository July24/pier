#!/usr/bin/env node
/**
 * Pier Ops Dashboard entrypoint: a herdr plugin pane (or CLI tool with --once).
 * Fetches session.snapshot over the herdr socket and renders an auto-refreshing dashboard.
 */
import { request } from './herdr-rpc.mjs';
import { composeDashboardLines } from '../src/dashboard-model.ts';

const onceMode = process.argv.includes('--once');

if (!process.env.HERDR_SOCKET_PATH) {
  console.log(
    [
      '==================== PIER OPS DASHBOARD ==================== (standalone)',
      'No HERDR_SOCKET_PATH — offline. Inside Herdr 0.9.1, /dashboard opens the modal popup.',
      '================================================================================',
    ].join('\n'),
  );
  process.exit(0);
}

let targetWorkspaceId = null;
if (process.env.HERDR_PLUGIN_CONTEXT_JSON) {
  try {
    targetWorkspaceId = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON)?.workspace_id ?? null;
  } catch {
    // Invalid context JSON: fall back to the focused workspace.
  }
}

async function render() {
  // A failing/absent socket renders the offline dashboard instead of throwing.
  const snapshot = await request('session.snapshot', {}, 3000).catch(() => null);
  return composeDashboardLines(snapshot, { targetWorkspaceId });
}

async function renderOnce() {
  console.log((await render()).join('\n'));
}

async function closePopupSafe() {
  try {
    await request('popup.close', {}, 1000);
  } catch {
    // Best effort, ignore if not a popup
  }
}

async function runLoop() {
  let running = true;
  const cleanup = async () => {
    if (!running) return;
    running = false;
    await closePopupSafe();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Raw keyboard handling when running inside an interactive terminal / popup: q, Q, Esc, Ctrl+C.
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (key) => {
        if (key === 'q' || key === 'Q' || key === '\u001b' || key === '\u0003') void cleanup();
      });
    } catch {
      // Non-critical fallback if raw mode fails
    }
  }

  async function tick() {
    if (!running) return;
    const lines = await render();
    lines.push('Controls: [q / Esc] Close  [Ctrl+C] Exit');
    process.stdout.write('\x1b[2J\x1b[H' + lines.join('\n') + '\n');
  }

  await tick();
  const interval = setInterval(tick, 3000);
  interval.unref?.();
}

if (onceMode) {
  renderOnce().then(() => process.exit(0)).catch(() => process.exit(0));
} else {
  runLoop().catch(() => process.exit(0));
}
