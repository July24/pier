#!/usr/bin/env node
/**
 * Herdr [[startup]] hook (v1.3 M7, D28): replay the bootstrapped war-room layout after a session restore.
 *
 * Per record (newest per workspace, F05): layout.apply rebuilds a missing tab, pane.split revives a missing
 * pane, a plain-shell survivor is re-injected, a live pi master is skipped. Not a daemon — one-shot.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootFilePath, deepFind, launchCommand, masterArgv, readBootConfig, request } from './herdr-rpc.mjs';
import { isMasterPane, latestBootRecordPerWorkspace, parseBootRecords, rebuiltBootRecord } from '../src/restore-plan.ts';

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

/** Point the newest record at the live main pane so the next startup does not rebuild it again. */
function recordRebuilt(rec, ids) {
  const next = rebuiltBootRecord(rec, ids, Date.now());
  if (!next) {
    console.error(`[restore-layout] ws ${rec.workspace_id}: no pane id in herdr reply; boot record not updated`);
    return;
  }
  try {
    fs.mkdirSync(path.dirname(BOOT_FILE), { recursive: true });
    fs.appendFileSync(BOOT_FILE, JSON.stringify(next) + '\n');
  } catch (e) {
    console.error('[restore-layout] boot record write failed: ' + e.message);
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
    const recordedPane = wsPanes.find((p) => p.pane_id === rec.pane_id);
    // The recorded pane is gone but a pi master already runs here (a user relaunch, or an earlier
    // restore): adopt it instead of rebuilding a second one.
    const liveMaster = recordedPane ? null : wsPanes.find(isMasterPane);
    if (liveMaster) {
      recordRebuilt(rec, { tabId: liveMaster.tab_id, paneId: liveMaster.pane_id });
      console.log(`[restore-layout] ws ${rec.workspace_id}: master already live in ${liveMaster.pane_id}; skip`);
      continue;
    }
    let tab = null;
    try { tab = (await request('tab.get', { tab_id: rec.tab_id }))?.tab ?? null; } catch {}

    if (!tab) {
      // Closing the last tab closes the workspace, so a missing tab can only be rebuilt while the ws lives.
      let ws = null;
      try { ws = (await request('workspace.get', { workspace_id: rec.workspace_id }))?.workspace ?? null; } catch {}
      if (!ws) {
        console.log(`[restore-layout] ws ${rec.workspace_id} gone; skip`);
        continue;
      }
      try {
        const applied = await request('layout.apply', {
          workspace_id: rec.workspace_id,
          tab_label: config.mainTabLabel,
          root: { type: 'pane', command: masterArgv(config), cwd: rec.cwd || process.cwd() },
        });
        recordRebuilt(rec, { tabId: deepFind(applied, 'tab_id'), paneId: deepFind(applied, 'pane_id') });
      } catch (e) {
        console.error(`[restore-layout] rebuild failed: ${e.message}`);
        continue;
      }
      console.log(`[restore-layout] ws ${rec.workspace_id}: main tab rebuilt`);
      continue;
    }

    const pane = recordedPane;
    if (!pane) {
      const anchor = wsPanes.find((p) => p.tab_id === rec.tab_id);
      if (!anchor) continue;
      try {
        await request('pane.focus', { pane_id: anchor.pane_id });
        const split = await request('pane.split', { direction: 'right', cwd: rec.cwd || undefined });
        const paneId = deepFind(split, 'pane_id') ?? '';
        if (paneId) {
          await relaunchInPane(paneId);
          recordRebuilt(rec, { tabId: rec.tab_id, paneId });
        }
        console.log(`[restore-layout] ws ${rec.workspace_id}: master pane relaunched (${paneId})`);
      } catch (e) {
        console.error(`[restore-layout] pane rebuild failed: ${e.message}`);
      }
      continue;
    }

    // Pane survived: a raw shell means the session was reset -> re-inject; a live pi master is healthy.
    if (isMasterPane(pane)) {
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
