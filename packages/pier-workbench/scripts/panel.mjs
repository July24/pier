#!/usr/bin/env node
/** Pier panel: one popup with two glance views (Dashboard / Tree).
 *
 * `/dashboard` and `/pier-tree` both run this entrypoint; `PIER_PANEL` selects the initial tab and
 * the `1`/`2`/`Tab` keys switch inside the panel. A Herdr popup is session-modal, so there is no
 * second command to route while it is open. With HERDR_PANE_ID set (overlay/tab) this is a normal
 * pane running the same tabs.
 */
import { readFileSync } from 'node:fs';
import { request } from './herdr-rpc.mjs';
import { clipToWidth, composeDashboardLines, fitDashboardLines } from '../src/dashboard-model.ts';

const onceMode = process.argv.includes('--once');
const entrypoint = process.env.HERDR_PLUGIN_ENTRYPOINT_ID || 'panel';
const initial = process.env.PIER_PANEL === 'tree' || entrypoint === 'tree' ? 'tree' : 'dashboard';

let active = initial;
let treeFile = process.env.PIER_TREE_FILE || '';
const offsets = { dashboard: 0, tree: 0 };
let snapshot = null;
let snapshotAt = 0;
let treeLines = null;
let treeAt = 0;
let dashboardWidth = 0;

let targetWorkspaceId = null;
if (process.env.HERDR_PLUGIN_CONTEXT_JSON) {
  try {
    targetWorkspaceId = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON)?.workspace_id ?? null;
  } catch {
    // Invalid context JSON: fall back to the focused workspace.
  }
}

function readTree() {
  if (!treeFile) {
    return [
      '==================== PIER DELEGATION TREE ====================',
      'No tree snapshot — run /pier-tree from a pi pane.',
    ];
  }
  if (treeLines && Date.now() - treeAt < 1000) return treeLines;
  try {
    treeLines = readFileSync(treeFile, 'utf8').replace(/\n$/, '').split('\n');
  } catch {
    treeLines = [
      '==================== PIER DELEGATION TREE ====================',
      'Waiting for the pi pane to publish a tree snapshot…',
    ];
  }
  treeAt = Date.now();
  return treeLines;
}

async function dashboard(width, force = false) {
  const now = Date.now();
  if (force || !snapshot || now - snapshotAt > 3000 || dashboardWidth !== width) {
    snapshot = await request('session.snapshot', {}, 3000).catch(() => null);
    snapshotAt = now;
    dashboardWidth = width;
  }
  return composeDashboardLines(snapshot, { targetWorkspaceId, width });
}

function printOnce() {
  if (active === 'tree') {
    console.log(readTree().join('\n'));
    return;
  }
  dashboard(0, true).then((lines) => console.log(lines.join('\n')));
}

async function runLoop() {
  let running = true;
  let tickInFlight = false;

  const cleanup = () => {
    if (!running) return;
    running = false;
    // Herdr closes a popup when its command exits; no popup.close needed (and no foreign-popup risk).
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  function viewport() {
    const width = Math.max(40, process.stdout.columns || 100);
    const rows = Math.max(3, process.stdout.rows || 30);
    return { width, rows: rows - 2 }; // one header row + one footer row
  }

  async function tick(forceRefresh = false) {
    if (!running || tickInFlight) return;
    tickInFlight = true;
    try {
      const { width, rows } = viewport();
      const body = active === 'dashboard'
        ? await dashboard(width, forceRefresh)
        : readTree();
      const view = fitDashboardLines(body, { width, height: rows, offset: offsets[active] });
      offsets[active] = view.offset;

      const tabs = `${active === 'dashboard' ? '▶' : ' '}1 Dashboard   ${active === 'tree' ? '▶' : ' '}2 Tree`;
      const header = clipToWidth(` PIER PANEL  ${tabs} `, width);
      const first = view.visible > 0 ? view.offset + 1 : 0;
      const last = view.offset + view.visible;
      const footer = clipToWidth(
        view.total > view.visible
          ? `lines ${first}-${last}/${view.total} · 1/2 Switch · [q] Close · [↑↓/jk] Scroll · [PgUp/PgDn] Page`
          : '1/2 Switch · [q / Esc] Close · [r] Refresh',
        width,
      );
      process.stdout.write('\x1b[2J\x1b[H' + [header, ...view.lines, footer].join('\n'));
    } finally {
      tickInFlight = false;
    }
  }

  function switchTo(panel) {
    active = panel;
    offsets[active] = 0;
    void tick();
  }

  function move(delta) {
    const { rows } = viewport();
    offsets[active] = Math.max(0, offsets[active] + delta * rows);
    void tick();
  }

  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (key) => {
        if (key === 'q' || key === 'Q' || key === '\u001b' || key === '\u0003') {
          cleanup();
        } else if (key === '1' || key === 'd') {
          switchTo('dashboard');
        } else if (key === '2' || key === 't') {
          switchTo('tree');
        } else if (key === '\t') {
          switchTo(active === 'dashboard' ? 'tree' : 'dashboard');
        } else if (key === '\u001b[A' || key === 'k') {
          offsets[active] = Math.max(0, offsets[active] - 1);
          void tick();
        } else if (key === '\u001b[B' || key === 'j') {
          offsets[active] += 1;
          void tick();
        } else if (key === '\u001b[5~') {
          move(-1);
        } else if (key === '\u001b[6~' || key === ' ') {
          move(1);
        } else if (key === 'g') {
          offsets[active] = 0;
          void tick();
        } else if (key === 'G') {
          offsets[active] = Number.MAX_SAFE_INTEGER;
          void tick();
        } else if (key === 'r' || key === 'R') {
          treeLines = null;
          void tick(true);
        }
      });
    } catch {
    }
  }

  process.stdout.on?.('resize', () => { void tick(); });

  await tick();
  // Keep the loop alive even when stdin is not a TTY (direct runs/CI); `--once` is the batch mode.
  setInterval(tick, 1000);
}

if (onceMode) {
  printOnce();
} else {
  runLoop().catch(() => process.exit(0));
}
