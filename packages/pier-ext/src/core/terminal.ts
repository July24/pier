/**
 * M14 terminal loader entry for the D78 mount tree and D81 responsibility split.
 *
 * Keeping this as a Cordis loader plugin makes the terminal surface hot-swappable. Services
 * provide the D79 tombstone-aware pi surface, herdr client/environment, and the state slot
 * used by index GC. Avoiding an index.ts import preserves an acyclic dependency graph, while
 * terminal-core remains independently testable pure logic.
 */
import { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import type { PiSurface } from '../pi-surface.ts';
import type { HerdrClientLike } from '../herdr-client.ts';
import {
  READINESS_TIMEOUT_MS,
  READ_MAX_CHARS,
  TERMINALS_CUSTOM_TYPE,
  activeTerminalPaneIds,
  classifyReadiness,
  closeTerminal,
  computeIncrement,
  detectFullscreenTUI,
  foldTerminalsRegistry,
  makeTerminalsRegistry,
  registerTerminal,
  stripAnsi,
  summarizeSessions,
  validateSendText,
  validateSignal,
  type ReadCursor,
  type TerminalEntry,
} from '../terminal-core.ts';

export interface TerminalStateSlot {
  /** Lets index GC preserve panes that host active terminals. */
  activePaneIds: () => Set<string>;
}

export interface TerminalDeps {
  client: HerdrClientLike;
  env: { paneId: string; tabId: string } | null;
  state: TerminalStateSlot;
}

export default function terminalPlugin(ctx: Context): void {
  const surface = ctx.get('pi-herdr.surface') as PiSurface<object>;
  const { client, env, state } = ctx.get('pi-herdr.terminal-deps') as TerminalDeps;
  const pi = surface.raw as {
    appendEntry?: (customType: string, data: unknown) => void;
  };
  // Keying the surface by this file lets HMR tombstone and replace exactly this registration.
  const scoped = surface.forModule(import.meta.url);

  /* ── M14 resident terminal tools (D71 / T1–T6) ────────────────────
   * Dedicated herdr panes preserve shell state without reusing the pi TUI pane, and active
   * terminal panes remain exempt from index GC. Workers omit this master-side entry. */

  let terminals: TerminalEntry[] = [];

  function persistTerminals(): void {
    try {
      pi.appendEntry?.(TERMINALS_CUSTOM_TYPE, makeTerminalsRegistry(terminals));
    } catch {
      /* Persistence is best-effort because terminal operation must not depend on session logging. */
    }
  }

  function rebuildTerminals(eventCtx: unknown): void {
    try {
      const entries = (eventCtx as { sessionManager?: { getBranch?: () => readonly unknown[] } })
        ?.sessionManager?.getBranch?.() ?? [];
      terminals = foldTerminalsRegistry(entries as Parameters<typeof foldTerminalsRegistry>[0]);
    } catch {
      /* A malformed snapshot must not block the live terminal surface. */
    }
  }

  function findOpenTerminal(id: unknown): TerminalEntry | null {
    if (typeof id !== 'string') return null;
    return terminals.find((t) => t.terminalId === id && t.status === 'open') ?? null;
  }

  function touchTerminal(entry: TerminalEntry): void {
    entry.lastActivityAt = Date.now();
    persistTerminals();
  }

  // Expose active panes so index GC does not collect resident terminal shells.
  state.activePaneIds = () => activeTerminalPaneIds(terminals);

  scoped.on('session_start', async (_event: unknown, eventCtx: unknown) => {
    rebuildTerminals(eventCtx);
  });
  scoped.on('session_tree', async (_event: unknown, eventCtx: unknown) => {
    rebuildTerminals(eventCtx);
  });

  const TERM_READ_MAX = Number(process.env.PI_HERDR_TERM_READ_MAX ?? READ_MAX_CHARS) || READ_MAX_CHARS;
  const errText = (msg: string) => ({ content: [{ type: 'text' as const, text: `Error: ${msg}` }], details: {} });

  scoped.registerTool({
    name: 'terminal_open',
    label: 'Terminal Open',
    description: [
      'Open a persistent interactive terminal (a resident shell in its own herdr pane, next to this session) and return its terminal_id.',
      'The shell keeps its cwd, environment variables, and background processes across terminal_send/terminal_read calls — use it for dev servers, REPLs, or multi-step shell work instead of one-shot bash calls.',
      '`cwd` (optional): working directory for the shell (defaults to this session cwd).',
      'Readiness: waits for the shell prompt (up to 30s); on timeout the terminal still opens — check with terminal_read before sending.',
      'A human can also type into the pane directly; terminal_close closes it.',
    ].join(' '),
    parameters: Type.Object({
      cwd: Type.Optional(Type.String({ description: 'Working directory for the shell' })),
    }),
    async execute(_tc, params, _sig, _upd, ctx) {
      if (!client.available || !env) return errText('terminal tools require a herdr-managed pane');
      const cwd = typeof params?.cwd === 'string' && params.cwd ? params.cwd
        : (ctx as { cwd?: string }).cwd ?? process.cwd();
      const r = registerTerminal(terminals, {
        paneId: env.paneId, // Reserve a valid id until split returns the terminal pane.
        tabId: env.tabId,
        cwd,
        createdAt: Date.now(),
      });
      if (!r.ok) return errText(r.error);
      let paneId: string;
      try {
        paneId = await client.splitPane({ direction: 'right', cwd, focus: false, targetPaneId: env.paneId });
      } catch (e) {
        return errText(`failed to split terminal pane: ${(e as Error).message}`);
      }
      r.entry.paneId = paneId;
      terminals = r.entries;
      persistTerminals();
      // T3 rechecks locally after server-side PS1 matching times out to avoid false unreadiness.
      let readiness: 'prompt' | 'silent' | 'busy' = 'busy';
      try {
        const matched = await client.waitForOutput(paneId, { type: 'regex', value: '[$>#❯]\\s*$' }, READINESS_TIMEOUT_MS);
        if (matched) readiness = 'prompt';
        else {
          const read = await client.readPane(paneId, { stripAnsi: false });
          readiness = classifyReadiness(stripAnsi(read.text), { silentMs: 0 });
        }
      } catch {
        /* Readiness is advisory, so probe failures still leave a usable terminal. */
      }
      const text = [
        `terminal ${r.entry.terminalId} open (pane ${paneId})`,
        `cwd: ${cwd}`,
        `readiness: ${readiness}${readiness !== 'prompt' ? ' (prompt not detected yet — check with terminal_read before sending)' : ''}`,
      ].join('\n');
      return { content: [{ type: 'text', text }], details: { terminal_id: r.entry.terminalId, pane_id: paneId, readiness } };
    },
  });

  scoped.registerTool({
    name: 'terminal_send',
    label: 'Terminal Send',
    description: [
      'Send a text command (plain text only, no ANSI escapes) to a persistent terminal opened with terminal_open; Enter is appended automatically.',
      'Returns after the keystrokes are delivered — poll terminal_read for output (long-running commands keep producing output across reads).',
      'For control keys use terminal_signal instead. Interactive/fullscreen programs (vim, less, top) are outside this seam.',
    ].join(' '),
    parameters: Type.Object({
      terminal_id: Type.String({ description: 'Terminal id from terminal_open' }),
      text: Type.String({ description: 'Command text to type and run' }),
    }),
    async execute(_tc, params) {
      const entry = findOpenTerminal(params?.terminal_id);
      if (!entry) return errText(`unknown or closed terminal "${String(params?.terminal_id)}" (see terminal_list)`);
      const v = validateSendText(typeof params?.text === 'string' ? params.text : '');
      if (!v.ok) return errText(v.error);
      try {
        await client.sendPaneText(entry.paneId, v.text);
      } catch (e) {
        return errText(`send failed (pane may be closed): ${(e as Error).message}`);
      }
      touchTerminal(entry);
      return { content: [{ type: 'text', text: `sent to ${entry.terminalId} (${v.text.length} chars)` }], details: { terminal_id: entry.terminalId } };
    },
  });

  scoped.registerTool({
    name: 'terminal_read',
    label: 'Terminal Read',
    description: [
      'Read new output from a persistent terminal since your last read (cursor-based increment; the first read returns the recent buffer).',
      '`terminal_id`: your terminal from terminal_open. Alternatively `pane_id`: a pane in this session\'s own tab (narrow scope by design).',
      'Output is ANSI-stripped and bounded; if the buffer scrolled past your last read you get a reset marker plus the current tail.',
      'Detecting a fullscreen TUI program (vim/less/top) returns an error with suggestions instead of garbage.',
    ].join(' '),
    parameters: Type.Object({
      terminal_id: Type.Optional(Type.String({ description: 'Terminal id from terminal_open' })),
      pane_id: Type.Optional(Type.String({ description: 'Direct pane read (own tab panes only)' })),
      max_chars: Type.Optional(Type.Number({ description: 'Output cap for this read' })),
    }),
    async execute(_tc, params) {
      let paneId: string | null = null;
      let entry: TerminalEntry | null = null;
      if (typeof params?.terminal_id === 'string') {
        entry = findOpenTerminal(params.terminal_id);
        if (!entry) return errText(`unknown or closed terminal "${params.terminal_id}" (see terminal_list)`);
        paneId = entry.paneId;
      } else if (typeof params?.pane_id === 'string') {
        // T5 limits direct reads to this task tab or owned terminals to prevent cross-task access.
        try {
          const panes = await client.listPanes();
          const target = panes.find((p) => p.paneId === params.pane_id);
          const ownTab = target?.tabId && target.tabId === env?.tabId;
          const ownTerminal = activeTerminalPaneIds(terminals).has(params.pane_id);
          if (!target || (!ownTab && !ownTerminal)) {
            return errText('pane_id read is limited to panes in this session\'s own tab or self-created terminal panes');
          }
          paneId = params.pane_id;
        } catch (e) {
          return errText(`pane lookup failed: ${(e as Error).message}`);
        }
      } else {
        return errText('provide terminal_id (or pane_id for a direct own-tab read)');
      }
      const maxChars = typeof params?.max_chars === 'number' && params.max_chars > 0
        ? Math.min(params.max_chars, TERM_READ_MAX) : TERM_READ_MAX;
      let read: { text: string; revision: number; truncated: boolean };
      try {
        read = await client.readPane(paneId, { stripAnsi: false });
      } catch (e) {
        return errText(`read failed (pane may be closed): ${(e as Error).message}`);
      }
      // T6 inspects raw output because ANSI stripping would erase alternate-screen evidence.
      const tui = detectFullscreenTUI(read.text);
      if (tui.detected) {
        const head = stripAnsi(read.text).slice(0, 200);
        const text = [
          'FULLSCREEN_TUI_DETECTED: this terminal is running a fullscreen program (e.g. vim/less/top); its screen output is not readable here.',
          'Suggestions:',
          '1. Run such programs in a native herdr pane where the human can interact directly.',
          '2. Use non-interactive alternatives (cat/grep instead of less; edit/write tools instead of vim).',
          `Raw head (first 200 chars): ${head}`,
        ].join('\n');
        return { content: [{ type: 'text', text }], details: { error: 'FULLSCREEN_TUI_DETECTED' } };
      }
      const prev: ReadCursor | null = entry
        ? (entry.readRevision != null
          ? { revision: entry.readRevision, len: entry.readLen, tail: entry.readTail, eoTail: entry.readEoTail }
          : null)
        : null;
      const inc = computeIncrement(prev, { text: read.text, revision: read.revision }, maxChars);
      if (entry) {
        entry.readRevision = inc.cursor.revision;
        entry.readLen = inc.cursor.len;
        entry.readTail = inc.cursor.tail;
        entry.readEoTail = inc.cursor.eoTail;
        touchTerminal(entry);
      }
      if (inc.mode === 'none') {
        return { content: [{ type: 'text', text: 'no new output' }], details: { mode: 'none', revision: read.revision } };
      }
      const output = stripAnsi(inc.text);
      const text = output.length ? output : '(empty)';
      return {
        content: [{ type: 'text', text }],
        details: { mode: inc.mode, revision: read.revision, hard_capped: inc.hardCapped, source_revision_truncated: read.truncated },
      };
    },
  });

  scoped.registerTool({
    name: 'terminal_signal',
    label: 'Terminal Signal',
    description: [
      'Send a control key to a persistent terminal: ctrl+c (interrupt), ctrl+d (EOF), ctrl+z (suspend), esc, enter.',
      'Use ctrl+c to stop a running command; anything beyond this whitelist (complex key sequences) is outside the terminal seam.',
    ].join(' '),
    parameters: Type.Object({
      terminal_id: Type.String({ description: 'Terminal id from terminal_open' }),
      key: Type.String({ description: 'One of: ctrl+c, ctrl+d, ctrl+z, esc, enter' }),
    }),
    async execute(_tc, params) {
      const entry = findOpenTerminal(params?.terminal_id);
      if (!entry) return errText(`unknown or closed terminal "${String(params?.terminal_id)}" (see terminal_list)`);
      const v = validateSignal(typeof params?.key === 'string' ? params.key : '');
      if (!v.ok) return errText(v.error);
      try {
        await client.sendPaneKeys(entry.paneId, [v.key]);
      } catch (e) {
        return errText(`signal failed (pane may be closed): ${(e as Error).message}`);
      }
      touchTerminal(entry);
      return { content: [{ type: 'text', text: `signal ${v.key} sent to ${entry.terminalId}` }], details: { terminal_id: entry.terminalId, key: v.key } };
    },
  });

  scoped.registerTool({
    name: 'terminal_close',
    label: 'Terminal Close',
    description: [
      'Close a persistent terminal (kills its shell process tree and removes the pane).',
      'Terminal state does not survive close — persist anything you need to files first.',
    ].join(' '),
    parameters: Type.Object({
      terminal_id: Type.String({ description: 'Terminal id from terminal_open' }),
    }),
    async execute(_tc, params) {
      const id = params?.terminal_id;
      const entry = terminals.find((t) => t.terminalId === id);
      if (!entry) return errText(`unknown terminal "${String(id)}" (see terminal_list)`);
      if (entry.status === 'open') {
        try {
          await client.closePane(entry.paneId);
        } catch {
          /* The pane may have been closed by a person or with its tab; record the terminal as closed anyway. */
        }
      }
      terminals = closeTerminal(terminals, entry.terminalId, Date.now()).entries;
      persistTerminals();
      return { content: [{ type: 'text', text: `terminal ${entry.terminalId} closed` }], details: { terminal_id: entry.terminalId } };
    },
  });

  scoped.registerTool({
    name: 'terminal_list',
    label: 'Terminal List',
    description: [
      'List this session\'s persistent terminals with open/closed and pane-liveness status.',
      'Entries whose pane is gone (human closed it, restart) are marked closed — terminal sessions do not survive pane closure or restarts; persist state to files instead of relying on terminal reuse.',
    ].join(' '),
    parameters: Type.Object({}),
    async execute() {
      let livePaneIds: string[] = [];
      try {
        livePaneIds = (await client.listPanes()).map((p) => p.paneId);
      } catch {
        /* Treat a failed query as unknown rather than closed, because an empty live set only affects stale detection. */
      }
      const s = summarizeSessions(terminals, livePaneIds);
      // T6 check 3: record vanished panes as closed across restarts rather than reviving them; tell the user to persist state.
      if (s.stalePaneIds.length > 0) {
        terminals = terminals.map((t) =>
          s.stalePaneIds.includes(t.paneId)
            ? { ...t, status: 'closed' as const, closedAt: t.closedAt ?? Date.now() }
            : t,
        );
        persistTerminals();
      }
      if (s.terminals.length === 0) {
        return { content: [{ type: 'text', text: 'no terminals (open one with terminal_open)' }], details: { terminals: [] } };
      }
      const lines = s.terminals.map((t) =>
        `- ${t.terminalId} [${t.live ? 'open' : 'closed'}] pane=${t.paneId} cwd=${t.cwd}${t.label ? ` (${t.label})` : ''}`,
      );
      const note = s.stalePaneIds.length > 0
        ? '\nnote: terminal sessions do not survive pane closure/restart — persist results to files.'
        : '';
      return { content: [{ type: 'text', text: lines.join('\n') + note }], details: { terminals: s.terminals } };
    },
  });
}
