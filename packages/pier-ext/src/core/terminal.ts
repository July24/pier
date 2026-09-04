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
  TERM_REMINDER_CUSTOM_TYPE,
  TERMINALS_CUSTOM_TYPE,
  activeTerminalPaneIds,
  classifyReadiness,
  closeTerminal,
  computeIncrement,
  detectFullscreenTUI,
  foldTerminalsRegistry,
  makeTerminalsRegistry,
  planIdleTerminalReminder,
  promptStrategyFor,
  registerTerminal,
  stripAnsi,
  summarizeSessions,
  terminalReminderGraceMs,
  validateSendText,
  validateSignal,
  type ReadCursor,
  type TerminalEntry,
} from '../terminal-core.ts';

export interface TerminalStateSlot {
  /** Lets index GC preserve panes that host active terminals. */
  activePaneIds: () => Set<string>;
}

interface TerminalDeps {
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

  // Session teardown (quit / Ctrl+D / SIGTERM) is the last chance to reclaim resident shells:
  // terminals are persistent by design, so a master that exits without closing them leaks live
  // zsh panes. Session SWITCH never fires this event (only session_start/session_tree), so
  // switching branches cannot kill shells that the registry replays on the next session_start.
  scoped.on('session_shutdown', async () => {
    idleReminderTimer && clearTimeout(idleReminderTimer);
    idleReminderTimer = null;
    const open = terminals.filter((t) => t.status === 'open');
    if (open.length === 0) return;
    await Promise.allSettled(open.map((t) => client.closePane(t.paneId)));
    const now = Date.now();
    terminals = terminals.map((t) =>
      t.status === 'open' ? { ...t, status: 'closed' as const, closedAt: now } : t,
    );
    persistTerminals();
  });

  // Turn-end nudge: remind the model to close terminals idle past the threshold (wF:p7 orphan —
  // a one-shot background compile left a dead split in the main tab forever). Same delivery
  // shape as the todo stop reminder: grace window, cancel on agent_start, capped followUp.
  const piSend = surface.raw as {
    sendMessage?: (
      message: { customType: string; content: string; display?: boolean },
      opts?: { deliverAs?: string; triggerTurn?: boolean },
    ) => Promise<void>;
  };
  let idleReminders = 0;
  let idleReminderTimer: NodeJS.Timeout | null = null;
  scoped.on('agent_start', () => {
    if (idleReminderTimer !== null) {
      clearTimeout(idleReminderTimer);
      idleReminderTimer = null;
    }
  });
  scoped.on('agent_settled', async () => {
    if (idleReminderTimer !== null) {
      clearTimeout(idleReminderTimer);
      idleReminderTimer = null;
    }
    const plan = planIdleTerminalReminder({
      open: terminals.filter((t) => t.status === 'open'),
      now: Date.now(),
      reminders: idleReminders,
    });
    if (!plan.due || plan.content == null) return;
    // 01a06ae3 goodbye-loop: mark the covered terminals nudged NOW (persisted), and deliver the
    // notice as a queued followUp WITHOUT triggerTurn — a reminder alone must never wake the
    // agent, or a farewell exchange loops: wake → polite goodbye → settle → nudge → wake …
    const now = Date.now();
    const ids = new Set(plan.ids);
    terminals = terminals.map((t) => (ids.has(t.terminalId) ? { ...t, nudgedAt: now } : t));
    persistTerminals();
    idleReminders += 1;
    const content = plan.content;
    idleReminderTimer = setTimeout(() => {
      idleReminderTimer = null;
      void (async () => {
        const send = piSend.sendMessage;
        if (typeof send !== 'function') return;
        try {
          await send(
            { customType: TERM_REMINDER_CUSTOM_TYPE, content, display: true },
            { deliverAs: 'followUp' },
          );
        } catch {
          /* Delivery failure is non-fatal; the cap already bounds retries. */
        }
      })();
    }, terminalReminderGraceMs());
    idleReminderTimer.unref?.();
  });

  const TERM_READ_MAX = Number(process.env.PI_HERDR_TERM_READ_MAX ?? READ_MAX_CHARS) || READ_MAX_CHARS;
  /** wait action: default and ceiling for the blocking output wait (an LLM call must not hang forever). */
  const WAIT_DEFAULT_MS = 120_000;
  const WAIT_MAX_MS = 600_000;
  /** wait action: recent-tail size handed back on timeout so the model can decide the next move. */
  const WAIT_TAIL_CHARS = 2_000;

  const errText = (msg: string) => ({ content: [{ type: 'text' as const, text: `Error: ${msg}` }], details: {} });

