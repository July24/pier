/**
 * ask_user_question dialog: one pier-owned selector for single- and multi-select
 * questions, rendered through `ctx.ui.custom`.
 *
 * Why: pi's built-in `ui.select` (ExtensionSelectorComponent) and pier's former
 * hand-rolled multi toggle list styled the same question differently — frame,
 * cursor glyph, numbering, hint line and navigation semantics all diverged.
 * Both question modes now share this component; only the checkbox column, the
 * extra key hints and the selection counter differ between modes.
 *
 * The chrome deliberately mirrors pi's ExtensionSelectorComponent: a border rule
 * above and below, an accent+bold title, a `→ ` cursor, dim description text and
 * keyHint-style footer hints (dim key + muted verb, double-space separated)
 * resolved from the keybindings manager pi hands to custom factories.
 */
import { styledWidth, truncateStyled, wrapStyled } from './ansi-text.ts';

/** Label of the trailing free-text row; ask-user reuses it for the typed fallback list. */
export const OTHER_ROW_LABEL = 'Other (type your own)';

export interface DialogOption {
  label: string;
  description?: string;
}

export interface DialogConfig {
  options: readonly DialogOption[];
  /** Render the trailing free-text row. */
  allowOther: boolean;
  /**
   * 0-based recommended option. The cursor starts on it; multi mode also starts
   * with it checked so a bare enter agrees with single mode's "take the
   * recommendation" in both modes.
   */
  recommended?: number;
  /** true = toggle list (space toggles, enter confirms the set); false = pick-one (enter/space takes the cursor row). */
  multi: boolean;
}

export interface DialogState {
  /** Cursor row: 0..options.length-1 are choices, options.length is the Other row. */
  cursor: number;
  /** Toggle state per authored option (never includes the Other row). */
  selected: readonly boolean[];
}

export type DialogKey = 'up' | 'down' | 'toggle' | 'confirm' | 'cancel' | 'all' | 'ignore';

export type DialogOutcome =
  | { kind: 'selected'; labels: string[] }
  | { kind: 'other' }
  | { kind: 'cancel' };

export interface DialogStep {
  state: DialogState;
  outcome?: DialogOutcome;
}

export function createDialogState(config: DialogConfig): DialogState {
  const hasRecommended =
    config.recommended !== undefined
    && config.recommended >= 0
    && config.recommended < config.options.length;
  // No valid recommendation means row 0 for the cursor only — nothing pre-checked.
  const start = hasRecommended ? config.recommended! : 0;
  return {
    cursor: start,
    selected: config.options.map((_, i) => config.multi && hasRecommended && i === start),
  };
}

/** Total rows including the optional Other row; the cursor wraps inside this. */
export function rowCount(config: DialogConfig): number {
  return config.options.length + (config.allowOther ? 1 : 0);
}

export function isOtherRow(state: DialogState, config: DialogConfig): boolean {
  return config.allowOther && state.cursor === config.options.length;
}

export function selectedLabels(state: DialogState, config: DialogConfig): string[] {
  const labels: string[] = [];
  config.options.forEach((option, i) => {
    if (state.selected[i]) labels.push(option.label);
  });
  return labels;
}

/** Apply one key. A returned outcome ends the interaction. */
export function stepDialog(state: DialogState, key: DialogKey, config: DialogConfig): DialogStep {
  const rows = rowCount(config);
  if (rows === 0) return key === 'cancel' ? { state, outcome: { kind: 'cancel' } } : { state };
  switch (key) {
    case 'cancel':
      return { state, outcome: { kind: 'cancel' } };
    case 'up':
    case 'down': {
      const delta = key === 'up' ? -1 : 1;
      const cursor = (state.cursor + delta + rows) % rows;
      return { state: { ...state, cursor } };
    }
    case 'all': {
      if (!config.multi) return { state };
      const anyUnselected = state.selected.some((v) => !v);
      return { state: { ...state, selected: state.selected.map(() => anyUnselected) } };
    }
    case 'toggle':
    case 'confirm': {
      if (isOtherRow(state, config)) return { state, outcome: { kind: 'other' } };
      if (!config.multi) {
        // Pick-one: enter and space both take the cursor row.
        return { state, outcome: { kind: 'selected', labels: [config.options[state.cursor]!.label] } };
      }
      if (key === 'toggle') {
        const selected = state.selected.map((v, i) => (i === state.cursor ? !v : v));
        return { state: { ...state, selected } };
      }
      // Enter on a choice row confirms the current toggles; a single-choice
      // question needs no separate space press.
      if (config.options.length === 1) {
        return { state, outcome: { kind: 'selected', labels: [config.options[0]!.label] } };
      }
      return { state, outcome: { kind: 'selected', labels: selectedLabels(state, config) } };
    }
    default:
      return { state };
  }
}

