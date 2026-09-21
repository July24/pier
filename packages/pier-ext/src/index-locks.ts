/** M18 file write-lock installer (soft veto / hard block): owns the three pi hooks and the
 *  held-lock set; fail-open on agent.list is the collaboration policy. */
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

export interface WriteLocksHandle {
  getHeldLocks: () => readonly string[];
}

export function installWriteLocks(
  pi: ExtensionAPI,
  opts: {
    client: HerdrClientLike;
    env: HerdrEnv | null;
    hard: boolean;
  },
): WriteLocksHandle {
  const { client, env, hard } = opts;
  const heldLocks = new Set<string>();
  const lockWarnByToolCall = new Map<string, string>();

  if (!client.available || !env) {
    return { getHeldLocks: () => [] };
  }

  async function acquireLocks(paths: readonly string[]): Promise<void> {
    for (const p of paths) heldLocks.add(p);
    await client.reportLockTokens(acquireTokensFor(paths, env?.paneId ?? ''));
  }

  pi.on('tool_call', async (event: { toolName?: string; toolCallId?: string; input?: unknown }, ctx: { cwd?: string }) => {
    if (!client.available || !env) return;
    const cwd = ctx?.cwd ?? process.cwd();
    let agents: LockAgentView[];
    let ownForegroundCwd: string | null = null;
    try {
      const liveAgents = await client.listAgents();
      agents = liveAgents.map((a) => ({ paneId: a.paneId, tokens: a.tokens }));
      const me = liveAgents.find((a) => a.paneId === env.paneId);
      if (me?.foregroundCwd) {
        ownForegroundCwd = me.foregroundCwd;
      }
    } catch {
      return;
    }
    const effectiveCwd = ownForegroundCwd ?? cwd;
    const plan = planWriteGuard({
      toolName: event.toolName ?? '',
      input: event.input,
      agents,
      ownPaneId: env.paneId,
      cwd: effectiveCwd,
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

  pi.on('tool_result', async (event: unknown) => {
    const rec = (event ?? {}) as { toolCallId?: unknown; content?: unknown };
    if (typeof rec.toolCallId !== 'string') return;
    const warning = lockWarnByToolCall.get(rec.toolCallId);
    if (!warning) return;
    lockWarnByToolCall.delete(rec.toolCallId);
    const content = Array.isArray(rec.content) ? rec.content as Array<{ type: 'text'; text: string }> : [];
    return { content: [...content, { type: 'text' as const, text: warning }] };
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

  return { getHeldLocks: () => [...heldLocks] };
}
