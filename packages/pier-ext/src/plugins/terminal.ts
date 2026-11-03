/**
 * M14 terminal loader entry for the D78 mount tree and D81 responsibility split.
 * A Cordis loader plugin so the terminal surface stays hot-swappable: services provide the tombstone-aware
 * pi surface, the herdr-core client/environment and the state slot used by index GC; terminal-core holds the
 * pure, independently testable logic.
 */
import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import { cordisGet } from '../cordis-services.ts';
import {
  childEnvironment,
  coreUnavailableHint,
  isCoreErrorKind,
  type CoreClientLike,
  type CoreEnv,
  type TerminalInfo,
} from '../core-client.ts';
import { toolError } from '../tool-error.ts'
import {
  READ_MAX_CHARS,
  TERM_REMINDER_CUSTOM_TYPE,
  TERMINALS_CUSTOM_TYPE,
  activeTerminalPaneIds,
  closeTerminal,
  compilePattern,
  computeIncrement,
  classifyWaitMatch,
  detectContinuationPrompt,
  detectFullscreenTUI,
  echoSafeWaitSuggestion,
  excerptAroundMatch,
  foldTerminalsRegistry,
  foregroundIsShell,
  makeTerminalsRegistry,
  planTerminalReminder,
  planShellInit,
  promptStrategyFor,
  regexLiteralPrefix,
  redirectedSentinel,
  registerTerminal,
  sentinelEchoHazard,
  stripAnsi,
  summarizeSessions,
  terminalReminderGraceMs,
  TRUNCATE_MARKER,
  validateSendText,
  validateSignal,
  withExitSentinel,
  parseExitSentinel,
  type ReadCursor,
  type TerminalEntry,
} from '../terminal-core.ts';
import { swallow } from '../swallow.ts';
import { pierOption } from '../pier-options.ts';

type ToolParams = Record<string, unknown> | undefined;

/** Terminal tool actions; the tool schema union and the handler map are both keyed by this list. */
const TERMINAL_ACTIONS = ['open', 'send', 'wait', 'read', 'signal', 'close', 'list'] as const;
type TerminalAction = (typeof TERMINAL_ACTIONS)[number];
type ActionHandler = (params: ToolParams, ctx: unknown, signal?: AbortSignal) => Promise<unknown>;

/** File waits poll the log in-process; one tick per second keeps a 10-minute wait to ~600 reads. */
const FILE_WAIT_POLL_MS = 1000;
/** Only the log's tail is matched: a sentinel is the newest line, and a multi-GB log must not be read whole. */
const FILE_WAIT_TAIL_BYTES = 1024 * 1024;
/** Core waits on substrings only; a regex wait polls the screen at this interval instead. */
const REGEX_WAIT_POLL_MS = 400;
/** History above the screen for the read action and regex waits: the same window keeps the read
 *  cursor aligned, so a stale/fresh classification compares like with like. */
const SCREEN_HISTORY_LINES = 200;
/** History above the screen returned as the timeout tail, so a model sees more than one screenful. */
const WAIT_TAIL_LINES = 100;

/** The last `maxBytes` of a file as UTF-8, or null when it does not exist (yet). */
async function readFileTail(path: string, maxBytes: number): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

export interface TerminalStateSlot {
  /** Lets index GC preserve panes that host active terminals. */
  activePaneIds: () => Set<string>;
}

export interface TerminalDeps {
  client: CoreClientLike;
  /** This process's own terminal address; null outside a herdr-core terminal. */
  env: CoreEnv | null;
  state: TerminalStateSlot;
}

