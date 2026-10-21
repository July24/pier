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
  /** Render width in terminal cells; the description column absorbs the remainder. */
  width?: number;
}

/** Fixed pane-table columns; the description column gets whatever width is left. */
const PANE_FIXED: ReadonlyArray<[string, number]> = [
  ['PANE ID', 10],
  ['ROLE', 8],
  ['STATUS', 10],
  ['FOC', 4],
];
const PANE_FIXED_WIDTH = PANE_FIXED.reduce((sum, [, width]) => sum + width, 0) + PANE_FIXED.length; // + separators
const PANE_DESC_MIN = 20;
const PANE_DESC_TITLE = 'TODO / TITLE / TOKENS';

function paneColumns(width: number): Array<[string, number]> {
  const desc = Math.max(PANE_DESC_MIN, width - PANE_FIXED_WIDTH);
  return [...PANE_FIXED, [PANE_DESC_TITLE, desc]];
}

/** Pier agent statuses tallied per workspace; the summary line renders straight from this table. */
const PIER_STATUSES: Record<string, number> = { working: 0, blocked: 0, idle: 0 };

/** Herdr reports `unknown` for a pane with no agent (a plain shell). That is a pane kind, not a
 *  stalled agent, so the STATUS column says `shell` instead of alarming the operator. */
export function paneStatus(p: SnapshotPane): string {
  const status = p.agent_status ?? 'unknown';
  return status === 'unknown' && !p.agent ? 'shell' : status;
}

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

/** Terminal cell width for one code point: wide CJK/emoji ranges count as two cells. */
function charWidth(cp: number): number {
  if (cp === 0 || cp === 0xfe0f || cp === 0x200d) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  return (cp >= 0x1100 && cp <= 0x115f)
    || (cp >= 0x2e80 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe10 && cp <= 0xfe19)
    || (cp >= 0xfe30 && cp <= 0xfe6f)
    || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1f64f)
    || (cp >= 0x1f900 && cp <= 0x1f9ff)
    || (cp >= 0x20000 && cp <= 0x3fffd)
    ? 2
    : 1;
}

export function displayWidth(str: string): number {
  let width = 0;
  for (const ch of str) width += charWidth(ch.codePointAt(0) ?? 0);
  return width;
}

/** Hard-wrap a line into `width`-cell rows (wide characters stay whole). */
export function wrapToWidth(str: string, width: number): string[] {
  if (width <= 0) return [''];
  const rows: string[] = [];
  let out = '';
  let used = 0;
  for (const ch of str) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (used + w > width && out !== '') {
      rows.push(out);
      out = '';
      used = 0;
    }
    out += ch;
    used += w;
  }
  rows.push(out);
  return rows;
}

/** Fit a line into `width` cells, appending `…` when content is dropped. */
export function clipToWidth(str: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(str) <= width) return str;
  const limit = width - 1;
  let out = '';
  let used = 0;
  for (const ch of str) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (used + w > limit) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

function pad(str: string, width: number): string {
  const clipped = clipToWidth(str, width);
  return clipped + ' '.repeat(Math.max(0, width - displayWidth(clipped)));
}

export interface DashboardView {
  lines: string[];
  /** Clamped scroll offset (0 = top). */
  offset: number;
  /** Total number of composed lines. */
  total: number;
  /** Rows visible in this window. */
  visible: number;
}

/** Wrap to `width` and return the `height`-row viewport at `offset`; used by the popup renderer. */
export function fitDashboardLines(
  lines: readonly string[],
  opts: { width?: number; height?: number; offset?: number } = {},
): DashboardView {
  const width = opts.width && opts.width > 0 ? opts.width : 0;
  const wrapped = width > 0
    ? lines.flatMap((line) => wrapToWidth(line, width))
    : [...lines];
  const total = wrapped.length;
  const height = opts.height && opts.height > 0 ? Math.floor(opts.height) : total;
  const maxOffset = Math.max(0, total - height);
  const offset = Math.min(Math.max(0, Math.floor(opts.offset ?? 0)), maxOffset);
  return {
    lines: wrapped.slice(offset, offset + height),
    offset,
    total,
    visible: Math.min(height, total),
  };
}

