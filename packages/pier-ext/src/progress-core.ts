/**
 * M16 进度可见性纯核心（开发方案.md §M16；保守形态优先，D3 无新协议）。
 *
 * 承载通道（post-M22 世界）：
 *  - 进度徽标（N/M + 可选 ETA）→ pane title 内嵌（state_labels 键仅五态，进不了 label）；
 *  - 工具徽标（🔧 tool）→ report_agent.message；
 *  - 速率估算对齐 kimi 估算器语义：速率窗口、未完成 cap、置信度门。
 *
 * 保守原则（风险⑥拍板）：估算不可信时回退纯计数「N/M」，绝不显示误导性 ETA。
 */
import { countTodos, type TodoItem } from './vocab.ts';

/** ETA 需要的最少完成点数（<2 无法算速率）。 */
export const ETA_MIN_SAMPLES = 2;
/** 速率样本窗口（kimi rate window 语义；取最近 K 个完成点算速率）。 */
export const RATE_WINDOW_MS = 45_000;
/** 未完成进度显示上限（kimi unfinished cap 语义；防"快完了"假象）。 */
export const UNFINISHED_CAP = 0.85;
/** 完成点新鲜度门：最近完成点距今超过该值 → 数据陈旧，不估 ETA。 */
export const PROGRESS_STALE_MS = 5 * 60_000;
/** 速率拟合取最近 K 个完成点。 */
const RATE_SAMPLE_POINTS = 5;

export interface EtaEstimate {
  /** 剩余步数。 */
  remaining: number;
  /** 预计剩余时间（毫秒）。 */
  etaMs: number;
  confidence: 'ok';
}

/**
 * 速率估算：完成时间戳 → 剩余步数的 ETA。
 *  - 完成点 <2 → null（无速率可言）；
 *  - 最近完成点距今 > PROGRESS_STALE_MS → null（陈旧：爆发后停顿/人为搁置）；
 *  - 速率 = 取最近 K(≤5) 个点，(k-1) / (t_k - t_1)；eta = remaining / rate。
 */
export function estimateEta(opts: {
  completedAt: readonly number[];
  total: number;
  now: number;
}): EtaEstimate | null {
  const { completedAt, total, now } = opts;
  if (total <= 0) return null;
  const pts = [...completedAt].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const completed = pts.length;
  if (completed < ETA_MIN_SAMPLES) return null;
  if (now - pts[pts.length - 1] > PROGRESS_STALE_MS) return null;
  const remaining = total - completed;
  if (remaining <= 0) return { remaining: 0, etaMs: 0, confidence: 'ok' };
  const sample = pts.slice(-RATE_SAMPLE_POINTS);
  const span = sample[sample.length - 1] - sample[0];
  const steps = sample.length - 1;
  if (steps < 1 || span <= 0) return null;
  const ratePerMs = steps / span;
  return { remaining, etaMs: Math.round(remaining / ratePerMs), confidence: 'ok' };
}

/** title 进度后缀：保守 `3/7`；置信 ETA 时 `3/7 ~4m`；total=0 → 空串；全完成 `5/5 ✓`。 */
export function formatProgressSuffix(opts: {
  completed: number;
  total: number;
  eta: EtaEstimate | null;
}): string {
  const { completed, total, eta } = opts;
  if (total <= 0) return '';
  const base = completed >= total ? `${completed}/${total} ✓` : `${completed}/${total}`;
  if (!eta || eta.etaMs <= 0) return base;
  const human = eta.etaMs < 60_000 ? '<1m'
    : (() => {
      const mins = Math.ceil(eta.etaMs / 60_000);
      return mins < 60 ? `~${mins}m` : `~${Math.round((mins / 60) * 10) / 10}h`;
    })();
  return `${base} ${human}`;
}

/** 工具徽标（report_agent.message）：单工具名；多工具首 + 计数；空 → null（不覆盖）。 */
export function planToolBadge(runningToolNames: readonly string[]): string | null {
  if (runningToolNames.length === 0) return null;
  const first = runningToolNames[0];
  return runningToolNames.length === 1 ? `🔧 ${first}` : `🔧 ${first} +${runningToolNames.length - 1}`;
}

/** 从列表算进度输入（completed 计数 / total 开放计数）。 */
export function progressOf(items: readonly TodoItem[]): { completed: number; total: number } {
  const c = countTodos(items);
  const blockedCount = items.filter((it) => it.status === 'blocked').length;
  return { completed: c.completed, total: c.completed + c.pending + c.inProgress + blockedCount };
}

/** 进度徽标徽记整个生命周期后不再显示（防"完成态常驻"噪音；调用方比对用）。 */
export const PROGRESS_HIDE_MS = 60_000;

/**
 * 两份列表间的 completed 转换数（按 content 匹配；新列表中 completed 且旧状态非
 * completed —— 含新增即 completed 的条目）。M16 速率估算的原料：所有编辑路径
 * （todo_write / 人类编辑 / M17 对账）都过 TodosService，在此统一 diff。
 */
export function countCompletedTransitions(
  before: readonly TodoItem[],
  after: readonly TodoItem[],
): number {
  const oldStatus = new Map(before.map((it) => [it.content, it.status]));
  let n = 0;
  for (const it of after) {
    if (it.status === 'completed' && oldStatus.get(it.content) !== 'completed') n += 1;
  }
  return n;
}
