/**
 * D97 slim frame: when a pane is too narrow or short for the minimum usable TUI,
 * cover it with a non-capturing full-screen overlay containing a static frame sourced from the pane title.
 *
 * Why (observed by the user): after the heat view compresses an unfocused pane, streaming worker thinking
 * continuously repaints the entire screen in the narrow pane, causing flicker. The static frame updates only on
 * todo_write/status reports (sharing arguments and source with formatPaneTitle), so thinking tokens cannot reach it;
 * alt-screen row-level diffing then produces zero PTY output and physically eliminates the flicker.
 *
 * Prerequisite: worker/master run with --tui-mode fullscreen (injected by default by buildLaunchParts).
 * The regular main-screen full dump path (tui-main-screen firstChanged < viewportTop → full redraw) cannot be
 * covered by the overlay: composite is above the document, while the dump is inside the document.
 *
 * Registration gate: only inside a herdr pane (index.ts checks the environment), because covering an interactive
 * normal terminal window would be hazardous. Clicking a narrow herdr pane focuses it and the heat view expands it;
 * the visible predicate re-evaluates on every frame as SIGWINCH arrives, so the frame disappears automatically and
 * the real TUI remains underneath (agent/session/widget execution never stops).
 *
 * Lifecycle: one process-local singleton, registered once on session_start (not resume); the overlay stays resident
 * (done() is never called, leaving the Promise pending, swallowing rejection, and never awaiting it). If switching
 * pi sessions removes the overlay (resetExtensionUI), the static frame naturally exits without affecting the main
 * flow. PI_HERDR_SLIM_FRAME=0 is the escape hatch.
 */

/** Minimum usable TUI dimensions (pi interactive-mode layout: editor 3 rows + footer 1 + transcript ≥3 + spacing).
 * Below either threshold the pane cannot display a readable TUI, so it renders the title as a static frame. */

export const SLIM_MIN_COLS = 24;
export const SLIM_MIN_ROWS = 12;

/** Visibility predicate (overlayOptions.visible invokes it on every render frame). */
export function isSlimFrame(cols: number, rows: number): boolean {
  return cols < SLIM_MIN_COLS || rows < SLIM_MIN_ROWS;
}

/* ── Width-aware wrapping (conservative East Asian width; ambiguous glyphs such as ▶○■✓ count as 1, affecting only break positions) ── */

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) // Hangul compatibility jamo
    || (cp >= 0x2e80 && cp <= 0xa4cf) // CJK radicals through Yi (including kana)
    || (cp >= 0xac00 && cp <= 0xd7a3) // Hangul syllables
    || (cp >= 0xf900 && cp <= 0xfaff) // CJK compatibility ideographs
    || (cp >= 0xfe30 && cp <= 0xfe4f) // CJK compatibility forms
    || (cp >= 0xff00 && cp <= 0xff60) // Fullwidth forms
    || (cp >= 0xffe0 && cp <= 0xffe6)
  );
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return w;
}

/**
 * Wrap at visible width: prefer word breaks (retreat to the last space instead of cutting an English phrase);
 * CJK text without spaces hard-wraps naturally. Consume the space at the break point.
 */
export function wrapByWidth(text: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  let line = '';
  let lineW = 0;
  const push = () => {
    lines.push(line);
    line = '';
    lineW = 0;
  };
  for (const ch of text) {
    const cw = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
    if (lineW + cw > w) {
      const lastSpace = line.lastIndexOf(' ');
      if (lastSpace > 0) {
        lines.push(line.slice(0, lastSpace));
        line = line.slice(lastSpace + 1) + ch;
        lineW = displayWidth(line);
      } else {
        push();
        line = ch;
        lineW = cw;
      }
    } else {
      line += ch;
      lineW += cw;
    }
  }
  if (line !== '' || lines.length === 0) lines.push(line);
  return lines;
}

/**
 * Frame lines: wrap the title, center it vertically, and clamp to rows. Pad every line to full visible width:
 * row-wise overlay compositing would let the TUI underneath show through blank lines (leaking flicker),
 * while full-width spaces make the freeze genuinely opaque. Without a title, center one `·` (alive, no plan).
 */
export function frameLines(
  text: string,
  opts: { width: number; rows: number; colorize?: (s: string) => string },
): string[] {
  const width = Math.max(1, Math.floor(opts.width));
  const rows = Math.max(1, Math.floor(opts.rows));
  const colorize = opts.colorize ?? ((s: string) => s);
  const pad = (s: string) => s + ' '.repeat(Math.max(0, width - displayWidth(s)));

  const body = text.trim()
    ? wrapByWidth(text.trim(), width).slice(0, rows)
    : ['·'];
  const top = Math.max(0, Math.floor((rows - body.length) / 2));
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const idx = i - top;
    out.push(idx >= 0 && idx < body.length ? pad(colorize(body[idx])) : ' '.repeat(width));
  }
  return out;
}

/* ── Overlay component plus registration/update (process-local singleton) ─────────────────────────── */

interface FrameTui {
  requestRender(): void;
}

class SlimFrameComponent {
  private text = '';
  private lastRows = 0;
  private cache: { width: number; lines: string[] } | null = null;
  private readonly tui: FrameTui;
  private readonly colorize: (s: string) => string;

  constructor(tui: FrameTui, colorize: (s: string) => string) {
    this.tui = tui;
    this.colorize = colorize;
  }

  /** The visible predicate runs each frame; record row count because render(width) lacks height for centered layout. */
  onViewport(cols: number, rows: number): boolean {
    if (this.lastRows !== rows) {
      this.lastRows = rows;
      this.cache = null; // A row-count change requires re-centering.
    }
    return isSlimFrame(cols, rows);
  }

  setText(text: string): void {
    if (this.text === text) return;
    this.text = text;
    this.cache = null;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.cache && this.cache.width === width) return this.cache.lines;
    const lines = frameLines(this.text, { width, rows: this.lastRows, colorize: this.colorize });
    this.cache = { width, lines };
    return lines;
  }

  invalidate(): void {
    this.cache = null;
  }

  /** Reclaim the module singleton when pi tears down the overlay (session switch/exit), allowing re-registration. */
  dispose(): void {
    if (active === this) active = null;
  }
}


/** Test injection point (reset module state). */
export function resetForTest(): void {
  active = null;
}

let active: SlimFrameComponent | null = null;

/**
 * Register the static-frame overlay (idempotent: once per process). eventCtx is the pi lifecycle event context
 * (the session_start ctx, sourced from the same place as the todo widget's widgetUi).
 */
export function registerSlimFrame(eventCtx: unknown): void {
  if (active) return;
  if (process.env.PI_HERDR_SLIM_FRAME === '0') return;
  const ui = eventCtx !== null && typeof eventCtx === 'object' && 'ui' in eventCtx
    ? eventCtx.ui
    : null;
  const custom = ui !== null && typeof ui === 'object' && 'custom' in ui && typeof ui.custom === 'function'
    ? ui.custom
    : undefined;
  try {
    // overlay: true keeps the floating layer from clearing the screen (pi ctx.ui.custom replaces the editor area by default, so cover it explicitly);
    // nonCapturing leaves the keyboard with the editor (typing in a focused narrow pane remains possible, and the expanded heat view hides the frame).
    const pending = custom(
      (tui, theme) => {
        const comp = new SlimFrameComponent(tui, (s) => theme.fg('accent', s));
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

/** Update static-frame content (same arguments/source as the pane-title projection; null means no plan). */
export function updateSlimFrame(title: string | null): void {
  active?.setText(title ?? '');
}