export function composeDashboardLines(
  rawSnapshot: unknown,
  options?: ComposeDashboardOptions
): string[] {
  const data = normalizeSnapshot(rawSnapshot);
  const width = options?.width && options.width > 0 ? Math.max(40, Math.floor(options.width)) : null;
  const columns = paneColumns(width ?? 80);
  const rule = '-'.repeat(width ?? 80);
  const banner = '='.repeat(width ?? 80);
  const timeStr = new Date(options?.now ?? Date.now()).toTimeString().slice(0, 8);
  const meta = [
    data?.version ? `Herdr v${data.version}` : 'Herdr (offline)',
    data?.protocol ? `proto ${data.protocol}` : '',
  ].filter(Boolean).join(', ');

  const label = ` PIER OPS DASHBOARD [${timeStr}] (${meta}) `;
  const side = Math.max(0, (width ?? 80) - displayWidth(label));
  const lines = [`${'='.repeat(Math.floor(side / 2))}${clipToWidth(label, width ?? 80)}${'='.repeat(Math.ceil(side / 2))}`];
  if (!data || (!data.workspaces.length && !data.panes.length)) {
    lines.push(
      '',
      '  No active Herdr session or empty workspace data.',
      '  Waiting for Herdr session snapshot...',
      '',
      banner,
    );
    return lines;
  }

  const wsItems = data.workspaces.map((w) => {
    const focus = w.focused || w.workspace_id === data.focused_workspace_id ? '*' : '';
    const status = w.agent_status && w.agent_status !== 'unknown' ? `:${w.agent_status}` : '';
    return `[${focus}${w.workspace_id}: ${w.label ?? 'unnamed'}${status}]`;
  });
  lines.push(`Workspaces (${wsItems.length}): ${wsItems.join(' ')}`, rule);

  const targetId = options?.targetWorkspaceId ?? data.focused_workspace_id ?? data.workspaces[0]?.workspace_id;
  const ws = data.workspaces.find((w) => w.workspace_id === targetId)
    ?? { workspace_id: targetId ?? 'unknown', label: 'default' };
  const wsTabs = data.tabs.filter((t) => t.workspace_id === ws.workspace_id);
  const wsPanes = data.panes.filter((p) => p.workspace_id === ws.workspace_id);
  lines.push(`Current Workspace: ${ws.workspace_id} (${ws.label ?? 'unnamed'}) | Tabs: ${wsTabs.length} | Panes: ${wsPanes.length}`);

  if (wsTabs.length > 0) {
    // A tab whose panes are all plain shells has no agent status either; report the aggregate as
    // `shell` instead of `unknown`, matching the pane rows.
    const tabStatus = (t: SnapshotTab): string => {
      const status = t.agent_status ?? 'unknown';
      if (status !== 'unknown') return status;
      const panes = wsPanes.filter((p) => p.tab_id === t.tab_id);
      return panes.length > 0 && panes.every((p) => paneStatus(p) === 'shell') ? 'shell' : status;
    };
    const tabParts = wsTabs.map((t) => {
      const focus = t.focused || t.tab_id === data.focused_tab_id ? '*' : ' ';
      return `${focus}#${t.number ?? '?'}[${t.label ?? t.tab_id}](${tabStatus(t)})`;
    });
    lines.push(`Tabs: ${tabParts.join('  ')}`);
  }
  lines.push(rule);

  lines.push(columns.map(([title, colWidth]) => pad(title, colWidth)).join(' '));
  lines.push(columns.map(([, colWidth]) => '-'.repeat(colWidth)).join(' '));

  const counts: Record<string, number> = { ...PIER_STATUSES };
  let pierCount = 0;
  for (const p of wsPanes) {
    const status = paneStatus(p);
    if (p.agent === 'pi' || p.tokens?.['pi-todo']) {
      pierCount += 1;
      // Own keys only: `status in counts` also matches Object.prototype members from a stray status.
      if (Object.hasOwn(counts, status)) counts[status] += 1;
    }
  }

  // Delegation tree (RFC rfc-delegation-identity §2.3): a worker carries tokens['pi-parent'];
  // it renders indented right under its parent when the parent pane is in this workspace.
  const paneIds = new Set(wsPanes.map((p) => p.pane_id));
  const delegatedChildren = (parent: SnapshotPane): SnapshotPane[] =>
    wsPanes.filter((p) => p.tokens?.['pi-parent'] === parent.pane_id);
  const isDelegated = (p: SnapshotPane): boolean =>
    typeof p.tokens?.['pi-parent'] === 'string'
    && p.tokens['pi-parent'] !== ''
    && paneIds.has(p.tokens['pi-parent']);

  const pushPaneRow = (p: SnapshotPane, indent: boolean): void => {
    const status = paneStatus(p);
    // pi-todo wins; else the Herdr 0.9.1 stripped OSC title (the raw title may still carry a spinner).
    let desc = p.tokens?.['pi-todo'] ?? p.terminal_title_stripped ?? p.title ?? p.terminal_title ?? '';
    const locks = Object.keys(p.tokens ?? {}).filter((k) => k.startsWith('lock-')).length;
    if (locks > 0) desc += ` [${locks} lock${locks > 1 ? 's' : ''}]`;
    if (!desc && (p.foreground_cwd || p.cwd)) {
      const cwd = p.foreground_cwd || p.cwd || '';
      desc = `cwd: ${cwd.split('/').pop() || cwd}`;
    }
    lines.push([
      pad(indent ? `↳ ${p.pane_id}` : p.pane_id, columns[0]![1]),
      pad(p.display_agent ?? (p.agent || '-'), columns[1]![1]),
      pad(status === 'blocked' ? '! BLOCKED' : status, columns[2]![1]),
      p.focused || p.pane_id === data.focused_pane_id ? ' *  ' : '    ',
      pad(desc, columns[4]![1]),
    ].join(' '));
  };
  for (const p of wsPanes) {
    if (isDelegated(p)) continue; // rendered under its parent
    pushPaneRow(p, false);
    for (const child of delegatedChildren(p)) pushPaneRow(child, true);
  }

  if (wsPanes.length === 0) lines.push('  (No panes in this workspace)');
  lines.push(rule);

  if (counts.blocked > 0) {
    // Attribution answers "who is waiting on whom": worker ← delegating master pane.
    const attributed = wsPanes
      .filter((p) => (p.agent_status ?? 'unknown') === 'blocked' && p.tokens?.['pi-parent'])
      .map((p) => `${p.pane_id} ← ${p.tokens?.['pi-parent']}`);
    const suffix = attributed.length > 0 ? ` [${attributed.join(', ')}]` : '';
    lines.push(`⚠️  ALERT: ${counts.blocked} SUBAGENT(S) BLOCKED — WAITING ON HUMAN DECISION${suffix}`);
  }
  lines.push(
    `Summary: ${wsPanes.length} pane(s) | Pier agents: ${pierCount} (${counts.working} working, ${counts.blocked} blocked, ${counts.idle} idle)`,
    banner,
  );

  return lines;
}
