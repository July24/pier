/**
 * M14 terminal loader entry for the D78 mount tree and D81 responsibility split.
 * A Cordis loader plugin so the terminal surface stays hot-swappable: services provide the tombstone-aware
 * pi surface, the herdr client/environment and the state slot used by index GC; terminal-core holds the
 * pure, independently testable logic.
 */
import { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import type { PiSurface } from '../pi-surface.ts';
import type { HerdrClientLike } from '../herdr-client.ts';
import { herdrUnavailableHint } from '../herdr-client.ts';
import { toolError } from '../tool-error.ts'
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
  planShellInit,
  promptStrategyFor,
  registerTerminal,
  stripAnsi,
  summarizeSessions,
  terminalReminderGraceMs,
  validateSendText,
  validateSignal,
  type ReadCursor,
  type ReadinessTier,
  type TerminalEntry,
} from '../terminal-core.ts';
import { swallow } from '../swallow.ts';
import { pierOption } from '../pier-options.ts';

type ToolParams = Record<string, unknown> | undefined;

/** Terminal tool actions; the tool schema union and the handler map are both keyed by this list. */
const TERMINAL_ACTIONS = ['open', 'send', 'wait', 'read', 'signal', 'close', 'list'] as const;
type TerminalAction = (typeof TERMINAL_ACTIONS)[number];
type ActionHandler = (params: ToolParams, ctx: unknown) => Promise<unknown>;

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

  /* M14 resident terminal tools: dedicated herdr panes preserve shell state without reusing the pi TUI pane,
   * and active terminal panes remain exempt from index GC. Workers omit this master-side entry. */

  let terminals: TerminalEntry[] = [];

  function persistTerminals(): void {
    try {
      pi.appendEntry?.(TERMINALS_CUSTOM_TYPE, makeTerminalsRegistry(terminals));
    } catch (err) {
      swallow('terminal.persist-registry', err);
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

  state.activePaneIds = () => activeTerminalPaneIds(terminals);

  scoped.on('session_start', async (_event: unknown, eventCtx: unknown) => {
    rebuildTerminals(eventCtx);
  });
  scoped.on('session_tree', async (_event: unknown, eventCtx: unknown) => {
    rebuildTerminals(eventCtx);
  });

  // Session teardown (quit / Ctrl+D / SIGTERM) is the last chance to reclaim resident shells:
  // a master that exits without closing them leaks live zsh panes. Session SWITCH never fires this
  // event, so switching branches cannot kill shells that session_start replays from the registry.
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

  // Turn-end nudge: remind the model to close terminals idle past the threshold. Same delivery
  // shape as the todo stop reminder: grace window, cancel on agent_start, capped followUp.
  const piSend = surface.raw as {
    sendMessage?: (
      message: { customType: string; content: string; display?: boolean },
      opts?: { deliverAs?: string; triggerTurn?: boolean },
    ) => void;
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
    // Goodbye-loop guard: mark the covered terminals nudged NOW (persisted), and deliver the notice as a
    // queued followUp WITHOUT triggerTurn — a reminder must never wake the agent, or the loop never ends.
    const now = Date.now();
    const ids = new Set(plan.ids);
    terminals = terminals.map((t) => (ids.has(t.terminalId) ? { ...t, nudgedAt: now } : t));
    persistTerminals();
    idleReminders += 1;
    const content = plan.content;
    idleReminderTimer = setTimeout(() => {
      idleReminderTimer = null;
      const send = piSend.sendMessage;
      if (typeof send !== 'function') return;
      try {
        // Fire-and-forget in pi (void); a synchronous throw is still swallowed here.
        send(
          { customType: TERM_REMINDER_CUSTOM_TYPE, content, display: true },
          { deliverAs: 'followUp' },
        );
      } catch {
      }
    }, terminalReminderGraceMs());
    idleReminderTimer.unref?.();
  });

  const TERM_READ_MAX = Number(pierOption('PIER_TERM_READ_MAX') ?? READ_MAX_CHARS) || READ_MAX_CHARS;
  /** wait action: default and ceiling for the blocking output wait (an LLM call must not hang forever). */
  const WAIT_DEFAULT_MS = 120_000;
  const WAIT_MAX_MS = 600_000;
  /** wait action: recent-tail size handed back on timeout so the model can decide the next move. */
  const WAIT_TAIL_CHARS = 2_000;

  /** A1: a hard failure must throw (pi sets isError only for throws); non-failures stay results. */
  const fail = (msg: string): never => toolError(msg);

  // Action routing: each handler validates its own params, and `open` additionally needs the tool ctx.
  const handlers: Record<TerminalAction, ActionHandler> = {
    open: executeTerminalOpen,
    send: executeTerminalSend,
    wait: executeTerminalWait,
    read: executeTerminalRead,
    signal: executeTerminalSignal,
    close: executeTerminalClose,
    list: executeTerminalList,
  };

  scoped.registerTool({
    name: 'terminal',
    label: 'Terminal',
    description: [
      'Manage persistent interactive terminals (resident shells in dedicated herdr panes).',
      'Operations: open (create session), send (type commands), wait (block until output matches a pattern), read (capture output), signal (ctrl+c/ctrl+d/ctrl+z/esc/enter), close (kill shell), list (show all).',
      'The shell keeps cwd, environment variables, and background processes across calls.',
      'Long job pattern: send "cmd; echo TERM_DONE_$?" then wait with pattern "TERM_DONE_" — the sentinel also carries the exit code; redirect verbose output to a log file and read the file, because output between two reads is lost.',
    ].join(' '),
    promptSnippet: 'terminal: a persistent shell in its own pane — use for dev servers, REPLs, and multi-step shell work that must keep state between calls.',
    promptGuidelines: [
      'Prefer bash for one-shot commands: it is cheaper and returns output directly. Use terminal only when state must persist (server, REPL, watch loop, interactive prompt) or when you need to wait for output that appears later.',
      'Open once, then send/read/wait against the same terminal_id; do not open a new terminal per command.',
      'After send, read to confirm the command actually started. Multi-line text is executed line by line.',
      'wait is for output you expect (a sentinel, a startup line); it returns the recent tail on timeout so you can decide instead of re-polling.',
      'Close the terminal as soon as the work is done — a finished terminal keeps occupying a pane and is never auto-reclaimed.',
    ],
    parameters: Type.Object({
      action: Type.Union(TERMINAL_ACTIONS.map((name) => Type.Literal(name)), { description: 'Terminal operation to perform' }),
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
    async execute(_tc: string, params: ToolParams, _sig: AbortSignal | undefined, _upd: unknown, ctx: unknown) {
      const action = typeof params?.action === 'string' ? params.action : '';
      const handler: ActionHandler | undefined = handlers[action as TerminalAction];
      if (!handler) {
        const valid = TERMINAL_ACTIONS.join(', ');
        return fail(action
          ? `unknown action "${action}" (valid: ${valid})`
          : `action is required (${valid})`);
      }
      return handler(params, ctx);
    },
  });

  /** Probe whether the shell sits at its interactive prompt (advisory: probe failures degrade to 'busy'). */
  async function probeReadiness(paneId: string): Promise<ReadinessTier> {
    const prompt = promptStrategyFor();
    try {
      const waitRes = await client.waitForOutput(paneId, { type: 'regex', value: prompt.waitPattern }, READINESS_TIMEOUT_MS);
      if (waitRes.matched) return 'prompt';
      const read = await client.readPane(paneId, { stripAnsi: false });
      return classifyReadiness(stripAnsi(read.text), { silentMs: 0, prompt });
    } catch {
      return 'busy';
    }
  }

  /** Best-effort `set +H` right after a shell becomes usable (history expansion would wedge it);
   *  returns whether the command was injected, so a shell not yet at its prompt retries later. */
  async function injectShellInit(entry: TerminalEntry, readiness?: ReadinessTier): Promise<boolean> {
    const init = planShellInit({ strategy: promptStrategyFor(), readiness });
    if (!init.shouldInit || !init.command) return false;
    try {
      await client.sendPaneText(entry.paneId, init.command);
      return true;
    } catch {
      return false;
    }
  }

  async function executeTerminalOpen(params: ToolParams, ctx: unknown) {
    if (!client.available || !env) return fail('terminal tools require a herdr-managed pane');
    const cwd = typeof params?.cwd === 'string' && params.cwd ? params.cwd
      : (ctx as { cwd?: string }).cwd ?? process.cwd();
    const r = registerTerminal(terminals, {
      paneId: env.paneId, // Reserve a valid id until split returns the terminal pane.
      tabId: env.tabId,
      cwd,
      createdAt: Date.now(),
    });
    if (!r.ok) return fail(r.error);
    let paneId: string;
    try {
      paneId = await client.splitPane({ direction: 'right', cwd, focus: false, targetPaneId: env.paneId });
    } catch (e) {
      const hint = herdrUnavailableHint(e);
      return fail(hint ?? `failed to split terminal pane: ${(e as Error).message}`);
    }
    r.entry.paneId = paneId;
    terminals = r.entries;
    persistTerminals();
    const readiness = await probeReadiness(paneId);
    if (await injectShellInit(r.entry, readiness)) {
      r.entry.initialized = true;
      persistTerminals();
    }
    const text = [
      `terminal ${r.entry.terminalId} open (pane ${paneId})`,
      `cwd: ${cwd}`,
      `readiness: ${readiness}${readiness !== 'prompt' ? ' (prompt not detected yet — check with action read before sending)' : ''}`,
    ].join('\n');
    return { content: [{ type: 'text', text }], details: { terminal_id: r.entry.terminalId, pane_id: paneId, readiness } };
  }

  async function executeTerminalSend(params: ToolParams) {
    const entry = findOpenTerminal(params?.terminal_id);
    if (!entry) return fail(`unknown or closed terminal "${String(params?.terminal_id)}" (see action list)`);
    const v = validateSendText(typeof params?.text === 'string' ? params.text : '');
    if (!v.ok) return fail(v.error);
    if (!entry.initialized) {
      await injectShellInit(entry);
      entry.initialized = true;
      persistTerminals();
    }
    if (params?.wait_prompt === true) {
      // Orchestration convention: read before writing. Text typed while a previous command still owns the
      // foreground gets queued and fires later, which reads as "the shell ignored me"; refuse with the observed readiness.
      const readiness = await probeReadiness(entry.paneId);
      if (readiness !== 'prompt') {
        return fail(
          `shell is ${readiness === 'busy' ? 'busy (a previous command may still be running)' : 'silent (no prompt detected)'} — text was NOT sent. `
            + 'Use action read to inspect the pane, or omit wait_prompt to send anyway.',
        );
      }
    }
    try {
      await client.sendPaneText(entry.paneId, v.text);
    } catch (e) {
      // B5: a dead herdr socket would otherwise read as "pane may be closed", which sends the
      // model hunting for a pane that is fine. Prefer the actionable transport sentence.
      return fail(herdrUnavailableHint(e) ?? `send failed (pane may be closed): ${(e as Error).message}`);
    }
    touchTerminal(entry);
    return { content: [{ type: 'text', text: `sent to ${entry.terminalId} (${v.text.length} chars)` }], details: { terminal_id: entry.terminalId } };
  }

  async function executeTerminalWait(params: ToolParams) {
    const entry = findOpenTerminal(params?.terminal_id);
    if (!entry) return fail(`unknown or closed terminal "${String(params?.terminal_id)}" (see action list)`);
    const raw = typeof params?.pattern === 'string' ? params.pattern : '';
    if (!raw) return fail('pattern is required (literal text, or a regular expression with regex: true)');
    const useRegex = params?.regex === true;
    if (useRegex) {
      try {
        new RegExp(raw);
      } catch (e) {
        return fail(`invalid regex: ${(e as Error).message}`);
      }
    }
    const requested = typeof params?.timeout_ms === 'number' && params.timeout_ms > 0 ? params.timeout_ms : WAIT_DEFAULT_MS;
    const timeoutMs = Math.min(Math.max(requested, 1000), WAIT_MAX_MS);
    const matcher = useRegex ? { type: 'regex' as const, value: raw } : { type: 'substring' as const, value: raw };
    let waitResult: { matched: boolean; reason?: 'timeout' | 'unavailable' };
    try {
      waitResult = await client.waitForOutput(entry.paneId, matcher, timeoutMs);
    } catch (e) {
      return fail(herdrUnavailableHint(e) ?? `wait failed (pane may be closed): ${(e as Error).message}`);
    }
    if (!waitResult.matched) {
      // wait-for-text convention: on timeout, hand back the recent tail instead of re-polling blind.
      let tail = '';
      try {
        const read = await client.readPane(entry.paneId, { stripAnsi: false });
        tail = stripAnsi(read.text).slice(-WAIT_TAIL_CHARS);
      } catch {
      }
      const reason = waitResult.reason === 'timeout' ? 'timeout' : 'wait unavailable';
      return {
        content: [{ type: 'text', text: `no match within ${timeoutMs}ms (${reason}).${tail ? `\nrecent output tail:\n${tail}` : ''}` }],
        details: { terminal_id: entry.terminalId, matched: false, pattern: raw, reason },
      };
    }
    return {
      content: [{ type: 'text', text: `matched in ${entry.terminalId} — output is ready, use action read to inspect it` }],
      details: { terminal_id: entry.terminalId, matched: true, pattern: raw },
    };
  }

  /** T5: a direct `pane_id` read is limited to panes in this session's own tab or to self-created terminal
   *  panes, so one task can never read another's pane. Returns the error text instead of throwing. */
  async function resolveDirectPaneId(paneId: string): Promise<{ ok: true; paneId: string } | { ok: false; error: string }> {
    let panes;
    try {
      panes = await client.listPanes();
    } catch (e) {
      return { ok: false, error: herdrUnavailableHint(e) ?? `pane lookup failed: ${(e as Error).message}` };
    }
    const target = panes.find((p) => p.paneId === paneId);
    const ownTab = Boolean(target?.tabId) && target?.tabId === env?.tabId;
    if (!target || !(ownTab || activeTerminalPaneIds(terminals).has(paneId))) {
      return { ok: false, error: 'pane_id read is limited to panes in this session\'s own tab or self-created terminal panes' };
    }
    return { ok: true, paneId };
  }

  async function executeTerminalRead(params: ToolParams) {
    let paneId: string;
    let entry: TerminalEntry | null = null;
    if (typeof params?.terminal_id === 'string') {
      entry = findOpenTerminal(params.terminal_id);
      if (!entry) return fail(`unknown or closed terminal "${params.terminal_id}" (see action list)`);
      paneId = entry.paneId;
    } else if (typeof params?.pane_id === 'string') {
      const resolved = await resolveDirectPaneId(params.pane_id);
      if (!resolved.ok) return fail(resolved.error);
      paneId = resolved.paneId;
    } else {
      return fail('provide terminal_id (or pane_id for a direct own-tab read)');
    }
    const maxChars = typeof params?.max_chars === 'number' && params.max_chars > 0
      ? Math.min(params.max_chars, TERM_READ_MAX) : TERM_READ_MAX;
    let read: { text: string; revision: number; truncated: boolean };
    try {
      read = await client.readPane(paneId, { stripAnsi: false });
    } catch (e) {
      return fail(herdrUnavailableHint(e) ?? `read failed (pane may be closed): ${(e as Error).message}`);
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
        ? { revision: entry.readRevision, len: entry.readLen ?? 0, tail: entry.readTail ?? '', eoTail: entry.readEoTail ?? '' }
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

  async function executeTerminalSignal(params: ToolParams) {
    const entry = findOpenTerminal(params?.terminal_id);
    if (!entry) return fail(`unknown or closed terminal "${String(params?.terminal_id)}" (see action list)`);
    const v = validateSignal(typeof params?.key === 'string' ? params.key : '');
    if (!v.ok) return fail(v.error);
    try {
      await client.sendPaneKeys(entry.paneId, [v.key]);
    } catch (e) {
      return fail(herdrUnavailableHint(e) ?? `signal failed (pane may be closed): ${(e as Error).message}`);
    }
    touchTerminal(entry);
    return { content: [{ type: 'text', text: `signal ${v.key} sent to ${entry.terminalId}` }], details: { terminal_id: entry.terminalId, key: v.key } };
  }

  async function executeTerminalClose(params: ToolParams) {
    const id = params?.terminal_id;
    const entry = terminals.find((t) => t.terminalId === id);
    if (!entry) return fail(`unknown terminal "${String(id)}" (see action list)`);
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
    let livePanes: import('../herdr-client.ts').PaneListItem[] = [];
    try {
      livePanes = await client.listPanes();
    } catch {
      /* Treat a failed query as unknown rather than closed, because an empty live set only affects stale detection. */
    }
    const livePaneIds = livePanes.map((p) => p.paneId);
    const titleByPaneId = new Map<string, string>();
    for (const p of livePanes) {
      const cleanTitle = p.terminalTitleStripped ?? p.terminalTitle;
      if (cleanTitle) titleByPaneId.set(p.paneId, cleanTitle);
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
    const lines = s.terminals.map((t) => {
      const cleanTitle = titleByPaneId.get(t.paneId);
      const titleTag = cleanTitle && cleanTitle !== t.label ? ` title="${cleanTitle}"` : '';
      return `- ${t.terminalId} [${t.live ? 'open' : 'closed'}] pane=${t.paneId} cwd=${t.cwd}${t.label ? ` (${t.label})` : ''}${titleTag}`;
    });
    const note = s.stalePaneIds.length > 0
      ? '\nnote: terminal sessions do not survive pane closure/restart — persist results to files.'
      : '';
    return { content: [{ type: 'text', text: lines.join('\n') + note }], details: { terminals: s.terminals } };
  }
}
