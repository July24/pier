/**
 * M18 file write-lock installer (soft veto / hard block).
 *
 * Why: lock acquire/release/command lived in the composition root next to
 * unrelated session wiring. The installer owns the three pi hooks and the
 * held-lock set; fail-open on agent.list remains the collaboration policy.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  acquireTokensFor,
  isLockTokenKey,
  parseLockTokenValue,
  planWriteGuard,
  releaseTokensFor,
  type LockAgentView,
} from './lock-core.ts';
import type { HerdrClientLike, HerdrEnv } from './herdr-client.ts';

export function installWriteLocks(
  pi: ExtensionAPI,
  opts: {
    client: HerdrClientLike;
    env: HerdrEnv | null;
    hard: boolean;
  },
): void {
  const { client, env, hard } = opts;
  const heldLocks = new Set<string>();
  const lockWarnByToolCall = new Map<string, string>();

  async function acquireLocks(paths: readonly string[]): Promise<void> {
    for (const p of paths) heldLocks.add(p);
    await client.reportLockTokens(acquireTokensFor(paths, env?.paneId ?? ''));
  }

  pi.on('tool_call', async (event: { toolName?: string; toolCallId?: string; input?: unknown }, ctx: { cwd?: string }) => {
    if (!client.available || !env) return;
    const cwd = ctx?.cwd ?? process.cwd();
    let agents: LockAgentView[];
    try {
      agents = (await client.listAgents()).map((a) => ({ paneId: a.paneId, tokens: a.tokens }));
    } catch {
      return;
    }
    const plan = planWriteGuard({
      toolName: event.toolName ?? '',
      input: event.input,
      agents,
      ownPaneId: env.paneId,
      cwd,
      hard,
    });
    if (plan.kind === 'skip') return;
    if (plan.kind === 'block') {
      return { block: true, reason: plan.reason };
    }
    if (plan.kind === 'warn' && typeof event.toolCallId === 'string') {
      lockWarnByToolCall.set(event.toolCallId, plan.warning);
    }
    await acquireLocks(plan.paths);
  });

  pi.on('tool_result', async (event: { toolCallId?: string; content?: Array<{ type: string; text: string }> }) => {
    if (typeof event?.toolCallId !== 'string') return;
    const warning = lockWarnByToolCall.get(event.toolCallId);
    if (!warning) return;
    lockWarnByToolCall.delete(event.toolCallId);
    const content = Array.isArray(event.content) ? event.content : [];
    return { content: [...content, { type: 'text', text: warning }] };
  });

  pi.on('agent_settled', async () => {
    if (heldLocks.size === 0) return;
    const paths = [...heldLocks];
    heldLocks.clear();
    await client.reportLockTokens(releaseTokensFor(paths));
  });

  pi.registerCommand('locks', {
    description: 'Show write locks held by this pane and all live panes (M18)',
    handler: async (_args, ctx) => {
      const ui = (ctx as { ui?: { notify?: (text: string, level?: string) => void } }).ui;
      const mine = [...heldLocks];
      const lines = [`held by this pane (${mine.length}):`];
      lines.push(...(mine.length ? mine.map((p) => `  ${p}`) : ['  (none)']));
      lines.push('all live locks:');
      let any = false;
      try {
        for (const a of await client.listAgents()) {
          for (const [k, v] of Object.entries(a.tokens)) {
            if (!isLockTokenKey(k) || typeof v !== 'string' || !v) continue;
            const parsed = parseLockTokenValue(v);
            if (!parsed) continue;
            any = true;
            lines.push(`  ${parsed.path} → pane ${parsed.holderPaneId}`);
          }
        }
      } catch {
        lines.push('  (agent.list failed)');
      }
      if (!any && lines[lines.length - 1] !== '  (agent.list failed)') lines.push('  (none)');
      ui?.notify?.(lines.join('\n'), 'info');
    },
  });
}
