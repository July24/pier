/**
 * D91 网格形态：spawn 时挑「最大格子沿长轴分裂」，让 pane 自然铺成方格
 * （用户愿景：股票热力图式方格；横向格更易读最新输出）。
 *
 * 依据 herdr 0.8.2 源码：ratio = split 节点 first child 份额（split_rect：
 * first_w = width*ratio）；layout.apply 不能挂接既有 pane（只建新 shell），
 * 因此网格形态只能在 spawn 增量分裂时养成，形态之外的尺寸归热力 reflow 管。
 */

export type ShapeNode =
  | { type: 'pane'; paneId: string }
  | { type: 'split'; direction: string; ratio: number; first: ShapeNode; second: ShapeNode };

/** 容错解析 layout.export 的 root（pane 叶：{type:'pane', pane:{pane_id}}）。 */
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

/** 先序计算每个 pane 的格子（终端字符坐标；宽高仅用于比较，取典型 TUI 比例 200×50）。 */
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
 * 挑分裂目标：面积最大的格子（并列取先序第一，稳定），沿长轴分裂——
 * 宽 ≥ 1.3×高 → right（左右分，保格子横向可读），否则 down。
 * exclude = 不许动的格子（board 等无 agent 常驻 shell）。
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
  return { targetPaneId: best.id, direction: best.w > best.h * 1.3 ? 'right' : 'down' };
}
