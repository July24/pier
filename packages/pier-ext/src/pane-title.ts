/**
 * Projects the pane todo snapshot into a herdr pane header/sidebar (M22, D62/D68).
 *
 * The pi session JSONL remains authoritative; this layer only condenses the snapshot into a title and blocked badge.
 * herdr truncates title/state_label to 80 characters, so truncate locally to avoid cutting an emoji in half.
 */
import { countTodos, PI_HERDR_META_KEY, type TodoItem } from './vocab.ts';
import { formatAge, isArchived } from './stale-core.ts';

/** herdr's character limit for title/state_label (from official documentation and schema measurements). */
export const TITLE_MAX = 80;
/** Empty list: callers send clear_title rather than an empty string. */
export const TITLE_EMPTY = null;
/**
 * Valid state_labels keys are only idle|working|blocked|done|unknown
 * (herdr socket-api; the early WIRE `todo` value was rejected as invalid_state_label).
 */
export const BLOCKED_LABEL_KEY = 'blocked';

/**
 * D93: custom sidebar token for the todo summary (referenced as `$pi-todo` by herdr `[ui.sidebar.agents]`).
 * Keep its value in the same format and source as the pane title (`▶i ○p ■b ✓c (N/M) · activity`).
 */
export const SIDEBAR_TODO_TOKEN = 'pi-todo';
/** D95: token marking an ask_user_question wait (the workbench heat scale uses it to distinguish ask from block). */
export const SIDEBAR_ASK_TOKEN = 'pi-ask';

/**
 * D93: build the pi-todo token patch for report_metadata.
 * A title becomes the token value so the sidebar can render `$pi-todo`; no todo becomes an empty string so herdr's
 * patch semantics remove the key rather than retaining an old summary.
 *
 * D96 correction: **do not merge stale**. Stale (16 nulls) is a one-time cleanup sent separately via reportMetadata;
 * merging would make 17 entries exceed herdr's tokens maxProperties=16, rejecting the entire request and dropping
 * both title and tokens (observed on the user's machine: pane title and sidebar token disappeared; D93 regression root cause).
 */
export function sidebarTodoTokens(title: string | null): Record<string, string> {
  return { [SIDEBAR_TODO_TOKEN]: title ?? '' };
}

const STALE_CHUNK_COUNT = 15;

function clipTitle(s: string): string {
  return s.length <= TITLE_MAX ? s : s.slice(0, TITLE_MAX);
}

/**
 * `▶i ○p ■b ✓c (N/M [~eta]) · <activity>` (D91 unifies the four black-and-white status glyphs).
 * activity is the first in_progress item, then fallbackDescription, then only the counts.
 * Empty list → null. progressSuffix (M16) is produced by formatProgressSuffix.
 *
 * Anti-freeze behavior (stale-core D): once all work is complete and the wall clock expires (archived), lower the
 * dead list to `✓N done <age>` instead of presenting it as a fully weighted current-state view; report_agent's tool
 * badge/activity line explains what is happening, while the todo token reports only the plan's actual state.
 */
export function formatPaneTitle(
  items: readonly TodoItem[],
  fallbackDescription?: string | null,
  opts?: { progressSuffix?: string | null; lastWriteAt?: number | null; now?: number },
): string | null {
  if (items.length === 0) return TITLE_EMPTY;
  const c = countTodos(items);
  const now = opts?.now ?? Date.now();
  if (isArchived(items, opts?.lastWriteAt ?? null, now)) {
    const age = formatAge(now - (opts?.lastWriteAt as number));
    return clipTitle(`✓${c.completed} done ${age}`);
  }
  const activity =
    items.find((it) => it.status === 'in_progress')?.content
    ?? (fallbackDescription?.trim() ? fallbackDescription.trim() : null);
  const head = `▶${c.inProgress} ○${c.pending} ■${c.blocked} ✓${c.completed}`;
  const suffix = opts?.progressSuffix?.trim();
  const withProgress = suffix ? `${head} (${suffix})` : head;
  return clipTitle(activity ? `${withProgress} · ${activity}` : withProgress);
}

/** First blocked item's blocker (fall back to content); no blocked item → null. */
export function formatBlockedLabel(items: readonly TodoItem[]): string | null {
  const blocked = items.find((it) => it.status === 'blocked');
  if (!blocked) return null;
  const text = blocked.blocker?.trim() || blocked.content;
  return clipTitle(text);
}

/**
 * The first post-upgrade report clears the old 16-key chunks (herdr merges tokens by key, so omitted nulls remain—M13b).
 */
export function staleTokenClearance(): Record<string, null> {
  const tokens: Record<string, null> = { [PI_HERDR_META_KEY]: null };
  for (let i = 0; i < STALE_CHUNK_COUNT; i++) {
    tokens[`${PI_HERDR_META_KEY}-${i}`] = null;
  }
  return tokens;
}