/* ── Key resolution ────────────────────────────────────────────────── */

/** The slice of pi's KeybindingsManager custom factories receive as 3rd arg. */
export interface KeybindingsLike {
  matches(data: string, keybinding: string): boolean;
  getKeys(keybinding: string): string[];
}

/**
 * Raw sequences used when the factory's keybindings manager is absent (older
 * hosts, direct construction in tests). Mirrors pi's defaults; j/k are included
 * so vim keys work in both resolution paths, like pi's own selector.
 */
export const FALLBACK_KEY_SEQUENCES: Record<'up' | 'down' | 'toggle' | 'confirm' | 'cancel', readonly string[]> = {
  up: ['\x1b[A', '\x1bOA', 'k'],
  down: ['\x1b[B', '\x1bOB', 'j'],
  toggle: [' '],
  confirm: ['\r', '\n'],
  cancel: ['\x1b', '\x03'],
};

/** Map one raw input chunk to a dialog key using the host bindings plus fallbacks. */
export function resolveDialogKey(data: string, keybindings?: KeybindingsLike): DialogKey {
  const kb = (id: string): boolean => keybindings?.matches?.(data, `tui.select.${id}`) === true;
  if (kb('up') || FALLBACK_KEY_SEQUENCES.up.includes(data)) return 'up';
  if (kb('down') || FALLBACK_KEY_SEQUENCES.down.includes(data)) return 'down';
  if (FALLBACK_KEY_SEQUENCES.toggle.includes(data)) return 'toggle';
  if (kb('confirm') || FALLBACK_KEY_SEQUENCES.confirm.includes(data)) return 'confirm';
  if (kb('cancel') || FALLBACK_KEY_SEQUENCES.cancel.includes(data)) return 'cancel';
  if (data === 'a' || data === 'A') return 'all';
  return 'ignore';
}

/* ── TUI component ─────────────────────────────────────────────────── */

export interface MinimalTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface DialogComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

export interface DialogUiOptions {
  title: string;
  config: DialogConfig;
  theme: MinimalTheme;
  /** pi's keybindings manager (ctx.ui.custom factory 3rd arg); optional in tests. */
  keybindings?: KeybindingsLike;
  /** Aborting cancels the dialog so the ask tool result and herdr gate settle. */
  signal?: AbortSignal;
  /** pi's ctrl+o tool-output expansion, when the host exposes it. */
  toggleToolsExpanded?: () => void;
  /** Called with the outcome; the host resolves ctx.ui.custom. */
  done(outcome: DialogOutcome): void;
  /** Ask for the gate label used by the renderer (tests only). */
  requestRender?: () => void;
}

const RECOMMENDED = ' (Recommended)';

export function dialogLines(state: DialogState, config: DialogConfig, theme: MinimalTheme): string[] {
  const lines: string[] = [];
  config.options.forEach((option, i) => {
    const onCursor = i === state.cursor;
    const cursor = onCursor ? theme.fg('accent', '→ ') : '  ';
    const label = `${option.label}${config.recommended === i ? RECOMMENDED : ''}`;
    const desc = option.description ? theme.fg('dim', ` — ${option.description}`) : '';
    if (config.multi) {
      const box = state.selected[i] ? theme.fg('success', '[x]') : '[ ]';
      const styled = state.selected[i] ? theme.bold(label) : label;
      lines.push(`${cursor}${box} ${styled}${desc}`);
    } else {
      // Pick-one highlights the whole row — enter takes exactly what is lit.
      const styled = onCursor ? theme.fg('accent', label) : label;
      lines.push(`${cursor}${styled}${desc}`);
    }
  });
  if (config.allowOther) {
    const cursor = isOtherRow(state, config) ? theme.fg('accent', '→ ') : '  ';
    const row = config.multi ? `[ ] ${OTHER_ROW_LABEL}` : OTHER_ROW_LABEL;
    lines.push(`${cursor}${theme.fg('dim', row)}`);
  }
  return lines;
}

/** keyHint style shared with pi's selector: dim key + muted verb. */
function hint(theme: MinimalTheme, key: string, verb: string): string {
  return theme.fg('dim', key) + theme.fg('muted', ` ${verb}`);
}

