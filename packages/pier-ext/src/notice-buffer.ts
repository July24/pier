/**
 * D92 结算通知折叠器（followup 堆积修复的纯函数半）。
 *
 * 背景：结算通知原走 pi.sendUserMessage(deliverAs:'followUp')——pi 语义是
 * 「agent 没有更多 tool call 时才投递」= 整个 run 结束才回填。master 长任务
 * 执行中 N 个 subagent 结算/失败重启，通知全攒在队列里，run 结束瞬间洪水灌入。
 *
 * 修复分两半（另一半在 index.ts 接线）：
 *  - 忙时入扩展自己的缓冲，turn_end（LLM 迭代边界）以 steer 折叠批量注入；
 *  - 单次注入最多展示 max 条全文，其余收进尾行（全量走 history 台账/list_agents）。
 */

/** 折叠展示的最大条数（用户拍板：最多 3 条）。 */
export const NOTICE_MAX_SHOWN = 3;

/**
 * 把一批通知折叠成单条消息体。
 * - 空 → null（不注入）
 * - ≤max 条 → 原文逐条（\n\n 连接），不套任何包装（单条时与旧格式逐字节一致）
 * - >max 条 → 前 max 条原文 + 尾行汇总（指向 history 台账 / list_agents 查全量）
 */
export function collapseNotices(contents: readonly string[], max = NOTICE_MAX_SHOWN): string | null {
  if (contents.length === 0) return null;
  if (contents.length <= max) return contents.join('\n\n');
  const hidden = contents.length - max;
  const tail = `…另有 ${hidden} 条结算未逐条展示。全量结果看 history 台账（路径公式见 resume_subagent 工具描述）；在跑代理用 list_agents 查看。`;
  return [...contents.slice(0, max), tail].join('\n\n');
}
