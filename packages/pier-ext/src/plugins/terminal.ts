/**
 * M14 terminal loader entry for the D78 mount tree and D81 responsibility split.
 * A Cordis loader plugin so the terminal surface stays hot-swappable: services provide the tombstone-aware
 * pi surface, the herdr client/environment and the state slot used by index GC; terminal-core holds the
 * pure, independently testable logic.
 */
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import { cordisGet } from '../cordis-services.ts';
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
  compilePattern,
  computeIncrement,
  classifyWaitMatch,
  detectContinuationPrompt,
  detectFullscreenTUI,
  echoSafeWaitSuggestion,
  excerptAroundMatch,
  foldTerminalsRegistry,
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
type ActionHandler = (params: ToolParams, ctx: unknown, signal?: AbortSignal) => Promise<unknown>;

/** File waits poll the log in-process; one tick per second keeps a 10-minute wait to ~600 reads. */
const FILE_WAIT_POLL_MS = 1000;
/** Only the log's tail is matched: a sentinel is the newest line, and a multi-GB log must not be read whole. */
const FILE_WAIT_TAIL_BYTES = 1024 * 1024;

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
  client: HerdrClientLike;
  env: { paneId: string; tabId: string } | null;
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

  /* M14 resident terminal tools: dedicated herdr panes preserve shell state without reusing the pi TUI pane,
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
          // A pane running a foreground job (dev server, REPL, load test) is in use even when the
          // last tool interaction is old: nudge only after it is back at a shell prompt.
          const info = await client.processInfo(t.paneId).catch(() => null);
          const busy = info?.shellPid != null
            && info.foreground.some((p) => p.pid != null && p.pid !== info.shellPid);
          return { ...t, busy };
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
      'Persistent interactive shells in dedicated herdr panes; cwd, environment and background processes survive across calls.',
      'Actions: open, send (type a command), wait (block until output matches), read, signal (ctrl+c/ctrl+d/ctrl+z/esc/enter), close, list.',
      'Long job: send "cmd; echo TERM_DONE_$?" and wait with regex "^TERM_DONE_[0-9]" — the shell echoes typed commands, so a literal "TERM_DONE_" would match its own echo. When output and sentinel go to a log ("cmd > run.log 2>&1; echo DONE_$? >> run.log"), wait with file: "run.log" instead of sleeping in bash.',
    ].join(' '),
    promptSnippet: 'terminal: a persistent shell in its own pane — use for dev servers, REPLs, and multi-step shell work that must keep state between calls.',
    promptGuidelines: [
      'Prefer bash for one-shot commands. Use terminal only when state must persist (server, REPL, watch loop, interactive prompt) or output appears later; open once and reuse the terminal_id.',
      'wait returns the recent tail on timeout, so decide from it instead of re-polling.',
      'Close the terminal when the work is done — it occupies a pane and is never auto-reclaimed.',
    ],
    parameters: Type.Object({
      action: Type.Union(TERMINAL_ACTIONS.map((name) => Type.Literal(name))),
      cwd: Type.Optional(Type.String({ description: '[open] Shell working directory (default: session cwd)' })),
      terminal_id: Type.Optional(Type.String({ description: '[open] Optional id for the new terminal (default term-N); [others] id returned by open' })),
      text: Type.Optional(Type.String({ description: '[send] Command text (Enter appended; multi-line runs line by line)' })),
      wait_prompt: Type.Optional(Type.Boolean({ description: '[send] Refuse instead of queueing when the shell is not at a prompt' })),
      pattern: Type.Optional(Type.String({ description: '[wait] Literal text or regex to wait for (must not occur in the sent command text)' })),
      file: Type.Optional(Type.String({ description: '[wait] Watch this log file instead of the pane (relative to the terminal cwd; may not exist yet)' })),
      regex: Type.Optional(Type.Boolean({ description: '[wait] pattern is a regex (default literal)' })),
      timeout_ms: Type.Optional(Type.Number({ description: '[wait] Default 120000, max 600000' })),
      pane_id: Type.Optional(Type.String({ description: '[read] Read another pane in your own tab' })),
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

  /** Best-effort history-expansion init right after a shell becomes usable (zsh needs
   *  `setopt NO_BANG_HIST`, bash `set +H`); returns whether the command was injected, so a shell not
   *  yet at its prompt retries later. */
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
      // Adopt the caller-requested id so `open {terminal_id}` + `send {terminal_id}` agree;
      // silently ignoring it made the follow-up send fail on an unknown terminal.
      terminalId: typeof params?.terminal_id === 'string' ? params.terminal_id : null,
      createdAt: Date.now(),
    });
    if (!r.ok) return fail(r.error);
    // Stack new terminals below the most recent one instead of halving the pi master pane again:
    // every right-split of the master shrinks both (45 → 22 → 11 columns), which breaks output
    // wrapping and multi-word waits. The first terminal still splits the master to the right.
    const anchor = [...terminals].reverse().find((t) => t.status === 'open') ?? null;
    const targetPaneId = anchor?.paneId ?? env.paneId;
    const direction = anchor ? 'down' : 'right';
    let paneId: string;
    try {
      paneId = await client.splitPane({ direction, cwd, focus: false, targetPaneId });
    } catch (e) {
      if (!anchor) {
        const hint = herdrUnavailableHint(e);
        return fail(hint ?? `failed to split terminal pane: ${(e as Error).message}`);
      }
      // A terminal restored from an earlier session can point at a pane herdr no longer has: fall
      // back to the master instead of failing to open at all.
      try {
        paneId = await client.splitPane({ direction: 'right', cwd, focus: false, targetPaneId: env.paneId });
      } catch (fallbackError) {
        const hint = herdrUnavailableHint(fallbackError);
        return fail(hint ?? `failed to split terminal pane: ${(fallbackError as Error).message}`);
      }
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
      if (await injectShellInit(entry)) {
        entry.initialized = true;
        persistTerminals();
      }
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
    // In-memory only (never persisted): the wait echo-hazard check needs the text this pane last
    // received, because the shell echoes typed commands back into the pane.
    lastSentText.set(entry.terminalId, v.text);
    touchTerminal(entry);
    // An incomplete command leaves the shell at a secondary prompt (`dquote>`, `heredoc>`, …):
    // every later send is swallowed by it, so surface the wedge instead of reporting success.
    let pending: string | null = null;
    try {
      const snapshot = await client.readPane(entry.paneId, { stripAnsi: false });
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
    const hint = redirectedSentinel(v.text);
    const fileHint = hint
      ? `\nnote: the sentinel ${hint.prefix}$? is written to ${hint.file}, not the pane — wait for it with `
        + `terminal(action: "wait", terminal_id: "${entry.terminalId}", file: "${hint.file}", pattern: "${echoSafeWaitSuggestion(hint.prefix) ?? hint.prefix}", regex: true) instead of sleeping.`
      : '';
    return { content: [{ type: 'text', text: `sent to ${entry.terminalId} (${v.text.length} chars)${fileHint}` }], details: { terminal_id: entry.terminalId } };
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
        return fail(`invalid regex: ${(e as Error).message}`);
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
      // A wait that consumed its budget is a timeout even when the failing RPC reports itself as
      // unavailable: the distinction tells the model whether to re-check the command or the server.
      const consumedBudget = Date.now() - started >= timeoutMs * 0.95;
      const reason = waitResult.reason === 'timeout' || consumedBudget ? 'timeout' : 'wait unavailable';
      return {
        content: [{ type: 'text', text: `no match within ${timeoutMs}ms (${reason}).${tail ? `\nrecent output tail:\n${tail}` : ''}` }],
        details: { terminal_id: entry.terminalId, matched: false, pattern: raw, reason },
      };
    }
    // herdr matches the whole pane, including text a prior read already returned, and a second
    // waitForOutput on that same text returns immediately. After a stale hit, poll the unread
    // increment until a new occurrence appears or the original budget is gone — do not re-enter
    // waitForOutput (that busy-loops on the old match).
    const deadline = started + timeoutMs;
    const cursor: ReadCursor | null = entry.readRevision != null
      ? {
        revision: entry.readRevision,
        len: entry.readLen ?? 0,
        tail: entry.readTail ?? '',
        textLen: entry.readTextLen ?? 0,
        textHash: entry.readTextHash ?? 0,
      }
      : null;
    const shown = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
    let sawStale = false;
    const staleFailure = {
      content: [{ type: 'text' as const, text: `pattern "${shown}" matched only in already-read output of ${entry.terminalId}; no new output contains it. This is not a new event — do not treat the job as finished. Wait for a marker that has not appeared yet, or use action read.` }],
      details: { terminal_id: entry.terminalId, matched: false, stale: true, pattern: raw },
    };
    while (true) {
      let paneText = '';
      try {
        const read = await client.readPane(entry.paneId, { stripAnsi: false });
        paneText = stripAnsi(read.text);
      } catch {
        if (sawStale) return staleFailure;
        return {
          content: [{ type: 'text', text: `matched in ${entry.terminalId} — output is ready, use action read to inspect it` }],
          details: { terminal_id: entry.terminalId, matched: true, pattern: raw },
        };
      }
      const classified = classifyWaitMatch(cursor, paneText, raw, useRegex);
      if (classified.kind === 'fresh') {
        return {
          content: [{ type: 'text', text: `matched in ${entry.terminalId} — new output contains the pattern:\n${classified.excerpt}` }],
          details: { terminal_id: entry.terminalId, matched: true, pattern: raw },
        };
      }
      if (classified.kind !== 'stale') {
        return {
          content: [{ type: 'text', text: `matched in ${entry.terminalId} — output is ready, use action read to inspect it` }],
          details: { terminal_id: entry.terminalId, matched: true, pattern: raw },
        };
      }
      sawStale = true;
      const left = deadline - Date.now();
      if (left <= 0) return staleFailure;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, Math.min(400, left));
      await promise;
    }
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
        ? {
          revision: entry.readRevision,
          len: entry.readLen ?? 0,
          tail: entry.readTail ?? '',
          textLen: entry.readTextLen ?? 0,
          textHash: entry.readTextHash ?? 0,
        }
        : null)
      : null;
    const inc = computeIncrement(prev, { text: read.text, revision: read.revision }, maxChars);
    if (entry) {
      entry.readRevision = inc.cursor.revision;
      entry.readLen = inc.cursor.len;
      entry.readTail = inc.cursor.tail;
      entry.readTextLen = inc.cursor.textLen;
      entry.readTextHash = inc.cursor.textHash;
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
    lastSentText.delete(entry.terminalId);
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
