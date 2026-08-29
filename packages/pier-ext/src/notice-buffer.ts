/**
 * D92 settlement-notice collapser (pure half of the followup-flood fix).
 *
 * Why: `sendUserMessage(followUp)` only delivers when the agent has no more
 * tool calls, so a long master run queues every settlement and floods at the
 * end. Buffer while busy; collapse at turn_end. The other half is the index
 * notice buffer.
 */
export const NOTICE_MAX_SHOWN = 3;

/**
 * Collapse a batch into one message body.
 * - empty → null (do not inject)
 * - ≤max → originals joined with `\n\n` (single-item byte-identical to the old format)
 * - >max → first max originals + a tail pointing at history / list_agents
 */
export function collapseNotices(contents: readonly string[], max = NOTICE_MAX_SHOWN): string | null {
  if (contents.length === 0) return null;
  if (contents.length <= max) return contents.join('\n\n');
  const hidden = contents.length - max;
  const tail = `…另有 ${hidden} 条结算未逐条展示。全量结果看 history 台账（路径公式见 resume_subagent 工具描述）；在跑代理用 list_agents 查看。`;
  return [...contents.slice(0, max), tail].join('\n\n');
}
