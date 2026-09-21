/**
 * TUI renderers for pier's own session custom entries and reminder messages: raw JSON rows bury the
 * one line that matters. Pure string builders plus an ANSI-aware truncator, so no pi-tui import is
 * needed and older pi builds degrade to "no renderer".
 */
import { TODO_EDIT_CUSTOM_TYPE, type TodoEditPayload } from './todo-core.ts';
import { SUBS_CUSTOM_TYPE, type SubsRegistry } from './subagent-core.ts';
import { TERMINALS_CUSTOM_TYPE, TERM_REMINDER_CUSTOM_TYPE, type TerminalsRegistry } from './terminal-core.ts';
import { TODO_REMINDER_CUSTOM_TYPE } from './todo-reminder-core.ts';

// Width handling lives in ansi-text.ts so ask_user_question can reuse it without this import graph.
import { truncateStyled } from './ansi-text.ts';

/** Role manifest entry is written by index.ts; keep the literal here to avoid an import cycle. */
export const ROLE_MANIFEST_CUSTOM_TYPE = 'pi-herdr.role-manifest';
/** Soft-approval trace from the worker manifest gate in index.ts. */
export const APPROVAL_NEEDED_CUSTOM_TYPE = 'pi-herdr.approval-needed';

/** Structural subset of pi's Theme actually used here. */
export interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface RenderComponent {
  render(width: number): string[];
  invalidate(): void;
}

type Renderer = (payload: unknown, options: { expanded: boolean }, theme: RenderTheme) => RenderComponent | undefined;

