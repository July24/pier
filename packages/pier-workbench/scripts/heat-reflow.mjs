#!/usr/bin/env node
/**
 * Herdr hook (pane.created / pane.focused / pane.closed / pane.agent_status_changed): focus heat reflow.
 * Bypasses cordis — a user-mode plugin checkout has no node_modules.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { request as rpc } from './herdr-rpc.mjs';
import {
  askFlagsFromListResult,
  parseEventEnv,
  readJsonSafe,
  runReflow,
  writeJsonAtomic,
} from '../src/reflow.ts';

const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR
  || path.join(os.homedir(), '.pi', 'agent', 'herdr-pi');
const STATE_FILE = path.join(STATE_DIR, 'tab-layout.json');
const EMPTY_STATE = { tabs: {}, panes: {}, debounce: null };

/** Reflow RPCs run inside a hook process: keep the per-call budget at 8s. */
const request = (method, params = {}) => rpc(method, params, 8000);

const paneList = async () => (await request('pane.list', {}))?.panes ?? [];

async function main() {
  await runReflow({
    ev: parseEventEnv(),
    request,
    // F15: concurrent hook processes share this file — read tolerantly, write atomically.
    loadState: () => readJsonSafe(STATE_FILE, EMPTY_STATE),
    saveState: (state) => writeJsonAtomic(STATE_FILE, state),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    listAgentStatuses: async () => {
      try {
        const map = {};
        for (const p of await paneList()) if (p?.pane_id && p?.agent_status) map[p.pane_id] = p.agent_status;
        return map;
      } catch {
        return {};
      }
    },
    listAskFlags: async () => {
      try {
        const fromAgents = askFlagsFromListResult(await request('agent.list', {}));
        if (Object.keys(fromAgents).length > 0) return fromAgents;
      } catch { /* agent.list is optional */ }
      try {
        return askFlagsFromListResult({ panes: await paneList() });
      } catch {
        return {};
      }
    },
    piTabIds: async () => {
      const tabs = new Set();
      try {
        for (const p of await paneList()) if (p?.agent === 'pi' && p?.tab_id) tabs.add(p.tab_id);
      } catch { /* snapshot failure = empty set -> conservative no-op */ }
      return tabs;
    },
  });
}

main().catch(() => process.exit(1));
