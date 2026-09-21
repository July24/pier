/**
 * D97 slim frame: a pane too narrow/short for the minimum usable TUI gets a non-capturing overlay
 * instead of a continuously repainting one — full TUI when it fits, an activity-anchored todo
 * window when ≥3 rows fit, else the pane title. Content updates only on todo/status reports, so
 * streaming thinking tokens can never reach it and the alt-screen diff produces no PTY output.
 *
 * Requires fullscreen TUI mode (buildLaunchParts injects it): the composite layer sits above the
 * document, so only the alt-screen path can be covered. Registered only inside a herdr pane
 * (PIER_SLIM_FRAME=0 opts out), as one process-local singleton whose overlay stays resident —
 * `done()` is never called, so the pending promise is swallowed and never awaited.
 *
 * Resize watchdog (D98): the component owns a SIGWINCH listener plus a 1 s poll, because
 * long-running sessions stop re-rendering on resize (an idle master shrunk by heat froze on a
 * stale clipped frame). Sizes are read live per render; both stop in dispose().
 */

import { isArchived } from './stale-core.ts';
import type { TodoItem } from './vocab.ts';
import { anchorTodoRange, formatTodoSummary, renderTodoGroups } from './todo-window.ts';
import { pierOption } from './pier-options.ts';
import { styledWidth, wrapStyled } from './ansi-text.ts';

/** Minimum usable TUI dimensions (pi interactive-mode layout: editor 3 rows + footer 1 + transcript ≥3 + spacing).
 * Below either threshold the pane cannot display a readable TUI, so the overlay covers it. */

export const SLIM_MIN_COLS = 24;
export const SLIM_MIN_ROWS = 12;
/** Overlay todo window needs this many rows after wrap; below that, fall back to the title frame. */
export const SLIM_TODO_MIN_ROWS = 3;
/** Narrower than this, todo lines wrap into a column; keep the title frame instead. */
export const SLIM_TODO_MIN_COLS = 16;
/** Empty-list copy: the pane is alive but has no plan yet (replaces a lone ·). */
export const SLIM_EMPTY_COPY = 'no todos yet';
/** D98: watchdog poll period — SIGWINCH covers the delivered signal; the poll covers lost ones (e.g. after suspend). */
export const RESIZE_WATCHDOG_MS = 1_000;

/** Visibility predicate (overlayOptions.visible invokes it on every render frame). */
export function isSlimFrame(cols: number, rows: number): boolean {
  return cols < SLIM_MIN_COLS || rows < SLIM_MIN_ROWS;
}

/* ── Width-aware wrapping lives in ansi-text (styledWidth / wrapStyled); the frame content is plain text ── */

/** Frame lines: wrap the title, center it vertically, clamp to rows. Every line is padded to the
 *  full visible width — row-wise compositing would otherwise let the TUI underneath show through
 *  blank lines and leak the flicker this frame exists to hide. No title → one centered `·`. */
export function frameLines(
  text: string,
  opts: { width: number; rows: number; colorize?: (s: string) => string },
): string[] {
  const width = Math.max(1, Math.floor(opts.width));
  const rows = Math.max(1, Math.floor(opts.rows));
  const body = text.trim() ? wrapStyled(text.trim(), width).slice(0, rows) : ['·'];
  return padFrame(body, { width, rows, colorize: opts.colorize ?? ((s: string) => s), vAlign: 'center' });
}

/** Row-wise compose: pad to full width, place `content` at the top or vertically centered, clamp to rows. */
function padFrame(
  content: readonly string[],
  opts: { width: number; rows: number; colorize: (s: string) => string; vAlign: 'center' | 'top' },
): string[] {
  const { width, rows } = opts;
  const body = content.slice(0, rows);
  const top = opts.vAlign === 'center' ? Math.max(0, Math.floor((rows - body.length) / 2)) : 0;
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const idx = i - top;
    const line = idx >= 0 && idx < body.length ? opts.colorize(body[idx]) : '';
    out.push(line + ' '.repeat(Math.max(0, width - styledWidth(line))));
  }
  return out;
}

function wrapTodoBody(items: readonly TodoItem[], width: number): string[] {
  return renderTodoGroups(items).flatMap((line) => wrapStyled(line, width));
}

