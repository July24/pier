/**
 * D97 网格形态：spawn 时挑「最大格子」一律 down（上下拆），让 pane 长成全宽横条。
 *
 * 动因（用户实证）：热力把非焦点格压窄后，横条仍保全宽——pane title 静帧
 * （slim-frame.ts 同源投影）一行横读；旧「方格」拓扑的非焦点格是竖窄条，
 * title 折成一竖列不可读。静帧 overlay 的可见性谓词（长宽 < TUI 下限）与
 * 本拓扑配套：横条命中行数下限、存量竖条命中列数下限，两代布局都被接住。
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
 * 挑分裂目标：面积最大的格子（并列取先序第一，稳定），一律 down（上下拆）。
 * 模型 200×50 下 pane 数上限（热力 MAX_AUTO_LAYOUT_PANES=10）内条高最低 5 行
 * ——低于 TUI 可用下限即静帧，正是设计语义（条 = title 帧，点击放大看真身）。
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
  return { targetPaneId: best.id, direction: 'down' };
}
