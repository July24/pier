#!/usr/bin/env node
/** Herdr hook (pane.created / pane.focused / pane.closed / pane.agent_status_changed): focus heat reflow.
 * Bypasses cordis — a user-mode plugin checkout has no node_modules. */
import * as os from 'node:os';
import * as path from 'node:path';
import { request as rpc } from './herdr-rpc.mjs';
import { loadSrc } from './load-src.mjs';

const {
  parseEventEnv,
  readJsonSafe,
  reflowSnapshot,
  runReflow,
  writeJsonAtomic,
} = await loadSrc('reflow');

const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR
  || path.join(os.homedir(), '.pi', 'agent', 'herdr-pi');
const STATE_FILE = path.join(STATE_DIR, 'tab-layout.json');
const EMPTY_STATE = { tabs: {}, panes: {}, debounce: null };

/** Reflow RPCs run inside a hook process: keep the per-call budget at 8s. */
const request = (method, params = {}) => rpc(method, params, 8000);

async function main() {
  await runReflow({
    ev: parseEventEnv(),
    request,
    // F15: concurrent hook processes share this file — read tolerantly, write atomically.
    loadState: () => readJsonSafe(STATE_FILE, EMPTY_STATE),
    saveState: (state) => writeJsonAtomic(STATE_FILE, state),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    // One session.snapshot covers statuses + ask flags + pi-tab membership (herdr serves one
    // request per socket connection, so this replaces the old pane.list x2 + agent.list preamble).
    loadSnapshot: async () => reflowSnapshot(await request('session.snapshot', {})),
  });
}

main().catch(() => process.exit(1));
