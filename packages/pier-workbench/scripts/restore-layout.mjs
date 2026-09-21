#!/usr/bin/env node
/**
 * Herdr [[startup]] hook (v1.3 M7, D28): replay the bootstrapped war-room layout after a session restore.
 *
 * For every boot record (newest per workspace, F05): rebuild the main tab via layout.apply when the tab is
 * gone, split + re-inject when the pane is gone, re-inject when the pane survived as a plain shell, skip
 * when a pi master is still alive. One-shot — herdr startup hooks are not daemons.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootFilePath, deepFind, launchCommand, masterArgv, readBootConfig, request } from './herdr-rpc.mjs';
import { latestBootRecordPerWorkspace, parseBootRecords } from '../src/restore-plan.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOOT_FILE = bootFilePath();

const config = readBootConfig(here);
if (!config) {
  console.error('[restore-layout] no boot-config.json in HERDR_PLUGIN_CONFIG_DIR or scripts/');
  process.exit(0);
}

/** F05: boot.jsonl is append-only -> newest record per workspace, so restore never rebuilds a tab twice. */
function readBootRecords() {
  try {
    return latestBootRecordPerWorkspace(parseBootRecords(fs.readFileSync(BOOT_FILE, 'utf8')));
  } catch {
    return [];
  }
}

async function relaunchInPane(paneId) {
  await request('pane.send_text', { pane_id: paneId, text: launchCommand(masterArgv(config)) + '\r' });
}

async function main() {
  const records = readBootRecords();
  console.log(`[restore-layout] ${records.length} boot record(s)`);
  const panes = (await request('pane.list', {})).panes ?? [];

  for (const rec of records) {
    const wsPanes = panes.filter((p) => p.workspace_id === rec.workspace_id);
    let tab = null;
    try { tab = (await request('tab.get', { tab_id: rec.tab_id }))?.tab ?? null; } catch { /* tab gone */ }

    if (!tab) {
      // Closing the last tab closes the workspace, so a missing tab can only be rebuilt while the ws lives.
      let ws = null;
      try { ws = (await request('workspace.get', { workspace_id: rec.workspace_id }))?.workspace ?? null; } catch { /* workspace gone */ }
      if (!ws) {
        console.log(`[restore-layout] ws ${rec.workspace_id} gone; skip`);
        continue;
      }
      try {
        await request('layout.apply', {
          workspace_id: rec.workspace_id,
          tab_label: config.mainTabLabel,
          root: { type: 'pane', command: masterArgv(config), cwd: rec.cwd || process.cwd() },
        });
      } catch (e) {
        console.error(`[restore-layout] rebuild failed: ${e.message}`);
        continue;
      }
      console.log(`[restore-layout] ws ${rec.workspace_id}: main tab rebuilt`);
      continue;
    }

    const pane = wsPanes.find((p) => p.pane_id === rec.pane_id);
    if (!pane) {
      const anchor = wsPanes.find((p) => p.tab_id === rec.tab_id);
      if (!anchor) continue;
      try {
        await request('pane.focus', { pane_id: anchor.pane_id });
        const split = await request('pane.split', { direction: 'right', cwd: rec.cwd || undefined });
        const paneId = deepFind(split, 'pane_id') ?? '';
        if (paneId) await relaunchInPane(paneId);
        console.log(`[restore-layout] ws ${rec.workspace_id}: master pane relaunched (${paneId})`);
      } catch (e) {
        console.error(`[restore-layout] pane rebuild failed: ${e.message}`);
      }
      continue;
    }

    // Pane survived: a raw shell means the session was reset -> re-inject; a live pi master is healthy.
    if (pane.agent === 'pi' || (typeof pane.title === 'string' && /⏳|▶/.test(pane.title))) {
      console.log(`[restore-layout] ws ${rec.workspace_id}: main pane healthy; skip`);
      continue;
    }
    try {
      await relaunchInPane(rec.pane_id);
      console.log(`[restore-layout] ws ${rec.workspace_id}: pane ${rec.pane_id} relaunched`);
    } catch (e) {
      console.error(`[restore-layout] relaunch failed: ${e.message}`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error('[restore-layout] ' + e.message); process.exit(1); });
