/**
 * /pier-tree surface (RFC docs/rfc-core-app-migration.md §6): the delegation tree renders inside pi
 * as a capturing `ui.custom` overlay. The tree lines are recomputed on every render, so todo/worker
 * updates only call `refresh()` (a requestRender) while it is open — no snapshot file, no polling.
 * Keys: ↑↓/j k scroll, esc / ctrl+c / q / enter close.
 */
import { resolveDialogKey, type KeybindingsLike } from './ask-dialog.ts';
import { truncateStyled, wrapStyled } from './ansi-text.ts';

interface TreeTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface TreeOverlayHandle {
  refresh(): void;
}

/** Rows the scrolling body may use: the terminal height minus borders, title and footer. */
function bodyRows(): number {
  return Math.max(3, (process.stdout.rows ?? 24) - 8);
}

export function treeOverlayLines(opts: {
  lines: readonly string[];
  width: number;
  rows: number;
  offset: number;
  theme: TreeTheme;
}): { lines: string[]; offset: number } {
  const width = Math.max(4, Math.floor(opts.width));
  const inner = width - 2;
  const body = opts.lines.flatMap((line) => wrapStyled(line, inner));
  const maxOffset = Math.max(0, body.length - opts.rows);
  const offset = Math.min(Math.max(0, opts.offset), maxOffset);
  const visible = body.slice(offset, offset + opts.rows).map((line) => ` ${line}`);
  const border = opts.theme.fg('border', '─'.repeat(width));
  const position = body.length > opts.rows ? ` ${offset + 1}-${offset + visible.length}/${body.length}` : '';
  const footer = opts.theme.fg('dim', ` ↑↓ scroll · esc close${position}`);
  return {
    offset,
    lines: [
      border,
      ` ${opts.theme.fg('accent', opts.theme.bold('Pier Tree'))}`,
      '',
      ...visible,
      '',
      truncateStyled(footer, width),
      border,
    ],
  };
}

/** Open the overlay; resolves when the person closes it. Null when the host has no `ui.custom`. */
export function openTreeOverlay(
  custom: ((factory: unknown, options?: unknown) => Promise<unknown>) | undefined,
  renderTree: () => string[],
  onOpen: (handle: TreeOverlayHandle) => void,
): Promise<void> | null {
  if (!custom) return null;
  const pending = custom(
    (tui: { requestRender?: () => void } | undefined, theme: TreeTheme, keybindings: KeybindingsLike | undefined, done: (v: unknown) => void) => {
      let offset = 0;
      onOpen({ refresh: () => tui?.requestRender?.() });
      return {
        render(width: number): string[] {
          const out = treeOverlayLines({ lines: renderTree(), width, rows: bodyRows(), offset, theme });
          offset = out.offset;
          return out.lines;
        },
        handleInput(data: string): void {
          const key = data === 'q' ? 'cancel' : resolveDialogKey(data, keybindings);
          if (key === 'up') offset -= 1;
          else if (key === 'down') offset += 1;
          else if (key === 'cancel' || key === 'confirm') {
            done(undefined);
            return;
          } else return;
          tui?.requestRender?.();
        },
        invalidate(): void { /* Lines are recomputed per render. */ },
      };
    },
    { overlay: true, overlayOptions: { width: '90%', maxHeight: '90%', anchor: 'center' } },
  );
  return Promise.resolve(pending).then(() => undefined, () => undefined);
}
