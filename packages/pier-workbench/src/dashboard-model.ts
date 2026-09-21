/** Pure model/formatting for the Pier Ops Dashboard: a Herdr session snapshot in, formatted lines out.
 * No I/O and no global state, so the whole surface stays offline-unit-testable. */

export interface SnapshotWorkspace {
  workspace_id: string;
  number?: number;
  label?: string;
  focused?: boolean;
  agent_status?: string;
}

export interface SnapshotTab {
  tab_id: string;
  workspace_id: string;
  number?: number;
  label?: string;
  focused?: boolean;
  agent_status?: string;
}

export interface SnapshotPane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  focused?: boolean;
  agent_status?: string;
  agent?: string | null;
  display_agent?: string | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  title?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  tokens?: Record<string, string>;
}

export interface SessionSnapshotData {
  version?: string;
  protocol?: number;
  workspaces?: SnapshotWorkspace[];
  tabs?: SnapshotTab[];
  panes?: SnapshotPane[];
  focused_workspace_id?: string | null;
  focused_tab_id?: string | null;
  focused_pane_id?: string | null;
}

export interface ComposeDashboardOptions {
  targetWorkspaceId?: string | null;
  now?: number;
}

/** Pane table columns (title + width); the header and its rule are rendered from this table. */
const PANE_COLUMNS: Array<[string, number]> = [
  ['PANE ID', 10],
  ['ROLE', 8],
  ['STATUS', 10],
  ['FOC', 4],
  ['TODO / TITLE / TOKENS', 44],
];

/** Pier agent statuses tallied per workspace; the summary line renders straight from this table. */
const PIER_STATUSES: Record<string, number> = { working: 0, blocked: 0, idle: 0 };

const RULE = '--------------------------------------------------------------------------------';
const BANNER = '================================================================================';

/**
 * Normalizes raw socket responses into SessionSnapshotData, accepting a direct snapshot object as
 * well as the `{ snapshot }` and `{ result: { snapshot } }` envelopes.
 */
export function normalizeSnapshot(raw: unknown): SessionSnapshotData | null {
  if (!raw || typeof raw !== 'object') return null;
  const root = raw as Record<string, unknown>;
  const envelope = (root.result as Record<string, unknown> | undefined)?.snapshot ?? root.snapshot;
  const s = (envelope && typeof envelope === 'object' ? envelope : root) as Record<string, unknown>;
  const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
  const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

  return {
    version: str(s.version) ?? undefined,
    protocol: typeof s.protocol === 'number' ? s.protocol : undefined,
    workspaces: list<SnapshotWorkspace>(s.workspaces),
    tabs: list<SnapshotTab>(s.tabs),
    panes: list<SnapshotPane>(s.panes),
    focused_workspace_id: str(s.focused_workspace_id),
    focused_tab_id: str(s.focused_tab_id),
    focused_pane_id: str(s.focused_pane_id),
  };
}

function pad(str: string, width: number): string {
  if (str.length > width) return str.slice(0, width - 1) + '…';
  return str.padEnd(width, ' ');
}

export function composeDashboardLines(
  rawSnapshot: unknown,
  options?: ComposeDashboardOptions
): string[] {
  const data = normalizeSnapshot(rawSnapshot);
  const timeStr = new Date(options?.now ?? Date.now()).toTimeString().slice(0, 8);
  const meta = [
    data?.version ? `Herdr v${data.version}` : 'Herdr (offline)',
    data?.protocol ? `proto ${data.protocol}` : '',
  ].filter(Boolean).join(', ');

  const lines = [`==================== PIER OPS DASHBOARD ==================== [${timeStr}] (${meta})`];
  if (!data || (!data.workspaces.length && !data.panes.length)) {
    lines.push(
      '',
      '  No active Herdr session or empty workspace data.',
      '  Waiting for Herdr session snapshot...',
      '',
      BANNER,
    );
    return lines;
  }

  const wsItems = data.workspaces.map((w) => {
    const focus = w.focused || w.workspace_id === data.focused_workspace_id ? '*' : '';
    const status = w.agent_status && w.agent_status !== 'unknown' ? `:${w.agent_status}` : '';
    return `[${focus}${w.workspace_id}: ${w.label ?? 'unnamed'}${status}]`;
  });
  lines.push(`Workspaces (${wsItems.length}): ${wsItems.join(' ')}`, RULE);

  const targetId = options?.targetWorkspaceId ?? data.focused_workspace_id ?? data.workspaces[0]?.workspace_id;
  const ws = data.workspaces.find((w) => w.workspace_id === targetId)
    ?? { workspace_id: targetId ?? 'unknown', label: 'default' };
  const wsTabs = data.tabs.filter((t) => t.workspace_id === ws.workspace_id);
  const wsPanes = data.panes.filter((p) => p.workspace_id === ws.workspace_id);
  lines.push(`Current Workspace: ${ws.workspace_id} (${ws.label ?? 'unnamed'}) | Tabs: ${wsTabs.length} | Panes: ${wsPanes.length}`);

  if (wsTabs.length > 0) {
    const tabParts = wsTabs.map((t) => {
      const focus = t.focused || t.tab_id === data.focused_tab_id ? '*' : ' ';
      return `${focus}#${t.number ?? '?'}[${t.label ?? t.tab_id}](${t.agent_status ?? 'unknown'})`;
    });
    lines.push(`Tabs: ${tabParts.join('  ')}`);
  }
  lines.push(RULE);

  lines.push(PANE_COLUMNS.map(([title, width]) => pad(title, width)).join(' '));
  lines.push(PANE_COLUMNS.map(([, width]) => '-'.repeat(width)).join(' '));

  const counts: Record<string, number> = { ...PIER_STATUSES };
  let pierCount = 0;
  for (const p of wsPanes) {
    const status = p.agent_status ?? 'unknown';
    if (p.agent === 'pi' || p.tokens?.['pi-todo']) {
      pierCount += 1;
      if (status in counts) counts[status] += 1;
    }
    // pi-todo wins; else the Herdr 0.9.1 stripped OSC title (the raw title may still carry a spinner).
    let desc = p.tokens?.['pi-todo'] ?? p.terminal_title_stripped ?? p.title ?? p.terminal_title ?? '';
    const locks = Object.keys(p.tokens ?? {}).filter((k) => k.startsWith('lock-')).length;
    if (locks > 0) desc += ` [${locks} lock${locks > 1 ? 's' : ''}]`;
    if (!desc && (p.foreground_cwd || p.cwd)) {
      const cwd = p.foreground_cwd || p.cwd || '';
      desc = `cwd: ${cwd.split('/').pop() || cwd}`;
    }
    lines.push([
      pad(p.pane_id, 10),
      pad(p.display_agent ?? (p.agent || '-'), 8),
      pad(status === 'blocked' ? '! BLOCKED' : status, 10),
      p.focused || p.pane_id === data.focused_pane_id ? ' *  ' : '    ',
      pad(desc, 44),
    ].join(' '));
  }

  if (wsPanes.length === 0) lines.push('  (No panes in this workspace)');
  lines.push(RULE);

  if (counts.blocked > 0) {
    lines.push(`⚠️  ALERT: ${counts.blocked} SUBAGENT(S) BLOCKED — WAITING ON HUMAN DECISION`);
  }
  lines.push(
    `Summary: ${wsPanes.length} pane(s) | Pier agents: ${pierCount} (${counts.working} working, ${counts.blocked} blocked, ${counts.idle} idle)`,
    BANNER,
  );

  return lines;
}