function displayKeys(keybindings: KeybindingsLike | undefined, id: 'confirm' | 'cancel', fallback: string): string {
  const keys = keybindings?.getKeys?.(`tui.select.${id}`);
  return keys && keys.length > 0 ? keys.join('/') : fallback;
}

export function dialogFooter(
  state: DialogState,
  config: DialogConfig,
  theme: MinimalTheme,
  keybindings?: KeybindingsLike,
  width?: number,
): string {
  const confirm = displayKeys(keybindings, 'confirm', 'enter');
  const cancel = displayKeys(keybindings, 'cancel', 'escape/ctrl+c');
  const picked = selectedLabels(state, config).length;
  const chip = config.multi && picked > 0 ? theme.fg('success', ` · ${picked} selected`) : '';
  const navigate = hint(theme, '↑↓', 'navigate');
  const toggle = hint(theme, 'space', 'toggle');
  const all = hint(theme, 'a', 'all');
  const action = hint(theme, confirm, config.multi ? 'confirm' : 'select');
  const cancelHint = hint(theme, cancel, 'cancel');
  const parts = config.multi ? [navigate, toggle, all, action, cancelHint] : [navigate, action, cancelHint];
  const fits = (segs: string[]): boolean => styledWidth(segs.join('  ') + chip) <= (width ?? Infinity);
  // Narrow panes shed the most guessable extras first (a-all, navigate, then
  // the cancel hint); the action keys and the live count are the floor.
  for (const droppable of config.multi ? [all, navigate, cancelHint] : [navigate]) {
    if (fits(parts)) break;
    parts.splice(parts.indexOf(droppable), 1);
  }
  return parts.join('  ') + chip;
}

export function createDialogComponent(opts: DialogUiOptions): DialogComponent {
  let state = createDialogState(opts.config);
  let finished = false;
  const onAbort = (): void => finish({ kind: 'cancel' });
  function finish(outcome: DialogOutcome): void {
    if (finished) return;
    finished = true;
    opts.signal?.removeEventListener('abort', onAbort);
    opts.done(outcome);
  }
  if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
  return {
    render(width: number): string[] {
      const border = opts.theme.fg('border', '─'.repeat(Math.max(1, width)));
      // Content wraps inside a 1-col margin each side, like pi's Text(text, 1, 0),
      // so long labels and descriptions keep their tail instead of clipping.
      const inner = Math.max(1, width - 2);
      const pad = (line: string): string => ` ${line}`;
      return [
        border,
        '',
        ...wrapStyled(opts.theme.fg('accent', opts.theme.bold(opts.title)), inner).map(pad),
        '',
        ...dialogLines(state, opts.config, opts.theme)
          .flatMap((row) => wrapStyled(row, inner))
          .map(pad),
        '',
        truncateStyled(` ${dialogFooter(state, opts.config, opts.theme, opts.keybindings, inner)}`, width),
        '',
        border,
      ];
    },
    handleInput(data: string): void {
      if (finished) return;
      if (opts.keybindings?.matches?.(data, 'app.tools.expand') === true) {
        opts.toggleToolsExpanded?.();
        return;
      }
      const key = resolveDialogKey(data, opts.keybindings);
      if (key === 'ignore') return;
      const next = stepDialog(state, key, opts.config);
      state = next.state;
      opts.requestRender?.();
      if (next.outcome) finish(next.outcome);
    },
    invalidate(): void { /* No cached lines. */ },
  };
}

/**
 * Run the dialog through `ctx.ui.custom`.
 * Returns null when the host cannot render custom components (RPC mode / older pi),
 * so the caller can fall back to the host select dialog or the typed prompt.
 */
export async function runSelectDialog(
  custom: (factory: unknown) => Promise<unknown>,
  title: string,
  config: DialogConfig,
  options?: { signal?: AbortSignal; toggleToolsExpanded?: () => void },
): Promise<DialogOutcome | null> {
  if (options?.signal?.aborted) return { kind: 'cancel' };
  const result = await custom((tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) =>
    createDialogComponent({
      title,
      config,
      theme: theme as MinimalTheme,
      keybindings: keybindings as KeybindingsLike | undefined,
      signal: options?.signal,
      toggleToolsExpanded: options?.toggleToolsExpanded,
      done: (outcome) => done(outcome),
      requestRender: () => (tui as { requestRender?: () => void } | undefined)?.requestRender?.(),
    }));
  if (result === undefined || result === null) return null;
  const outcome = result as DialogOutcome;
  if (outcome.kind === 'cancel' || outcome.kind === 'other' || outcome.kind === 'selected') return outcome;
  return null;
}
