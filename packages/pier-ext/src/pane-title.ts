/**
 * pane todo → herdr 窗格头 / 侧栏投影（M22，D62/D68）。
 *
 * 权威仍在 pi 会话 JSONL；这里只把快照收成 title + blocked 徽标。
 * herdr 把 title / state_label 截到 80 字符——本地先裁，避免半截 emoji。
 */
import { countTodos, PI_HERDR_META_KEY, type TodoItem } from './vocab.ts';

/** herdr 对 title / state_label 的字符上限（官方文档 + schema 实测）。 */
export const TITLE_MAX = 80;
/** 空列表：调用方发 clear_title，不写空串。 */
export const TITLE_EMPTY = null;
/**
 * state_labels 合法键只有 idle|working|blocked|done|unknown
 * （herdr socket-api；WIRE 早期 `todo` 被拒 invalid_state_label）。
 */
export const BLOCKED_LABEL_KEY = 'blocked';

/**
 * D93：todo 摘要的侧边栏 custom token 名（herdr `[ui.sidebar.agents]` 里以 `$pi-todo` 引用）。
 * 值与 pane title 同源同格式（`▶i ○p ■b ✓c (N/M) · activity`）。
 */
export const SIDEBAR_TODO_TOKEN = 'pi-todo';
/** D95：ask_user_question 等待标志 token 名（workbench 热力分级读它区分 ask vs block）。 */
export const SIDEBAR_ASK_TOKEN = 'pi-ask';

/**
 * D93：构造 report_metadata 的 pi-todo token 补丁。
 * 有 title → 值 = title（侧边栏可排 `$pi-todo`）；无 todo → 空串（herdr patch 语义删除键，不留旧摘要）。
 * stale（M13b 清理头键）合并进同一次上报。
 */
export function sidebarTodoTokens(title: string | null, stale?: Record<string, string | null>): Record<string, string> {
  return { ...(stale ?? {}), [SIDEBAR_TODO_TOKEN]: title ?? '' };
}

const STALE_CHUNK_COUNT = 15;

function clipTitle(s: string): string {
  return s.length <= TITLE_MAX ? s : s.slice(0, TITLE_MAX);
}

/**
 * `▶i ○p ■b ✓c (N/M [~eta]) · <activity>`（D91 图标统一：黑白字符四件套）。
 * activity = 第一条 in_progress，否则 fallbackDescription，再否则只报计数。
 * 空列表 → null。progressSuffix（M16）= formatProgressSuffix 产物。
 */
export function formatPaneTitle(
  items: readonly TodoItem[],
  fallbackDescription?: string | null,
  opts?: { progressSuffix?: string | null },
): string | null {
  if (items.length === 0) return TITLE_EMPTY;
  const c = countTodos(items);
  const activity =
    items.find((it) => it.status === 'in_progress')?.content
    ?? (fallbackDescription?.trim() ? fallbackDescription.trim() : null);
  const head = `▶${c.inProgress} ○${c.pending} ■${c.blocked} ✓${c.completed}`;
  const suffix = opts?.progressSuffix?.trim();
  const withProgress = suffix ? `${head} (${suffix})` : head;
  return clipTitle(activity ? `${withProgress} · ${activity}` : withProgress);
}

/** 第一条 blocked 的 blocker（缺则用 content）；无 blocked → null。 */
export function formatBlockedLabel(items: readonly TodoItem[]): string | null {
  const blocked = items.find((it) => it.status === 'blocked');
  if (!blocked) return null;
  const text = blocked.blocker?.trim() || blocked.content;
  return clipTitle(text);
}

/**
 * 升级后首次上报用来清掉旧 16-key 分块（herdr tokens 按 key 合并，
 * 不写 null 会残留——M13b）。
 */
export function staleTokenClearance(): Record<string, null> {
  const tokens: Record<string, null> = { [PI_HERDR_META_KEY]: null };
  for (let i = 0; i < STALE_CHUNK_COUNT; i++) {
    tokens[`${PI_HERDR_META_KEY}-${i}`] = null;
  }
  return tokens;
}