export default function terminalPlugin(ctx: Context): void {
  const surface = cordisGet(ctx, 'pi-herdr.surface');
  const { client, env, state } = cordisGet(ctx, 'pi-herdr.terminal-deps');
  const pi = surface.raw as {
    appendEntry?: (customType: string, data: unknown) => void;
  };
  // Keying the surface by this file lets HMR tombstone and replace exactly this registration.
  const scoped = surface.forModule(import.meta.url);

  /* M14 resident terminal tools: dedicated core terminals preserve shell state without reusing the pi surface,
   * and active terminal panes remain exempt from index GC. Workers omit this master-side entry. */

  let terminals: TerminalEntry[] = [];

  /** Last text sent per terminal (in-memory): lets `wait` refuse patterns that match their own echo. */
  const lastSentText = new Map<string, string>();

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
  // a master that exits without closing them leaks live shell terminals. Session SWITCH never fires this
  // event, so switching branches cannot kill shells that session_start replays from the registry.
  scoped.on('session_shutdown', async () => {
    idleReminderTimer && clearTimeout(idleReminderTimer);
    idleReminderTimer = null;
    const open = terminals.filter((t) => t.status === 'open');
    if (open.length === 0) return;
    await Promise.allSettled(open.map(async (t) => {
      await client.kill(t.paneId);
      await client.remove(t.paneId);
    }));
    const now = Date.now();
    terminals = terminals.map((t) =>
      t.status === 'open' ? { ...t, status: 'closed' as const, closedAt: now } : t,
    );
    persistTerminals();
  });

  // Turn-end nudge: remind the model to close terminals it just used, then once more after the idle
  // threshold. Same delivery shape as the todo stop reminder: grace window, cancel on agent_start,
  // capped per terminal.
  const piSend = surface.raw as {
    sendMessage?: (
      message: { customType: string; content: string; display?: boolean },
      opts?: { deliverAs?: string; triggerTurn?: boolean },
    ) => void;
  };
  /** Start of the current agent run; terminals touched since then count as "used this turn". */
  let turnStartedAt: number | null = null;
  let idleReminderTimer: NodeJS.Timeout | null = null;
  scoped.on('agent_start', () => {
    turnStartedAt = Date.now();
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
    const open = await Promise.all(
      terminals
        .filter((t) => t.status === 'open')
        .map(async (t) => {
          // A terminal running a foreground job (dev server, REPL, load test) is in use even when the
          // last tool interaction is old: nudge only after the shell itself owns the PTY again.
          const info = await client.getTerminal(t.paneId).catch(() => null);
          return { ...t, busy: info?.foreground != null && !foregroundIsShell(info.foreground) };
        }),
    );
    const plan = planTerminalReminder({
      open,
      now: Date.now(),
      turnStartedAt,
    });
    turnStartedAt = null;
    if (!plan.due || plan.content == null) return;
    // Deliver the notice as a queued followUp WITHOUT triggerTurn — a reminder must never wake the
    // agent. The per-terminal count is bumped only when the timer fires: agent_start cancels the
    // grace timer, and a cancelled reminder must not consume one of the two allowed nudges.
    const content = plan.content;
    idleReminderTimer = setTimeout(() => {
      idleReminderTimer = null;
      const send = piSend.sendMessage;
      if (typeof send !== 'function') return;
      const now = Date.now();
      const ids = new Set(plan.ids);
      terminals = terminals.map((t) => (ids.has(t.terminalId) && t.status === 'open'
        ? { ...t, nudges: (t.nudges ?? (t.nudgedAt != null ? 1 : 0)) + 1, nudgedAt: now }
        : t));
      persistTerminals();
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
  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
      'Persistent interactive shells in dedicated Herdr terminals; cwd, environment and background processes survive across calls.',
      'Actions: open, send (type a command), wait (block until output matches), read, signal (ctrl+c/ctrl+d/ctrl+z/esc/enter), close, list.',
      'A command that finishes: send with wait: true — it returns the exit code and the output, no sentinel needed. Output that appears without the command ending (a server\'s "listening on"): wait with pattern. A job logging to a file: wait with file instead of sleeping in bash.',
    ].join(' '),
    promptSnippet: 'terminal: a persistent shell in its own Herdr pane — use for dev servers, REPLs, and multi-step shell work that must keep state between calls.',
    promptGuidelines: [
      'Prefer bash for one-shot commands. Use terminal only when state must persist (server, REPL, watch loop, interactive prompt) or output appears later; open once and reuse the terminal_id.',
      'send with wait: true returns when the command ends; wait returns the recent tail on timeout — decide from it instead of re-polling.',
      'Close the terminal when the work is done — it occupies a pane and is never auto-reclaimed.',
    ],
    parameters: Type.Object({
      action: Type.Union(TERMINAL_ACTIONS.map((name) => Type.Literal(name))),
      cwd: Type.Optional(Type.String({ description: '[open] Shell working directory (default: session cwd)' })),
      terminal_id: Type.Optional(Type.String({ description: '[open] Optional id for the new terminal (default term-N); [others] id returned by open' })),
      text: Type.Optional(Type.String({ description: '[send] Command text (Enter appended; multi-line runs line by line)' })),
      wait: Type.Optional(Type.Boolean({ description: '[send] Block until the command finishes; returns its exit code and output (pier appends the exit sentinel)' })),
      pattern: Type.Optional(Type.String({ description: '[wait] Literal text or regex to wait for (must not occur in the sent command text)' })),
      file: Type.Optional(Type.String({ description: '[wait] Watch this log file instead of the terminal (relative to its cwd; may not exist yet)' })),
      regex: Type.Optional(Type.Boolean({ description: '[wait] pattern is a regex (default literal)' })),
      timeout_ms: Type.Optional(Type.Number({ description: '[wait, send wait] Default 120000, max 600000' })),
      max_chars: Type.Optional(Type.Number({ description: `[read] Output cap (default ${READ_MAX_CHARS})` })),
      key: Type.Optional(Type.String({ description: '[signal] ctrl+c | ctrl+d | ctrl+z | esc | enter' })),
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
      return handler(params, ctx, _sig);
    },
  });

  /** Best-effort history-expansion init right after a shell starts (zsh needs `setopt NO_BANG_HIST`,
   *  bash `set +H`); core's send waits for the screen to settle, so no prompt probe is needed. Returns
   *  whether the command went out, so a failed attempt retries on the next send. */
  async function injectShellInit(entry: TerminalEntry): Promise<boolean> {
    const init = planShellInit({ strategy: promptStrategyFor() });
    if (!init.shouldInit || !init.command) return false;
    try {
      await client.send(entry.paneId, init.command);
      return true;
    } catch {
      return false;
    }
  }

  async function executeTerminalOpen(params: ToolParams, ctx: unknown) {
    if (!client.available || !env) return fail('terminal tools require a herdr-core terminal (HC_TERMINAL_SOCKET/HC_TERMINAL_ID)');
    const cwd = typeof params?.cwd === 'string' && params.cwd ? params.cwd
      : (ctx as { cwd?: string }).cwd ?? process.cwd();
    const r = registerTerminal(terminals, {
      paneId: '', // Reserved until core returns the new terminal address.
      tabId: '',
      cwd,
      // Adopt the caller-requested id so `open {terminal_id}` + `send {terminal_id}` agree;
      // silently ignoring it made the follow-up send fail on an unknown terminal.
      terminalId: typeof params?.terminal_id === 'string' ? params.terminal_id : null,
      createdAt: Date.now(),
    });
    if (!r.ok) return fail(r.error);
    let info: TerminalInfo;
    try {
      // Keep the child in this terminal's app tab: the app adopts a terminal carrying the same
      // herdr.space/herdr.tab labels as a pane and never steals focus from the pi master.
      const labels = await client.placementLabels();
      info = await client.run({
        cwd,
        env: childEnvironment(process.env, {}),
        labels,
        noNotify: true,
      });
    } catch (e) {
      return fail(coreUnavailableHint(e) ?? `failed to open shell: ${errText(e)}`);
    }
    r.entry.paneId = info.id;
    r.entry.tabId = info.labels['herdr.tab'] ?? '';
    terminals = r.entries;
    persistTerminals();
    if (await injectShellInit(r.entry)) {
      r.entry.initialized = true;
      persistTerminals();
    }
    const text = [
      `terminal ${r.entry.terminalId} open (pane ${info.id})`,
      `cwd: ${cwd}`,
    ].join('\n');
    return { content: [{ type: 'text', text }], details: { terminal_id: r.entry.terminalId, pane_id: info.id, status: info.status } };
  }

  async function executeTerminalSend(params: ToolParams, _ctx?: unknown, signal?: AbortSignal) {
    const entry = findOpenTerminal(params?.terminal_id);
    if (!entry) return fail(`unknown or closed terminal "${String(params?.terminal_id)}" (see action list)`);
    const v = validateSendText(typeof params?.text === 'string' ? params.text : '');
    if (!v.ok) return fail(v.error);
    if (!entry.initialized) {
      if (await injectShellInit(entry)) {
        entry.initialized = true;
        persistTerminals();
      }
    }
    // wait: true needs the screen as it was before the send, so the result holds only this run's output.
    let before: ReadCursor | null = null;
    const nonce = params?.wait === true ? randomBytes(4).toString('hex') : null;
    const text = nonce === null ? v.text : withExitSentinel(v.text, nonce, promptStrategyFor());
    if (nonce !== null) {
      try {
        before = computeIncrement(null, { text: stripAnsi((await client.read(entry.paneId, { lines: SCREEN_HISTORY_LINES })).text) }, 1).cursor;
      } catch {
        /* No baseline: the whole screen counts as this run's output. */
      }
    }
    try {
      await client.send(entry.paneId, text);
    } catch (e) {
      if (isCoreErrorKind(e, 'blocked')) {
        return fail(
          `terminal ${entry.terminalId} is blocked — its program is waiting for input, so the text was NOT sent. `
            + 'Read the pane and answer the prompt first. '
            + `(${errText(e)})`,
        );
      }
      // A dead core socket would otherwise read as "pane may be closed", which sends the
      // model hunting for a pane that is fine. Prefer the actionable transport sentence.
      return fail(coreUnavailableHint(e) ?? `send failed (terminal may be closed): ${errText(e)}`);
    }
    // In-memory only (never persisted): the wait echo-hazard check needs the text this pane last
    // received, because the shell echoes typed commands back into the pane.
    lastSentText.set(entry.terminalId, text);
    touchTerminal(entry);
    // An incomplete command leaves the shell at a secondary prompt (`dquote>`, `heredoc>`, …):
    // every later send is swallowed by it, so surface the wedge instead of reporting success.
    let pending: string | null = null;
    try {
      const snapshot = await client.read(entry.paneId);
      pending = detectContinuationPrompt(stripAnsi(snapshot.text));
    } catch {
      /* A pane read is advisory here: a transport failure must not turn a successful send into an error. */
    }
    if (pending) {
      return fail(
        `shell is waiting for more input (${pending}) — the sent command left an incomplete quote, heredoc, or block, `
          + 'and later text is swallowed by that continuation prompt. Send the missing terminator, or interrupt with '
          + 'terminal(action: "signal", key: "ctrl+c"), then re-send a complete command.',
      );
    }
    if (nonce !== null) return awaitExitSentinel(entry, nonce, before, params, signal);
    const hint = redirectedSentinel(v.text);
    const fileHint = hint
      ? `\nnote: the sentinel ${hint.prefix}$? is written to ${hint.file}, not the pane — wait for it with `
        + `terminal(action: "wait", terminal_id: "${entry.terminalId}", file: "${hint.file}", pattern: "${echoSafeWaitSuggestion(hint.prefix) ?? hint.prefix}", regex: true) instead of sleeping.`
      : '';
    return { content: [{ type: 'text', text: `sent to ${entry.terminalId} (${v.text.length} chars)${fileHint}` }], details: { terminal_id: entry.terminalId } };
  }

  /** `send` with `wait: true`: poll the screen until this run's sentinel prints, then hand back the
   *  exit status and the output since the send. The read cursor moves past it, so a later `read`
   *  does not repeat it; on timeout it stays, and the returned `wait` call picks the run up. */
  async function awaitExitSentinel(entry: TerminalEntry, nonce: string, before: ReadCursor | null, params: ToolParams, signal?: AbortSignal) {
    const requested = typeof params?.timeout_ms === 'number' && params.timeout_ms > 0 ? params.timeout_ms : WAIT_DEFAULT_MS;
    const timeoutMs = Math.min(Math.max(requested, 1000), WAIT_MAX_MS);
    const started = Date.now();
    let screen = '';
    while (true) {
      try {
        screen = stripAnsi((await client.read(entry.paneId, { lines: SCREEN_HISTORY_LINES })).text);
      } catch (e) {
        return fail(coreUnavailableHint(e) ?? `wait failed (terminal may be closed): ${errText(e)}`);
      }
      const inc = computeIncrement(before, { text: screen }, screen.length + 1);
      const run = parseExitSentinel(inc.mode === 'none' ? '' : inc.text, nonce);
      if (run) {
        storeReadCursor(entry, computeIncrement(readCursorOf(entry), { text: screen }, 1).cursor);
        const output = run.output.length > TERM_READ_MAX ? `${TRUNCATE_MARKER}\n${run.output.slice(-TERM_READ_MAX)}` : run.output;
        const status = run.exitCode === null ? 'finished (no exit code)' : `exit ${run.exitCode}`;
        return {
          content: [{ type: 'text', text: `${status} in ${entry.terminalId} after ${Math.round((Date.now() - started) / 1000)}s${output ? `:\n${output}` : ' (no output)'}` }],
          details: { terminal_id: entry.terminalId, exit_code: run.exitCode },
        };
      }
      const left = started + timeoutMs - Date.now();
      if (left <= 0 || signal?.aborted) break;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, Math.min(REGEX_WAIT_POLL_MS, left));
      await promise;
    }
    const reason = signal?.aborted ? 'aborted' : 'timeout';
    return {
      content: [{
        type: 'text',
        text: `still running in ${entry.terminalId} after ${Math.round((Date.now() - started) / 1000)}s (${reason}) — do NOT re-send it. Keep waiting with `
          + `terminal(action: "wait", terminal_id: "${entry.terminalId}", pattern: "^__PIER_${nonce}_[0-9]*__$", regex: true), or interrupt with signal ctrl+c.`
          + `${screen ? `\nrecent output tail:\n${screen.slice(-WAIT_TAIL_CHARS)}` : ''}`,
      }],
      details: { terminal_id: entry.terminalId, exit_code: null, reason },
    };
  }

  /** `read` and a finished `send` wait are the cursor's writers. */
  function storeReadCursor(entry: TerminalEntry, cursor: ReadCursor): void {
    entry.readLen = cursor.len;
    entry.readTail = cursor.tail;
    entry.readTextLen = cursor.textLen;
    entry.readTextHash = cursor.textHash;
    touchTerminal(entry);
  }

  async function executeTerminalWait(params: ToolParams, _ctx?: unknown, signal?: AbortSignal) {
    const entry = findOpenTerminal(params?.terminal_id);
    if (!entry) return fail(`unknown or closed terminal "${String(params?.terminal_id)}" (see action list)`);
    // Waiting on a pane is use: keep it out of the "used this turn" cleanup nudge at settle.
    touchTerminal(entry);
    const raw = typeof params?.pattern === 'string' ? params.pattern : '';
    if (!raw) return fail('pattern is required (literal text, or a regular expression with regex: true)');
    const useRegex = params?.regex === true;
    if (useRegex) {
      try {
        compilePattern(raw);
      } catch (e) {
        return fail(`invalid regex: ${errText(e)}`);
      }
    }
    if (typeof params?.file === 'string' && params.file.trim()) {
      const file = params.file.trim();
      const path = file.startsWith('~/') ? resolvePath(homedir(), file.slice(2)) : resolvePath(entry.cwd, file);
      return waitForFile(entry, path, raw, useRegex, params, signal);
    }
    // The shell echoes typed commands into the pane, so a pattern contained in the last sent text
    // matches its own echo and "succeeds" instantly, before the job finishes (observed: a
    // minutes-long batch matched in 112ms on the echo of its own `echo SENTINEL`).
    if (sentinelEchoHazard({ pattern: raw, regex: useRegex, lastSentText: lastSentText.get(entry.terminalId) })) {
      const shown = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
      const literal = useRegex ? regexLiteralPrefix(raw) : raw;
      const suggestion = echoSafeWaitSuggestion(literal);
      const advice = suggestion
        ? `For future sends, use a sentinel distinguishable from its echo: send \`cmd; echo ${literal}$?\` and wait with regex "${suggestion}" `
          + '(the echoed command shows `$?`, which that regex cannot match).'
        : 'For future sends, use a sentinel distinguishable from its echo: send `cmd; echo DONE_$?` and wait with regex "^DONE_[0-9]" '
          + '(the echo contains `DONE_$?`, which that regex cannot match).';
      return fail(
        `pattern "${shown}" also appears in the command text sent to ${entry.terminalId} — the shell echoes typed commands, `
        + 'so the wait would match its own echo and return before the job finishes. '
        + 'That command is still running: do NOT re-send it (text typed behind a running command just queues). '
        + 'Watch progress with action read, or wait for a marker the running command itself prints that does not occur in the command text. '
        + advice,
      );
    }
    const requested = typeof params?.timeout_ms === 'number' && params.timeout_ms > 0 ? params.timeout_ms : WAIT_DEFAULT_MS;
    const timeoutMs = Math.min(Math.max(requested, 1000), WAIT_MAX_MS);
    const started = Date.now();
    // Core matches substrings only; keep the documented regex form by polling the screen.
    if (useRegex) return waitForRegex(entry, raw, timeoutMs);
    let waitResult: { matched: boolean; reason?: 'timeout' | 'unavailable' };
    try {
      waitResult = await client.waitForOutput(entry.paneId, raw, timeoutMs);
    } catch (e) {
      return fail(coreUnavailableHint(e) ?? `wait failed (terminal may be closed): ${errText(e)}`);
    }
    if (!waitResult.matched) {
      // wait-for-text convention: on timeout, hand back the recent tail instead of re-polling blind.
      const tail = await readRecent(entry, WAIT_TAIL_LINES);
      // A wait that consumed its budget is a timeout even when the failing RPC reports itself as
      // unavailable: the distinction tells the model whether to re-check the command or the server.
      const consumedBudget = Date.now() - started >= timeoutMs * 0.95;
      const reason = waitResult.reason === 'timeout' || consumedBudget ? 'timeout' : 'wait unavailable';
      return {
        content: [{ type: 'text', text: `no match within ${timeoutMs}ms (${reason}).${tail ? `\nrecent output tail:\n${tail.slice(-WAIT_TAIL_CHARS)}` : ''}` }],
        details: { terminal_id: entry.terminalId, matched: false, pattern: raw, reason },
      };
    }
    // Core only reports output printed after the wait starts, so a hit is already fresh.
    const recent = await readRecent(entry, WAIT_TAIL_LINES);
    const excerpt = recent.includes(raw) ? excerptAroundMatch(recent, raw, false) : '';
    return {
      content: [{ type: 'text', text: `matched in ${entry.terminalId} — new output contains the pattern${excerpt ? `:\n${excerpt}` : '; use action read to inspect it'}` }],
      details: { terminal_id: entry.terminalId, matched: true, pattern: raw },
    };
  }

  /** Cursor from this terminal's last `read`; null until the screen has been read. */
  function readCursorOf(entry: TerminalEntry): ReadCursor | null {
    const textLen = entry.readTextLen ?? 0;
    if (textLen === 0 && !entry.readTail) return null;
    return {
      len: entry.readLen ?? 0,
      tail: entry.readTail ?? '',
      textLen,
      textHash: entry.readTextHash ?? 0,
    };
  }

  /** Recent screen text (history above the live screen), ANSI stripped; empty when the read fails. */
  async function readRecent(entry: TerminalEntry, lines: number): Promise<string> {
    try {
      return stripAnsi((await client.read(entry.paneId, { lines })).text);
    } catch {
      return '';
    }
  }

  /** Core has no regex wait. Poll the screen and reuse the read cursor so a pattern already returned
   *  by `read` stays stale instead of completing the same job twice. */
  async function waitForRegex(entry: TerminalEntry, pattern: string, timeoutMs: number) {
    const regex = compilePattern(pattern);
    const cursor = readCursorOf(entry);
    const shown = pattern.length > 80 ? `${pattern.slice(0, 80)}…` : pattern;
    const staleFailure = {
      content: [{ type: 'text' as const, text: `pattern "${shown}" matched only in already-read output of ${entry.terminalId}; no new output contains it. This is not a new event — do not treat the job as finished. Wait for a marker that has not appeared yet, or use action read.` }],
      details: { terminal_id: entry.terminalId, matched: false, stale: true, pattern },
    };
    let sawStale = false;
    let text = '';
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        text = stripAnsi((await client.read(entry.paneId, { lines: SCREEN_HISTORY_LINES })).text);
      } catch (e) {
        if (sawStale) return staleFailure;
        return fail(coreUnavailableHint(e) ?? `wait failed (terminal may be closed): ${errText(e)}`);
      }
      if (regex.test(text)) {
        const classified = classifyWaitMatch(cursor, text, pattern, true);
        if (classified.kind === 'fresh') {
          return {
            content: [{ type: 'text', text: `matched in ${entry.terminalId} — new output contains the pattern:\n${classified.excerpt}` }],
            details: { terminal_id: entry.terminalId, matched: true, pattern },
          };
        }
        if (classified.kind === 'stale') sawStale = true;
        else {
          return {
            content: [{ type: 'text', text: `matched in ${entry.terminalId} — output is ready, use action read to inspect it` }],
            details: { terminal_id: entry.terminalId, matched: true, pattern },
          };
        }
      }
      const left = deadline - Date.now();
      if (left <= 0) break;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, Math.min(REGEX_WAIT_POLL_MS, left));
      await promise;
    }
    if (sawStale) return staleFailure;
    return {
      content: [{ type: 'text', text: `no match within ${timeoutMs}ms (timeout).${text ? `\nrecent output tail:\n${text.slice(-WAIT_TAIL_CHARS)}` : ''}` }],
      details: { terminal_id: entry.terminalId, matched: false, pattern, reason: 'timeout' },
    };
  }

  /** `wait` on a log file: the sentinel of a redirected job never reaches the pane. A match already in
   *  the file when the wait starts returns at once, labelled, so a leftover from an earlier run is visible. */
  async function waitForFile(
    entry: TerminalEntry,
    path: string,
    pattern: string,
    useRegex: boolean,
    params: ToolParams,
    signal: AbortSignal | undefined,
  ) {
    const requested = typeof params?.timeout_ms === 'number' && params.timeout_ms > 0 ? params.timeout_ms : WAIT_DEFAULT_MS;
    const timeoutMs = Math.min(Math.max(requested, 1000), WAIT_MAX_MS);
    const started = Date.now();
    const matches = (text: string) => (useRegex ? compilePattern(pattern).test(text) : text.includes(pattern));
    let text: string | null = null;
    let wake: (() => void) | null = null;
    const onAbort = () => wake?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for (let tick = 0; ; tick += 1) {
        text = await readFileTail(path, FILE_WAIT_TAIL_BYTES);
        if (text !== null && matches(text)) {
          const when = tick === 0 ? 'already present when the wait started (truncate the log per run if this is an old one)' : `appeared after ${Math.round((Date.now() - started) / 1000)}s`;
          return {
            content: [{ type: 'text', text: `matched in ${path} — ${when}:\n${excerptAroundMatch(text, pattern, useRegex)}` }],
            details: { terminal_id: entry.terminalId, matched: true, pattern, file: path, alreadyPresent: tick === 0 },
          };
        }
        const left = started + timeoutMs - Date.now();
        if (left <= 0 || signal?.aborted) break;
        const { promise, resolve } = Promise.withResolvers<void>();
        wake = resolve;
        const timer = setTimeout(resolve, Math.min(FILE_WAIT_POLL_MS, left));
        await promise;
        clearTimeout(timer);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    const reason = signal?.aborted ? 'aborted' : 'timeout';
    const tail = text === null ? `\n${path} does not exist.` : text ? `\nrecent file tail:\n${text.slice(-WAIT_TAIL_CHARS)}` : `\n${path} is empty.`;
    return {
      content: [{ type: 'text', text: `no match in ${path} within ${timeoutMs}ms (${reason}).${tail}` }],
      details: { terminal_id: entry.terminalId, matched: false, pattern, file: path, reason },
    };
  }

  async function executeTerminalRead(params: ToolParams) {
    if (typeof params?.terminal_id !== 'string') return fail('provide terminal_id');
    const entry = findOpenTerminal(params.terminal_id);
    if (!entry) return fail(`unknown or closed terminal "${params.terminal_id}" (see action list)`);
    const paneId = entry.paneId;
    const maxChars = typeof params?.max_chars === 'number' && params.max_chars > 0
      ? Math.min(params.max_chars, TERM_READ_MAX) : TERM_READ_MAX;
    let read: { text: string; complete: boolean };
    try {
      read = await client.read(paneId, { lines: SCREEN_HISTORY_LINES });
    } catch (e) {
      return fail(coreUnavailableHint(e) ?? `read failed (terminal may be closed): ${errText(e)}`);
    }
    // T6 inspects raw output because ANSI stripping would erase alternate-screen evidence. Core's
    // `complete` is broader (requested history may be missing), so it stays a detail, not a trigger.
    const tui = detectFullscreenTUI(read.text);
    if (tui.detected) {
      const head = stripAnsi(read.text).slice(0, 200);
      const text = [
        'FULLSCREEN_TUI_DETECTED: this terminal is running a fullscreen program (e.g. vim/less/top); its screen output is not readable here.',
        'Suggestions:',
        '1. Run such programs where a human can interact directly (the Herdr app), not through this tool.',
        '2. Use non-interactive alternatives (cat/grep instead of less; edit/write tools instead of vim).',
        `Raw head (first 200 chars): ${head}`,
      ].join('\n');
      return { content: [{ type: 'text', text }], details: { error: 'FULLSCREEN_TUI_DETECTED' } };
    }
    // Cursor and output are both ANSI-stripped, so a wait's fresh/stale classification compares like
    // with like (`read` is the only writer of the cursor).
    const screen = stripAnsi(read.text);
    const inc = computeIncrement(readCursorOf(entry), { text: screen }, maxChars);
    storeReadCursor(entry, inc.cursor);
    if (inc.mode === 'none') {
      return { content: [{ type: 'text', text: 'no new output' }], details: { mode: 'none', complete: read.complete } };
    }
    const output = inc.text;
    const text = output.length ? output : '(empty)';
    return {
      content: [{ type: 'text', text }],
      details: { mode: inc.mode, hard_capped: inc.hardCapped, complete: read.complete },
    };
  }

  async function executeTerminalSignal(params: ToolParams) {
    const entry = findOpenTerminal(params?.terminal_id);
    if (!entry) return fail(`unknown or closed terminal "${String(params?.terminal_id)}" (see action list)`);
    const v = validateSignal(typeof params?.key === 'string' ? params.key : '');
    if (!v.ok) return fail(v.error);
    // ctrl+c is the tool's interrupt: core picks the reporting-aware stop key and reports what it saw.
    if (v.key === 'ctrl+c') {
      let outcome: string;
      try {
        outcome = await client.interrupt(entry.paneId);
      } catch (e) {
        return fail(coreUnavailableHint(e) ?? `interrupt failed (terminal may be closed): ${errText(e)}`);
      }
      touchTerminal(entry);
      const meaning = outcome === 'stopped' ? 'the program stopped'
        : outcome === 'exited' ? 'the program exited'
          : outcome === 'still_working' ? 'the program is still working'
            : 'the outcome is unknown';
      return {
        content: [{ type: 'text', text: `interrupt (ctrl+c) sent to ${entry.terminalId}: ${meaning}` }],
        details: { terminal_id: entry.terminalId, key: v.key, outcome },
      };
    }
    try {
      await client.keys(entry.paneId, [v.key]);
    } catch (e) {
      return fail(coreUnavailableHint(e) ?? `signal failed (terminal may be closed): ${errText(e)}`);
    }
    touchTerminal(entry);
    return { content: [{ type: 'text', text: `signal ${v.key} sent to ${entry.terminalId}` }], details: { terminal_id: entry.terminalId, key: v.key } };
  }

  async function executeTerminalClose(params: ToolParams) {
    const id = params?.terminal_id;
    const entry = terminals.find((t) => t.terminalId === id);
    if (!entry) return fail(`unknown terminal "${String(id)}" (see action list)`);
    if (entry.status === 'open') {
      // kill then rm: core refuses to remove a live terminal. Either step may have been done by a
      // person or with the app's tab; record the terminal as closed anyway.
      try {
        await client.kill(entry.paneId);
      } catch {
      }
      try {
        await client.remove(entry.paneId);
      } catch {
      }
    }
    terminals = closeTerminal(terminals, entry.terminalId, Date.now()).entries;
    lastSentText.delete(entry.terminalId);
    persistTerminals();
    return { content: [{ type: 'text', text: `terminal ${entry.terminalId} closed` }], details: { terminal_id: entry.terminalId } };
  }

  async function executeTerminalList() {
    let live: TerminalInfo[] = [];
    try {
      live = await client.listTerminals();
    } catch {
      /* Treat a failed query as unknown rather than closed, because an empty live set only affects stale detection. */
    }
    const livePaneIds = live.map((t) => t.id);
    const titleByPaneId = new Map<string, string>();
    for (const t of live) {
      if (t.title) titleByPaneId.set(t.id, t.title);
    }
    const s = summarizeSessions(terminals, livePaneIds);
    // T6 check 3: record vanished terminals as closed across restarts rather than reviving them; tell the user to persist state.
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
