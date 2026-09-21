import {
  boundText,
  computeSubagentOutputDelta,
  formatSubagentOutput,
  OUTPUT_DEFAULT_MAX_CHARS,
  OUTPUT_HARD_CAP_CHARS,
  resolveSubagentStatus,
  type SubagentOutputCursor,
} from './subagent-output-core.ts';
import type { HerdrAgentState, HerdrClientLike } from './herdr-client.ts';
import type { SubEntry } from './subagent-core.ts';
import { readSubagentOutput } from './subagent-output-adapter.ts';
import { toolError } from './tool-error.ts';
export interface OutputActionParams {
  agentId?: unknown;
  taskId?: unknown;
  max_chars?: unknown;
  maxChars?: unknown;
}

export interface OutputActionResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
}

export interface OutputActionDeps {
  client: HerdrClientLike;
  resolveEntry: (rawId: string, cwd: string) => { entry: SubEntry } | { error: string };
  readAskFlag: (paneId: string) => Promise<string | null>;
  outputCursors: Map<string, SubagentOutputCursor>;
  getCwd: (toolCtx: unknown) => string;
  /** Last finalized assistant text from the worker's session transcript. The pane read
   * alone cannot recover it when the fullscreen TUI surface shows only the status overlay
   * (01a0c282: every output poll returned the 306-char todo footer while the real report
   * sat in the transcript), so idle/settled polls fall back to this. Optional for tests. */
  readFinalReport?: (paneId: string, entryCwd: string) => Promise<string | null>;
}

export async function executeSubagentOutput(
  params: OutputActionParams | undefined,
  toolCtx: unknown,
  deps: OutputActionDeps,
): Promise<OutputActionResult> {
  const rawId = String(params?.agentId ?? params?.taskId ?? '').trim();
  if (!rawId) return toolError('Error: missing agentId for output (see action list)') as OutputActionResult;

  const cwd = deps.getCwd(toolCtx);
  const resolved = deps.resolveEntry(rawId, cwd);
  if ('error' in resolved) return toolError(resolved.error) as OutputActionResult;

  const entry = resolved.entry;
  let agentState: HerdrAgentState | null = null;
  let askFlag: string | null = null;
  try {
    const agents = await deps.client.listAgents();
    const agent = agents.find((candidate) => candidate.paneId === entry.paneId);
    agentState = agent?.status ?? null;
    askFlag = agent?.tokens?.['pi-ask'] ?? null;
  } catch {
    /* Best effort: output remains useful without live status. */
  }
  if (!askFlag && agentState === 'blocked') {
    try {
      askFlag = await deps.readAskFlag(entry.paneId);
    } catch {
      /* Best effort. */
    }
  }

  const status = resolveSubagentStatus({
    localStatus: entry.status,
    herdrStatus: agentState,
    hasAskFlag: Boolean(askFlag),
  });

  let rawRead: { text: string; revision: number; truncated: boolean };
  try {
    rawRead = await readSubagentOutput(deps.client, entry.paneId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(`Error: failed to read output for subagent ${entry.paneId}: ${message}`) as OutputActionResult;
  }

  const prevCursor = deps.outputCursors.get(entry.paneId);
  const maxChars = typeof params?.max_chars === 'number'
    ? params.max_chars
    : typeof params?.maxChars === 'number' ? params.maxChars : undefined;
  const deltaResult = computeSubagentOutputDelta(prevCursor, rawRead.text, { maxChars });
  deltaResult.nextCursor.reportTail ??= prevCursor?.reportTail;

  // Transcript fallback: a small worker pane is covered by the opaque status overlay, so the
  // terminal delta can be empty (or footer-only) while the finished report exists only in the
  // session file. Surface the latest finalized text once per distinct report.
  let reportSection: string | null = null;
  if ((status === 'settled' || status === 'idle') && deps.readFinalReport) {
    try {
      const report = await deps.readFinalReport(entry.paneId, entry.cwd);
      const fingerprint = report ? report.slice(-64) : '';
      if (report && fingerprint && fingerprint !== deltaResult.nextCursor.reportTail) {
        const bounded = boundText(
          report,
          Math.max(1, Math.min(maxChars ?? OUTPUT_DEFAULT_MAX_CHARS, OUTPUT_HARD_CAP_CHARS)),
        );
        reportSection = `[Subagent Report | latest finalized message from session transcript${bounded.truncated ? ' | truncated' : ''}]\n${bounded.text}`;
        deltaResult.nextCursor.reportTail = fingerprint;
      }
    } catch {
      /* Transcript unavailable — the pane delta above is still returned. */
    }
  }
  deps.outputCursors.set(entry.paneId, deltaResult.nextCursor);

  const formatted = formatSubagentOutput({
    paneId: entry.paneId,
    status,
    revision: rawRead.revision,
    bufferTruncated: rawRead.truncated,
    deltaResult,
    askQuestion: askFlag,
  });

  return {
    content: [{ type: 'text', text: reportSection ? `${formatted}\n${reportSection}` : formatted }],
    details: {
      paneId: entry.paneId,
      status,
      revision: rawRead.revision,
      truncated: rawRead.truncated || deltaResult.truncated,
      restart: deltaResult.restart,
      deltaLength: deltaResult.delta.length,
      reportDelivered: Boolean(reportSection),
    },
  };
}