function itemsEqual(a: readonly TodoItem[], b: readonly TodoItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.content !== y.content || x.status !== y.status || x.blocker !== y.blocker || x.phase !== y.phase) {
      return false;
    }
  }
  return true;
}

export interface SlimFrameInput {
  title?: string | null;
  items?: readonly TodoItem[];
  lastWriteAt?: number | null;
  now?: number;
}

/** Choose overlay content: the todo window when the pane can show ≥3 wrapped rows at ≥16 cols,
 *  otherwise the pane title (or SLIM_EMPTY_COPY when the list is empty). */
export function slimContentLines(
  input: SlimFrameInput & { width: number; rows: number; colorize?: (s: string) => string },
): string[] {
  const width = Math.max(1, Math.floor(input.width));
  const rows = Math.max(1, Math.floor(input.rows));
  const colorize = input.colorize ?? ((s: string) => s);
  const items = input.items ?? [];
  const title = (input.title ?? '').trim();
  const fallback = title || SLIM_EMPTY_COPY;
  const titleFrame = () => frameLines(fallback, { width, rows, colorize });

  if (rows < SLIM_TODO_MIN_ROWS || width < SLIM_TODO_MIN_COLS) return titleFrame();
  if (items.length === 0) return titleFrame();
  if (isArchived(items, input.lastWriteAt ?? null, input.now ?? Date.now())) return titleFrame();

  const header = wrapStyled(formatTodoSummary(items), width);
  const fullBody = wrapTodoBody(items, width);
  if (header.length + fullBody.length <= rows) {
    const packed = [...header, ...fullBody];
    if (packed.length < SLIM_TODO_MIN_ROWS) return titleFrame();
    return padFrame(packed, { width, rows, colorize, vAlign: 'top' });
  }

  const footerProbe = wrapStyled('   +99 hidden (99✓) · /todos', width);
  const itemBudget = rows - header.length - footerProbe.length;
  if (itemBudget < 1) return titleFrame();

  const [start, end] = anchorTodoRange(
    items,
    (s, e) => wrapTodoBody(items.slice(s, e), width).length <= itemBudget,
  );
  const kept = items.slice(start, end);
  const body = wrapTodoBody(kept, width);
  if (body.length === 0 || body.length > itemBudget) return titleFrame();

  const hidden = items.filter((_, i) => i < start || i >= end);
  const hiddenCompleted = hidden.filter((it) => it.status === 'completed').length;
  const footer = wrapStyled(`   +${hidden.length} hidden (${hiddenCompleted}✓) · /todos`, width);
  const packed = [...header, ...body, ...footer];
  if (packed.length < SLIM_TODO_MIN_ROWS) return titleFrame();
  return padFrame(packed, { width, rows, colorize, vAlign: 'top' });
}

/* ── Overlay component plus registration/update (process-local singleton) ─────────────────────────── */

interface FrameTui {
  requestRender(): void;
}

class SlimFrameComponent {
  private title = '';
  private items: readonly TodoItem[] = [];
  private lastWriteAt: number | null = null;
  private lastRows = 0;
  private cache: { width: number; lines: string[] } | null = null;
  private readonly tui: FrameTui;
  private readonly colorize: (s: string) => string;
  /** D98 watchdog: last PTY size seen by onMaybeResized (re-seeded at watchdog start). */
  private seenCols = 0;
  private seenRows = 0;
  private sigwinch: (() => void) | null = null;
  private poll: NodeJS.Timeout | null = null;

  constructor(tui: FrameTui, colorize: (s: string) => string) {
    this.tui = tui;
    this.colorize = colorize;
  }

  /** The visible predicate runs each frame; record row count because render(width) lacks height for centered layout. */
  onViewport(cols: number, rows: number): boolean {
    if (this.lastRows !== rows) {
      this.lastRows = rows;
      this.cache = null; // A row-count change requires re-layout.
    }
    return isSlimFrame(cols, rows);
  }

