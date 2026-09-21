#!/usr/bin/env node
/**
 * Herdr hook (workspace.created / worktree.opened): bootstrap the pier main tab (v1.3 M7, D28).
 *
 * workspace.create already ships a tab + root pane (the workspace_created envelope carries
 * workspace/tab/root_pane), so the hook does not create one. It only skips when the workspace already has
 * a pi master pane (agent=pi or a ▶/⏳ title prefix), injects the pi launch command into the root pane via
 * pane.send_text + CR, renames the tab, and appends a boot.jsonl record for the [[startup]] restore hook.
 * Failures degrade to logs + non-zero exit; hook errors never reach the herdr server.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootFilePath, deepFind, launchCommand, masterArgv, readBootConfig, request } from './herdr-rpc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOOT_FILE = bootFilePath();

const config = readBootConfig(here);
if (!config) {
  console.error('[bootstrap] no boot-config.json in HERDR_PLUGIN_CONFIG_DIR or scripts/');
  process.exit(0);
}

async function main() {
  // Scenario B isolation: autoBootstrap=false leaves new workspaces untouched (running other agents in herdr).
  if (config.autoBootstrap === false) {
    console.log('[bootstrap] autoBootstrap disabled; skip');
    process.exit(0);
  }

  let event = {};
  try { event = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? '{}'); } catch { /* empty payload */ }
  const wsId = event?.workspace?.workspace_id ?? deepFind(event, 'workspace_id') ?? '';
  if (!wsId) {
    console.error('[bootstrap] no workspace_id in event payload');
    process.exit(0);
  }

  const panes = (await request('pane.list', {})).panes ?? [];
  const wsPanes = panes.filter((p) => p.workspace_id === wsId);
  // D91 icon transition: ▶ prefixes new sessions, ⏳ legacy ones — both count as an existing master.
  if (wsPanes.some((p) => p.agent === 'pi' || (typeof p.title === 'string' && /⏳|▶/.test(p.title)))) {
    console.log(`[bootstrap] workspace ${wsId} already has a master pi; skip`);
    process.exit(0);
  }

  const rootPaneId = event?.root_pane?.pane_id ?? deepFind(event, 'pane_id') ?? '';
  const target = wsPanes.find((p) => p.pane_id === rootPaneId) ?? wsPanes[0];
  if (!target) {
    console.error('[bootstrap] workspace has no pane to launch into');
    process.exit(0);
  }

  // Tier 1 hmr dev stance (d87): --expose-internals + PI_HERDR_HMR=1 are both required, else zero watchers.
  const argv = masterArgv(config);
  if (config.hmrDev === true) argv.splice(1, 0, '--expose-internals');
  const cli = launchCommand(argv);
  const launch = config.hmrDev === true
    ? (process.platform === 'win32' ? `$env:PI_HERDR_HMR='1'; ${cli}` : `PI_HERDR_HMR=1 ${cli}`)
    : cli;
  await request('pane.send_text', { pane_id: target.pane_id, text: launch + '\r' });

  const tabId = event?.tab?.tab_id ?? deepFind(event, 'tab_id') ?? target.tab_id ?? '';
  if (tabId && config.mainTabLabel) {
    try {
      await request('tab.rename', { tab_id: tabId, label: config.mainTabLabel });
    } catch (e) {
      console.error('[bootstrap] rename failed: ' + e.message);
    }
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