export interface RendererApi {
  registerEntryRenderer?(customType: string, renderer: Renderer): void;
  registerMessageRenderer?(customType: string, renderer: Renderer): void;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function card(lines: readonly string[]): RenderComponent {
  return {
    render: (width: number) => lines.map((line) => truncateStyled(line, width)),
    invalidate() { /* No cached state. */ },
  };
}

const EDIT_VERB: Record<string, string> = {
  done: '✓ done',
  drop: '■ dropped',
  unblock: '○ unblocked',
  rm: '✗ removed',
};

function formatEditCounts(edits: ReadonlyArray<{ op: string }>): string {
  const counts = new Map<string, number>();
  for (const edit of edits) counts.set(edit.op, (counts.get(edit.op) ?? 0) + 1);
  return [...counts.entries()]
    .map(([op, n]) => `${EDIT_VERB[op] ?? op}${n > 1 ? ` ×${n}` : ''}`)
    .join(' · ');
}

function todoEditLines(data: unknown, theme: RenderTheme, expanded: boolean): string[] {
  const payload = data as TodoEditPayload | undefined;
  const edits = Array.isArray(payload?.edits) ? payload.edits : [];
  if (edits.length === 0) return [theme.fg('dim', 'todo · no edits')];
  const head = `${theme.fg('accent', theme.bold('todo'))} ${theme.fg('dim', `· ${edits.length} edit${edits.length > 1 ? 's' : ''}`)} ${formatEditCounts(edits)}`;
  if (!expanded) return [head];
  return [
    head,
    ...edits.map((edit) => theme.fg('dim', `  ${EDIT_VERB[edit.op] ?? edit.op} — ${clip(String(edit.content ?? ''), 90)}`)),
  ];
}

/** Registry card, shared by the subagent and terminal registries: a titled count line plus one row
 *  per entry when expanded; an empty or malformed registry renders one dim placeholder. */
function registryLines<T>(
  items: readonly T[] | undefined,
  theme: RenderTheme,
  expanded: boolean,
  card: { label: string; unit: string; badge?: string; row: (item: T) => string },
): string[] {
  if (!items || items.length === 0) return [theme.fg('dim', `${card.label} · none`)];
  const head = `${theme.fg('accent', theme.bold(card.label))} ${theme.fg('dim', `· ${items.length} ${card.unit}`)}${card.badge ? ` ${theme.fg('success', card.badge)}` : ''}`;
  if (!expanded) return [head];
  return [head, ...items.map((item) => theme.fg('dim', card.row(item)))];
}

function subsLines(data: unknown, theme: RenderTheme, expanded: boolean): string[] {
  const subs = (data as SubsRegistry | undefined)?.subs;
  const running = Array.isArray(subs) ? subs.filter((sub) => sub.status === 'running').length : 0;
  return registryLines(Array.isArray(subs) ? subs : undefined, theme, expanded, {
    label: 'subagents',
    unit: 'tracked',
    ...(running ? { badge: `${running} running` } : {}),
    row: (sub) => `  ${sub.status === 'running' ? '●' : '○'} ${sub.paneId} · ${sub.status} · ${clip(String(sub.description ?? ''), 70)}`,
  });
}

function terminalsLines(data: unknown, theme: RenderTheme, expanded: boolean): string[] {
  const terminals = (data as TerminalsRegistry | undefined)?.terminals;
  return registryLines(Array.isArray(terminals) ? terminals : undefined, theme, expanded, {
    label: 'terminals',
    unit: 'open',
    row: (t) => `  ${t.paneId} · ${clip(String(t.label ?? t.cwd ?? ''), 70)}`,
  });
}

function roleManifestLines(data: unknown, theme: RenderTheme): string[] {
  const rec = (data ?? {}) as {
    role?: unknown;
    manifestVersion?: unknown;
    tools?: unknown;
    permissions?: unknown;
    origin?: unknown;
    switchedBy?: unknown;
  };
  const role = typeof rec.role === 'string' ? rec.role : '?';
  const version = typeof rec.manifestVersion === 'string' || typeof rec.manifestVersion === 'number' ? String(rec.manifestVersion) : '?';
  const tools = Array.isArray(rec.tools) ? rec.tools.length : 0;
  const gates = Object.values((rec.permissions ?? {}) as Record<string, unknown>)
    .filter((v) => v === 'deny' || v === 'ask').length;
  const tail = gates > 0 ? theme.fg('warning', ` · ${gates} gated`) : '';
  // P0: switch provenance — origin 'switch' marks a mid-session swap (vs the session_start anchor).
  const switched =
    rec.origin === 'switch'
      ? theme.fg('accent', ` ⇄ ${typeof rec.switchedBy === 'string' && rec.switchedBy ? rec.switchedBy : '?'}`)
      : '';
  return [`${theme.fg('accent', theme.bold('role'))} ${role} ${theme.fg('dim', `v${version} · ${tools} tools`)}${tail}${switched}`];
}

function approvalLines(data: unknown, theme: RenderTheme): string[] {
  const rec = (data ?? {}) as { role?: unknown; tool?: unknown };
  const role = typeof rec.role === 'string' ? rec.role : '?';
  const tool = typeof rec.tool === 'string' ? rec.tool : '?';
  return [`${theme.fg('warning', '⚠ approval needed')} ${theme.fg('dim', `· ${tool} (${role})`)}`];
}

/** Reminder custom messages carry the full injected text; restyle without altering it. */
function reminderLines(message: unknown, theme: RenderTheme, label: string, expanded: boolean): string[] {
  const content = typeof (message as { content?: unknown } | undefined)?.content === 'string'
    ? String((message as { content: string }).content)
    : '';
  const firstLine = content.split('\n').find((line) => line.trim().length > 0) ?? label;
  const head = `${theme.fg('warning', `↻ ${label}`)}`;
  if (!expanded) return [head, theme.fg('dim', `  ${clip(firstLine, 110)}`)];
  return [head, ...content.split('\n').map((line) => theme.fg('dim', line))];
}

type LineBuilder = (data: unknown, theme: RenderTheme, expanded: boolean) => string[];

/** Register pier's transcript renderers and return the custom types actually registered, so the
 *  caller can log coverage and tests can assert the degrade path. Each registration is individually
 *  guarded: a pi build without the API must never break tool registration. */
export function installRenderers(pi: unknown): string[] {
  const api = pi as RendererApi;
  const registered: string[] = [];
  const entry = (type: string, build: LineBuilder): void => {
    if (typeof api.registerEntryRenderer !== 'function') return;
    try {
      api.registerEntryRenderer(type, (entryData, options, theme) =>
        card(build((entryData as { data?: unknown } | undefined)?.data, theme, options.expanded)));
      registered.push(type);
    } catch {
      /* Older pi or a conflicting renderer: keep the default rendering. */
    }
  };
  const message = (type: string, build: LineBuilder): void => {
    if (typeof api.registerMessageRenderer !== 'function') return;
    try {
      api.registerMessageRenderer(type, (msg, options, theme) => card(build(msg, theme, options.expanded)));
      registered.push(type);
    } catch {
      /* A throwing renderer must not break message registration. */
    }
  };

  entry(TODO_EDIT_CUSTOM_TYPE, todoEditLines);
  entry(SUBS_CUSTOM_TYPE, subsLines);
  entry(TERMINALS_CUSTOM_TYPE, terminalsLines);
  entry(ROLE_MANIFEST_CUSTOM_TYPE, (data, theme) => roleManifestLines(data, theme));
  entry(APPROVAL_NEEDED_CUSTOM_TYPE, (data, theme) => approvalLines(data, theme));
  message(TODO_REMINDER_CUSTOM_TYPE, (msg, theme, expanded) => reminderLines(msg, theme, 'todo reminder', expanded));
  message(TERM_REMINDER_CUSTOM_TYPE, (msg, theme, expanded) => reminderLines(msg, theme, 'terminal nudge', expanded));
  return registered;
}
