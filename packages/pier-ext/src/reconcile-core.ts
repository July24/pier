/**
 * M17：todo↔subagent 自动对账纯规划器（开发方案.md §M17；P2 = 低置信度不勾+提示）。
 *
 * 时机（adapter）：主控收到结算 push（pollLoop / pipe reply）后、注入 followUp 前。
 * 语义（对齐 omp reconcileTodosWithSubagents）：
 *  - 匹配：description ↔ todo.content，norm（小写+空白折叠）后 exact → prefix（双向）
 *    → substring，与 D38 fuzzyFind 同族；
 *  - 自动勾：仅 settled 且最优档唯一且 ∈ {exact, prefix}，一次结算至多一条；
 *  - 解锁：blocker ↔ description 同档匹配（exact/prefix）的 blocked 条目回 pending
 *    （可多条；failed/低置信度不解锁）；
 *  - 低置信度/歧义/失败：不动列表，noteLines 随结算通知提示（P2 拍板）；
 *  - 落盘：edits 走 D38 权威路径（pi-herdr.todo-edit custom 条目，分支回放生效）。
 */
import { applyTodoEdits, type TodoEdit, type TodoItem } from './todo-core.ts';

export type ReconcileOutcome = 'settled' | 'failed';
export type MatchTier = 'exact' | 'prefix' | 'substring' | null;

export interface ReconcilePlan {
  /** 应用 edits 后的列表（无编辑 = 原引用）。 */
  items: TodoItem[];
  /** 经权威路径持久化的编辑（done 至多一条 + unblock 若干）。 */
  edits: TodoEdit[];
  /** 被自动勾掉的条目（至多一条）。 */
  completed: TodoItem | null;
  /** 自动勾的匹配档位（candidates 存在时的最优档；无候选 null）。 */
  tier: MatchTier;
  /** 被解锁的条目（blocker 匹配）。 */
  unblocked: TodoItem[];
  /** 随结算通知注入的提示行（对齐 D36 反馈语风；无提示 = 空数组）。 */
  noteLines: string[];
  /** 匹配率指标（P2：采集用，随结算通知落会话 JSONL）。 */
  metric: {
    description: string;
    outcome: ReconcileOutcome;
    bestTier: MatchTier;
    candidates: number;
    autoCompleted: boolean;
    unblocked: number;
  };
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function matchTier(a: string, b: string): MatchTier {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return null;
  if (na === nb) return 'exact';
  if (na.startsWith(nb) || nb.startsWith(na)) return 'prefix';
  if (na.includes(nb) || nb.includes(na)) return 'substring';
  return null;
}

const TIER_ORDER: Record<Exclude<MatchTier, null>, number> = { exact: 0, prefix: 1, substring: 2 };

export function reconcileTodos(
  prev: readonly TodoItem[],
  opts: { description: string; outcome: ReconcileOutcome },
): ReconcilePlan {
  const { description, outcome } = opts;
  const edits: TodoEdit[] = [];
  const noteLines: string[] = [];

  // 1) 勾选候选：pending / in_progress（completed/abandoned 永不参与）
  const matchable = prev.filter((t) => t.status === 'pending' || t.status === 'in_progress');
  const scored = matchable
    .map((t) => ({ item: t, tier: matchTier(description, t.content) }))
    .filter((c): c is { item: TodoItem; tier: Exclude<MatchTier, null> } => c.tier !== null)
    .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
  const bestTier = scored.length ? scored[0].tier : null;
  const best = bestTier ? scored.filter((c) => c.tier === bestTier) : [];

  let completed: TodoItem | null = null;
  if (bestTier === 'exact' || bestTier === 'prefix') {
    if (best.length === 1 && outcome === 'settled') {
      completed = best[0].item;
      edits.push({ op: 'done', content: completed.content });
      noteLines.push(`Reconciled: completed "${completed.content}" (${bestTier} match with subagent description).`);
    } else if (best.length > 1) {
      // 歧义：列候选，留给人
      noteLines.push(
        `Todo match ambiguous between: ${best.map((c) => `"${c.item.content}"`).join(', ')} — update todo_write yourself.`,
      );
    } else if (outcome === 'failed') {
      // 高置信候选但子代理未成功结算 → 保持打开，提示
      for (const c of best) {
        noteLines.push(`Todo kept open: "${c.item.content}" (subagent did not settle successfully).`);
      }
    }
  } else if (bestTier === 'substring') {
    // 低置信度（P2）：不勾，提示候选
    for (const c of best) {
      noteLines.push(`Todo not auto-completed (low-confidence match): "${c.item.content}" — update todo_write if this work is done.`);
    }
  }

  // 2) 解锁：blocker 任意档匹配（含 substring——真实 blocker 是「等 X 完成」短语，
  //    描述嵌在中间，prefix 会漏；低置信度闸只管勾选，解锁回 pending 是软操作）且 settled（可多条）
  const unblocked: TodoItem[] = [];
  if (outcome === 'settled') {
    for (const t of prev) {
      if (t.status !== 'blocked' || typeof t.blocker !== 'string') continue;
      if (matchTier(description, t.blocker) !== null) {
        unblocked.push(t);
        edits.push({ op: 'unblock', content: t.content });
        noteLines.push(`Unblocked "${t.content}" (was waiting on: ${t.blocker}).`);
      }
    }
  }

  return {
    items: edits.length ? applyTodoEdits(prev, edits) : prev as TodoItem[],
    edits,
    completed,
    tier: bestTier,
    unblocked,
    noteLines,
    metric: {
      description,
      outcome,
      bestTier,
      candidates: scored.length,
      autoCompleted: completed !== null,
      unblocked: unblocked.length,
    },
  };
}