  scoped.registerTool({
    name: 'terminal',
    label: 'Terminal',
    description: [
      'Manage persistent interactive terminals (resident shells in dedicated herdr panes).',
      'Operations: open (create session), send (type commands), wait (block until output matches a pattern), read (capture output), signal (ctrl+c/ctrl+d/ctrl+z/esc/enter), close (kill shell), list (show all).',
      'The shell keeps cwd, environment variables, and background processes across calls.',
      'Use for dev servers, REPLs, or multi-step shell work — not one-shot bash calls.',
      'Close a terminal with action: "close" as soon as the work in it is done — finished terminals are never auto-reclaimed and keep occupying a pane.',
      'Long job pattern: send "cmd; echo TERM_DONE_$?" then wait with pattern "TERM_DONE_" — the sentinel also carries the exit code; redirect verbose output to a log file and read the file, because output between two reads is lost.',
      'After send, use read to confirm the command actually started; multi-line text executes line-by-line. send(wait_prompt: true) refuses to queue text while a previous command is still running.',
    ].join(' '),
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('open'),
        Type.Literal('send'),
        Type.Literal('wait'),
        Type.Literal('read'),
        Type.Literal('signal'),
        Type.Literal('close'),
        Type.Literal('list'),
      ], { description: 'Terminal operation to perform' }),
      cwd: Type.Optional(Type.String({ description: '[open] Working directory for the shell (defaults to session cwd)' })),
      terminal_id: Type.Optional(Type.String({ description: '[send|wait|read|signal|close] Terminal id returned by open action' })),
      text: Type.Optional(Type.String({ description: '[send] Command text to type and run (Enter appended automatically)' })),
      wait_prompt: Type.Optional(Type.Boolean({ description: '[send] Verify the shell is back at a prompt before sending; refuses with the detected readiness instead of queueing text behind a running command' })),
      pattern: Type.Optional(Type.String({ description: '[wait] Literal text or regular expression to wait for in pane output' })),
      regex: Type.Optional(Type.Boolean({ description: '[wait] Treat pattern as a regular expression (default: literal substring)' })),
      timeout_ms: Type.Optional(Type.Number({ description: '[wait] Give up after this many ms (default 120000, max 600000)' })),
      pane_id: Type.Optional(Type.String({ description: '[read] Direct pane read (limited to own tab panes only)' })),
      max_chars: Type.Optional(Type.Number({ description: '[read] Output cap for this read (default 10000)' })),
      key: Type.Optional(Type.String({ description: '[signal] Control key: ctrl+c | ctrl+d | ctrl+z | esc | enter' })),
    }),
    async execute(_tc, params, _sig, _upd, ctx) {
      const action = typeof params?.action === 'string' ? params.action : '';
      switch (action) {
        case 'open': return executeTerminalOpen(params, ctx);
        case 'send': return executeTerminalSend(params);
        case 'wait': return executeTerminalWait(params);
        case 'read': return executeTerminalRead(params);
        case 'signal': return executeTerminalSignal(params);
        case 'close': return executeTerminalClose(params);
        case 'list': return executeTerminalList();
        default:
          return errText(action
            ? `unknown action "${action}" (valid: open, send, wait, read, signal, close, list)`
            : 'action is required (open, send, wait, read, signal, close, list)');
      }
    },
  });

  /** Probe whether the shell sits at its interactive prompt (advisory: probe failures degrade to 'busy'). */
  async function probeReadiness(paneId: string): Promise<'prompt' | 'silent' | 'busy'> {
    const prompt = promptStrategyFor();
    try {
      const matched = await client.waitForOutput(paneId, { type: 'regex', value: prompt.waitPattern }, READINESS_TIMEOUT_MS);
      if (matched) return 'prompt';
      const read = await client.readPane(paneId, { stripAnsi: false });
      return classifyReadiness(stripAnsi(read.text), { silentMs: 0, prompt });
    } catch {
      /* Readiness is advisory, so probe failures still leave a usable terminal. */
      return 'busy';
    }
  }

  async function executeTerminalOpen(params, ctx) {
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
    const readiness = await probeReadiness(paneId);
    const text = [
      `terminal ${r.entry.terminalId} open (pane ${paneId})`,
      `cwd: ${cwd}`,
      `readiness: ${readiness}${readiness !== 'prompt' ? ' (prompt not detected yet — check with action read before sending)' : ''}`,
    ].join('\n');
    return { content: [{ type: 'text', text }], details: { terminal_id: r.entry.terminalId, pane_id: paneId, readiness } };
  }

  async function executeTerminalSend(params) {
    const entry = findOpenTerminal(params?.terminal_id);
    if (!entry) return errText(`unknown or closed terminal "${String(params?.terminal_id)}" (see action list)`);
    const v = validateSendText(typeof params?.text === 'string' ? params.text : '');
    if (!v.ok) return errText(v.error);
    if (params?.wait_prompt === true) {
      // Orchestration convention: read before writing. Text typed while a previous command still
      // owns the foreground gets queued and fires later, which reads as "the shell ignored me".
      // Refuse with the observed readiness instead of guessing.
      const readiness = await probeReadiness(entry.paneId);
      if (readiness !== 'prompt') {
        return errText(
          `shell is ${readiness === 'busy' ? 'busy (a previous command may still be running)' : 'silent (no prompt detected)'} — text was NOT sent. `
            + 'Use action read to inspect the pane, or omit wait_prompt to send anyway.',
        );
      }
    }
    try {
      await client.sendPaneText(entry.paneId, v.text);
    } catch (e) {
      return errText(`send failed (pane may be closed): ${(e as Error).message}`);
    }
    touchTerminal(entry);
    return { content: [{ type: 'text', text: `sent to ${entry.terminalId} (${v.text.length} chars)` }], details: { terminal_id: entry.terminalId } };
  }

  async function executeTerminalWait(params) {
    const entry = findOpenTerminal(params?.terminal_id);
    if (!entry) return errText(`unknown or closed terminal "${String(params?.terminal_id)}" (see action list)`);
    const raw = typeof params?.pattern === 'string' ? params.pattern : '';
    if (!raw) return errText('pattern is required (literal text, or a regular expression with regex: true)');
    const useRegex = params?.regex === true;
    if (useRegex) {
      try {
        new RegExp(raw);
      } catch (e) {
        return errText(`invalid regex: ${(e as Error).message}`);
      }
    }
    const requested = typeof params?.timeout_ms === 'number' && params.timeout_ms > 0 ? params.timeout_ms : WAIT_DEFAULT_MS;
    const timeoutMs = Math.min(Math.max(requested, 1000), WAIT_MAX_MS);
    const matcher = useRegex ? { type: 'regex' as const, value: raw } : { type: 'substring' as const, value: raw };
    let matched: boolean | null;
    try {
      matched = await client.waitForOutput(entry.paneId, matcher, timeoutMs);
    } catch (e) {
      return errText(`wait failed (pane may be closed): ${(e as Error).message}`);
    }
    if (matched !== true) {
      // wait-for-text convention: on timeout, hand back the recent tail so the model can decide
      // the next move instead of re-polling blind.
      let tail = '';
      try {
        const read = await client.readPane(entry.paneId, { stripAnsi: false });
        tail = stripAnsi(read.text).slice(-WAIT_TAIL_CHARS);
      } catch {
        /* The pane is gone; the timeout text alone still tells the model it is stuck. */
      }
      const reason = matched === false ? 'no match' : 'wait unavailable';
      return {
        content: [{ type: 'text', text: `no match within ${timeoutMs}ms (${reason}).${tail ? `\nrecent output tail:\n${tail}` : ''}` }],
        details: { terminal_id: entry.terminalId, matched: false, pattern: raw },
      };
    }
    return {
      content: [{ type: 'text', text: `matched in ${entry.terminalId} — output is ready, use action read to inspect it` }],
      details: { terminal_id: entry.terminalId, matched: true, pattern: raw },
    };
  }

  async function executeTerminalRead(params) {
    let paneId: string | null = null;
    let entry: TerminalEntry | null = null;
    if (typeof params?.terminal_id === 'string') {
      entry = findOpenTerminal(params.terminal_id);
      if (!entry) return errText(`unknown or closed terminal "${params.terminal_id}" (see action list)`);
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
  }

  async function executeTerminalSignal(params) {
    const entry = findOpenTerminal(params?.terminal_id);
    if (!entry) return errText(`unknown or closed terminal "${String(params?.terminal_id)}" (see action list)`);
    const v = validateSignal(typeof params?.key === 'string' ? params.key : '');
    if (!v.ok) return errText(v.error);
    try {
      await client.sendPaneKeys(entry.paneId, [v.key]);
    } catch (e) {
      return errText(`signal failed (pane may be closed): ${(e as Error).message}`);
    }
    touchTerminal(entry);
    return { content: [{ type: 'text', text: `signal ${v.key} sent to ${entry.terminalId}` }], details: { terminal_id: entry.terminalId, key: v.key } };
  }

  async function executeTerminalClose(params) {
    const id = params?.terminal_id;
    const entry = terminals.find((t) => t.terminalId === id);
    if (!entry) return errText(`unknown terminal "${String(id)}" (see action list)`);
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
  }

  async function executeTerminalList() {
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
      return { content: [{ type: 'text', text: 'no terminals (open one with action open)' }], details: { terminals: [] } };
    }
    const lines = s.terminals.map((t) =>
      `- ${t.terminalId} [${t.live ? 'open' : 'closed'}] pane=${t.paneId} cwd=${t.cwd}${t.label ? ` (${t.label})` : ''}`,
    );
    const note = s.stalePaneIds.length > 0
      ? '\nnote: terminal sessions do not survive pane closure/restart — persist results to files.'
      : '';
    return { content: [{ type: 'text', text: lines.join('\n') + note }], details: { terminals: s.terminals } };
  }
}
