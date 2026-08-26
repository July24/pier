/**
 * D97 窄格静帧（slim frame）：pane 长宽放不下最小可用 TUI 时，用非捕获
 * 全屏 overlay 盖一张 pane title 同源静帧。
 *
 * 动机（用户实证）：热力把非焦点格压窄后，worker 的流式 thinking 在窄格
 * 里持续整屏重绘 → 闪烁。静帧只在 todo_write / 状态上报时更新（与
 * formatPaneTitle 同参同源），thinking token 碰不到它 → alt-screen 行级
 * 差分下 PTY 零输出，闪烁物理消失。
 *
 * 前提：worker/master 以 --tui-mode fullscreen 运行（buildLaunchParts 默认
 * 注入）。regular 主屏的整屏 dump 路径（tui-main-screen firstChanged <
 * viewportTop → 全量重倒）overlay 盖不住——composite 在文档之上，dump 在
 * 文档之内。
 *
 * 注册闸：仅 herdr pane 内（index.ts 以 env 判定）——普通小终端窗口里盖住
 * 交互面是事故；herdr 窄格点击聚焦即被热力放大，visible 谓词随 SIGWINCH
 * 每帧重估，静帧自动消失、真 TUI 原样在底下（agent/会话/widget 从未停）。
 *
 * 生命周期：进程内单例，session_start（非 resume）注册一次；overlay 常驻
 * （done() 永不调用 → Promise 永挂，吞 rejection，绝不 await）。pi 会话
 * 切换若拆掉 overlay（resetExtensionUI）则静帧自然退场，不影响主流程。
 * PI_HERDR_SLIM_FRAME=0 逃生口。
 */

/** TUI 可用下限（pi interactive-mode 布局：editor 3 行 + footer 1 + transcript ≥3 + 间距）。
 * 任一轴低于此值 → 该格读不了 TUI，画 title 静帧。 */
export const SLIM_MIN_COLS = 24;
export const SLIM_MIN_ROWS = 12;

/** 静帧可见性谓词（overlayOptions.visible 每渲染帧回调）。 */
export function isSlimFrame(cols: number, rows: number): boolean {
  return cols < SLIM_MIN_COLS || rows < SLIM_MIN_ROWS;
}

/* ── 宽度感知折行（保守 East Asian 宽度；▶○■✓ 等歧义宽字符按 1 记，仅影响折点位置） ── */

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) // 谚文兼容字母
    || (cp >= 0x2e80 && cp <= 0xa4cf) // CJK 部首～彝文（含假名）
    || (cp >= 0xac00 && cp <= 0xd7a3) // 谚文音节
    || (cp >= 0xf900 && cp <= 0xfaff) // CJK 兼容表意
    || (cp >= 0xfe30 && cp <= 0xfe4f) // CJK 兼容形式
    || (cp >= 0xff00 && cp <= 0xff60) // 全角形式
    || (cp >= 0xffe0 && cp <= 0xffe6)
  );
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return w;
}

/**
 * 按可见宽度折行：词折行（行内有空格则退到最后一个空格断，英文短语不腰斩；
 * CJK 无空格自然硬折）。折行处吞掉断点空格。
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
 * 静帧行：title 折行 → 垂直居中 → 钳到 rows。每行都补齐到满宽（可见宽度）：
 * overlay 的合成按行覆盖，空行会让底下的 TUI 透出来（漏 flicker），
 * 满宽空格行才是真正的不透明冻结。无 title → 居中一枚 `·`（活着、没计划）。
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

/* ── overlay 组件 + 注册/更新（进程内单例） ─────────────────────────── */

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

  /** visible 谓词每帧回调：顺手记录行数（render(width) 拿不到高度，居中布局靠它）。 */
  onViewport(cols: number, rows: number): boolean {
    if (this.lastRows !== rows) {
      this.lastRows = rows;
      this.cache = null; // 行数变了 → 居中重排
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

  /** pi 拆 overlay（会话切换/退出）时回收模块单例，重注册不被 no-op。 */
  dispose(): void {
    if (active === this) active = null;
  }
}


/** 测试注入点（module state 重置）。 */
export function resetForTest(): void {
  active = null;
}

let active: SlimFrameComponent | null = null;

/**
 * 注册静帧 overlay（幂等：进程一次）。eventCtx = pi 生命周期事件上下文
 * （session_start 的 ctx，与 todo widget 的 widgetUi 同来源）。
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
    // overlay: true = 浮层不清屏（pi ctx.ui.custom 默认替换编辑器区，必须显式盖）；
    // nonCapturing = 键盘仍归编辑器（人点进窄格也能打字，热力放大后静帧自动消失）。
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
    // done() 永不调用 → Promise 永挂（overlay 常驻）；吞 rejection，绝不 await。
    Promise.resolve(pending).catch(() => {});
  } catch {
    /* 无 overlay 能力的 pi 版本静默降级 */
  }
}

/** 静帧内容更新（title 与 pane 标题投影同参同源；null = 无计划）。 */
export function updateSlimFrame(title: string | null): void {
  active?.setText(title ?? '');
}