  setSnapshot(title: string, items: readonly TodoItem[], lastWriteAt: number | null): void {
    if (this.title === title && this.lastWriteAt === lastWriteAt && itemsEqual(this.items, items)) return;
    this.title = title;
    this.items = items;
    this.lastWriteAt = lastWriteAt;
    this.cache = null;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.cache && this.cache.width === width) return this.cache.lines;
    const lines = slimContentLines({
      title: this.title,
      items: this.items,
      lastWriteAt: this.lastWriteAt,
      width,
      rows: this.lastRows,
      colorize: this.colorize,
    });
    this.cache = { width, lines };
    return lines;
  }

  invalidate(): void {
    this.cache = null;
  }

  /** Reclaim the module singleton when pi tears down the overlay (session switch/exit), allowing re-registration. */
  dispose(): void {
    this.stopResizeWatchdog();
    if (active === this) active = null;
  }

  /** Live PTY size (pi-tui reads the same source on every render; an instance method so tests can stub it). */
  viewportSize(): { cols: number; rows: number } {
    return { cols: process.stdout.columns ?? 0, rows: process.stdout.rows ?? 0 };
  }

  /** D98: SIGWINCH handler and poll tick — exactly one requestRender per actual size change; the next render reads live sizes. */
  readonly onMaybeResized = (): void => {
    const { cols, rows } = this.viewportSize();
    if (cols === this.seenCols && rows === this.seenRows) return;
    this.seenCols = cols;
    this.seenRows = rows;
    this.tui.requestRender();
  };

  /** Start the D98 watchdog (idempotent). SIGWINCH covers the delivered signal; the poll covers lost ones. */
  startResizeWatchdog(): void {
    if (this.poll) return;
    const size = this.viewportSize();
    this.seenCols = size.cols;
    this.seenRows = size.rows;
    try {
      process.on('SIGWINCH', this.onMaybeResized);
      this.sigwinch = this.onMaybeResized;
    } catch {
      /* Platforms without a SIGWINCH mapping keep the poll only. */
    }
    this.poll = setInterval(this.onMaybeResized, RESIZE_WATCHDOG_MS);
    this.poll.unref?.();
  }

  private stopResizeWatchdog(): void {
    if (this.sigwinch) {
      process.removeListener('SIGWINCH', this.sigwinch);
      this.sigwinch = null;
    }
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }
}


/** Test injection point (reset module state); dispose first so an undisposed component's watchdog cannot leak. */
export function resetForTest(): void {
  active?.dispose();
  active = null;
}

let active: SlimFrameComponent | null = null;

/** Register the static-frame overlay (idempotent, once per process) from the session_start ctx. */
export function registerSlimFrame(eventCtx: unknown): void {
  if (active) return;
  if (pierOption('PIER_SLIM_FRAME') === '0') return;
  const ui = eventCtx !== null && typeof eventCtx === 'object' && 'ui' in eventCtx
    ? eventCtx.ui
    : null;
  const custom = ui !== null && typeof ui === 'object' && 'custom' in ui && typeof ui.custom === 'function'
    ? ui.custom
    : undefined;
  try {
    // overlay: true keeps the floating layer from clearing the screen (pi ctx.ui.custom replaces the editor area by default, so cover it explicitly);
    // nonCapturing leaves the keyboard with the editor (typing in a focused narrow pane remains possible, and the expanded heat view hides the frame).
    if (!custom) throw new Error('pi ui.custom unavailable');
    const pending = custom(
      (tui: FrameTui, theme: { fg(color: string, text: string): string }) => {
        const comp = new SlimFrameComponent(tui, (s) => theme.fg('accent', s));
        comp.startResizeWatchdog();
        active = comp;
        return comp;
      },
      {
        overlay: true,
        overlayOptions: {
          width: '100%',
          maxHeight: '100%',
          anchor: 'top-left',
          nonCapturing: true,
          visible: (cols: number, rows: number) => active !== null && active.onViewport(cols, rows),
        },
      },
    );
    // Never call done(), leaving the Promise pending so the overlay stays resident; swallow rejection and never await it.
    Promise.resolve(pending).catch(() => {});
  } catch {
    /* Silently degrade on pi versions without overlay support. */
  }
}

/** Update overlay snapshot. Title remains the fallback; items drive the todo window. */
export function updateSlimFrame(input: SlimFrameInput): void {
  active?.setSnapshot(input.title ?? '', input.items ?? [], input.lastWriteAt ?? null);
}
