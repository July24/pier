/**
 * D97: Always split the largest cell downward so spawned panes remain full-width strips.
 *
 * Heat reflow narrows unfocused cells, but full-width strips keep the slim-frame title
 * readable on one line. The previous grid topology produced narrow vertical cells whose
 * titles wrapped into unreadable columns. The overlay threshold complements both layouts:
 * new strips cross the row limit, while existing columns cross the column limit.
 *
 * herdr 0.8.2 defines ratio as the first child's share. Because layout.apply creates a
 * new shell rather than attaching an existing pane, spawn-time incremental splits must
 * establish this topology; heat reflow owns only later sizing.
 */

export type ShapeNode =
  | { type: 'pane'; paneId: string }
  | { type: 'split'; direction: string; ratio: number; first: ShapeNode; second: ShapeNode };

/** Tolerate layout.export shape variants because pane leaves may nest pane_id. */
export function parseShapeTree(raw: unknown): ShapeNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.type === 'pane') {
    const nested = o.pane as Record<string, unknown> | undefined;
    const id = typeof o.pane_id === 'string'
      ? o.pane_id
      : typeof nested?.pane_id === 'string' ? nested.pane_id : null;
    return id ? { type: 'pane', paneId: id } : null;
  }
  if (o.type === 'split') {
    const first = parseShapeTree(o.first);
    const second = parseShapeTree(o.second);
    if (!first || !second) return null;
    return {
      type: 'split',
      direction: String(o.direction ?? 'right'),
      ratio: typeof o.ratio === 'number' ? o.ratio : 0.5,
      first,
      second,
    };
  }
  return null;
}

export interface PaneCell {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Use a representative TUI aspect ratio so preorder cell comparisons reflect screen area. */
export function paneCells(root: ShapeNode, width = 200, height = 50): PaneCell[] {
  const cells: PaneCell[] = [];
  const walk = (node: ShapeNode, x: number, y: number, w: number, h: number): void => {
    if (node.type === 'pane') {
      cells.push({ id: node.paneId, x, y, w, h });
      return;
    }
    const horizontal = node.direction === 'right' || node.direction === 'left' || node.direction === 'horizontal';
    if (horizontal) {
      walk(node.first, x, y, w * node.ratio, h);
      walk(node.second, x + w * node.ratio, y, w * (1 - node.ratio), h);
    } else {
      walk(node.first, x, y, w, h * node.ratio);
      walk(node.second, x, y + h * node.ratio, w, h * (1 - node.ratio));
    }
  };
  walk(root, 0, 0, width, height);
  return cells;
}

/**
 * Split the largest eligible cell downward; preorder tie-breaking keeps the choice stable.
 * At D97's 200x50 model and ten-pane cap, strips eventually become slim title frames by design.
 * Exclusions protect resident non-agent panes such as the board from worker splits.
 */
export function pickGridSplit(
  root: ShapeNode,
  opts: { exclude?: ReadonlySet<string>; width?: number; height?: number } = {},
): { targetPaneId: string; direction: 'right' | 'down' } | null {
  const cells = paneCells(root, opts.width ?? 200, opts.height ?? 50)
    .filter((c) => !opts.exclude?.has(c.id));
  if (cells.length === 0) return null;
  let best = cells[0];
  for (const c of cells) {
    if (c.w * c.h > best.w * best.h + 1e-9) best = c;
  }
  return { targetPaneId: best.id, direction: 'down' };
}
