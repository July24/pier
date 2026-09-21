/**
 * D97 slim frame: visibility predicate / width-aware wrapping / frame lines / overlay registration
 * lifecycle / the three content tiers. Seam: pure functions plus the process-local singleton
 * (isolated through resetForTest).
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  SLIM_EMPTY_COPY,
  SLIM_MIN_COLS,
  SLIM_MIN_ROWS,
  SLIM_TODO_MIN_COLS,
  SLIM_TODO_MIN_ROWS,
  frameLines,
  isSlimFrame,
  registerSlimFrame,
  RESIZE_WATCHDOG_MS,
  resetForTest,
  slimContentLines,
  updateSlimFrame,
} from '../src/slim-frame.ts';
import { styledWidth, wrapStyled } from '../src/ansi-text.ts';
import type { TodoItem } from '../src/vocab.ts';

beforeEach(() => resetForTest());

test('isSlimFrame：任一轴低于 TUI 下限即静帧', () => {
  assert.equal(isSlimFrame(SLIM_MIN_COLS - 1, 50), true, '竖窄条（左右拆存量布局）');
  assert.equal(isSlimFrame(200, SLIM_MIN_ROWS - 1), true, '矮横条（D97 新拓扑非焦点格）');
  assert.equal(isSlimFrame(SLIM_MIN_COLS, SLIM_MIN_ROWS), false, '两轴达标 → 真 TUI');
  assert.equal(isSlimFrame(200, 50), false);
});

test('宽度测量与折行（ansi-text）：CJK 双宽、英文空格让位、短行不折', () => {
  // The frame pads and wraps with these two helpers, so their cell accounting is what keeps every
  // frame line exactly `width` cells wide.
  assert.equal(styledWidth('abc'), 3);
  assert.equal(styledWidth('探查代码'), 8);
  assert.equal(styledWidth('▶2 ○11'), 6);
  assert.deepEqual(wrapStyled('探查渠道费用触点', 4), ['探查', '渠道', '费用', '触点']);
  assert.deepEqual(wrapStyled('map channel fees', 8), ['map', 'channel', 'fees']);
  assert.deepEqual(wrapStyled('short', 10), ['short']);
});

test('frameLines：垂直居中 + 满宽补齐 + 行数钳制', () => {
  const lines = frameLines('▶2 ○11 ✓1 · 正在做的事', { width: 10, rows: 5 });
  assert.equal(lines.length, 5);
  assert.ok(lines.every((l) => styledWidth(l) === 10), '每行满宽（不透明冻结，不漏底）');
  assert.ok(lines.some((l) => l.includes('▶2 ○11')), '内容行可见');
  assert.ok(lines[0].trim() === '', '首行留白（居中）');
  // fewer rows than content → clamped to the leading lines
  const clamped = frameLines('aaa bbb ccc ddd', { width: 3, rows: 2 });
  assert.equal(clamped.length, 2);
});

test('frameLines：空 title → 居中一枚 ·（活着、没计划）', () => {
  const lines = frameLines('', { width: 8, rows: 3 });
  assert.equal(lines.length, 3);
  assert.ok(lines[1].includes('·'), '内容行含 ·');
  assert.ok(lines.every((l) => styledWidth(l) === 8), '满宽补齐');
});

test('registerSlimFrame：无 ui / 无 custom → 静默不注册', () => {
  registerSlimFrame(null);
  registerSlimFrame({ ui: {} });
  // no throw, and later updates stay a no-op
  updateSlimFrame({ title: 'x' });
  assert.ok(true);
});

test('registerSlimFrame：注册 → visible 随尺寸切换 → dispose 后可重注册', () => {
  let factory!: (tui: { requestRender(): void }, theme: { fg(c: string, s: string): string }) => object;
  let options!: Record<string, unknown>;
  const custom = (f: typeof factory, o: Record<string, unknown>) => {
    factory = f;
    options = o;
    return new Promise<never>(() => {}); // done() is never called: the overlay stays resident
  };
  let renders = 0;
  registerSlimFrame({ ui: { custom } });

  assert.equal(options.overlay, true, '浮层不清屏');
  const overlayOptions = options.overlayOptions as {
    nonCapturing: boolean;
    visible: (c: number, r: number) => boolean;
  };
  assert.equal(overlayOptions.nonCapturing, true, '键盘不捕获');

  const comp = factory({ requestRender: () => { renders += 1; } }, { fg: (_c, s) => s }) as {
    dispose(): void;
    render(w: number): string[];
  };

  // narrow pane → visible; expanded → hidden
  assert.equal(overlayOptions.visible(10, 40), true);
  assert.equal(overlayOptions.visible(200, SLIM_MIN_ROWS - 1), true);
  assert.equal(overlayOptions.visible(200, 50), false);

  // a content update re-renders; identical text is idempotent (no repaint)
  updateSlimFrame({ title: '▶1 ○2 · task' });
  assert.equal(renders, 1);
  updateSlimFrame({ title: '▶1 ○2 · task' });
  assert.equal(renders, 1);

  // render: full-width lines
  const lines = comp.render(10);
  assert.ok(lines.length >= 1 && lines.every((l) => styledWidth(l) === 10));

  // dispose reclaims the singleton → a re-registration is not a no-op
  comp.dispose();
  let called = 0;
  registerSlimFrame({ ui: { custom: (f: (tui: { requestRender(): void }, theme: { fg(c: string, s: string): string }) => object, o: Record<string, unknown>) => { called += 1; factory = f; options = o; return new Promise<never>(() => {}); } } });
  assert.equal(called, 1, 'dispose 后可重注册');
});

test('registerSlimFrame：PI_HERDR_SLIM_FRAME=0 逃生口', () => {
  const prev = process.env.PI_HERDR_SLIM_FRAME;
  process.env.PI_HERDR_SLIM_FRAME = '0';
  try {
    let called = 0;
    registerSlimFrame({ ui: { custom: () => { called += 1; return new Promise<never>(() => {}); } } });
    assert.equal(called, 0);
  } finally {
    if (prev === undefined) delete process.env.PI_HERDR_SLIM_FRAME;
    else process.env.PI_HERDR_SLIM_FRAME = prev;
  }
});

test('D98 resize watchdog：尺寸变化 → requestRender；未变化不重绘；dispose 解除 SIGWINCH', () => {
  const listenersBefore = process.listenerCount('SIGWINCH');
  let renders = 0;
  let factory!: (tui: { requestRender(): void }, theme: { fg(c: string, s: string): string }) => object;
  const custom = (f: typeof factory, _o: unknown) => {
    factory = f;
    return new Promise<never>(() => {}); // done() is never called: the overlay stays resident
  };
  registerSlimFrame({ ui: { custom } });
  const comp = factory({ requestRender: () => { renders += 1; } }, { fg: (_c, s) => s }) as {
    dispose(): void;
    viewportSize(): { cols: number; rows: number };
    onMaybeResized(): void;
  };
  assert.equal(process.listenerCount('SIGWINCH'), listenersBefore + 1, '注册后挂上 SIGWINCH');

  let size = { cols: 150, rows: 43 };
  comp.viewportSize = () => size;
  comp.onMaybeResized(); // seeds the baseline (0×0 read at construction → 150×43)
  assert.equal(renders, 1);

  comp.onMaybeResized(); // unchanged size → no repaint
  assert.equal(renders, 1);

  size = { cols: 150, rows: 4 }; // heat-reflow compressed the pane → exactly one repaint (the D98 fix)
  comp.onMaybeResized();
  assert.equal(renders, 2);

  comp.dispose();
  assert.equal(process.listenerCount('SIGWINCH'), listenersBefore, 'dispose 后解除 SIGWINCH');
});

test('D98 resize watchdog：轮询兜底发现尺寸变化（SIGWINCH 丢失场景）', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    let renders = 0;
    let factory!: (tui: { requestRender(): void }, theme: { fg(c: string, s: string): string }) => object;
    const custom = (f: typeof factory, _o: unknown) => {
      factory = f;
      return new Promise<never>(() => {});
    };
    registerSlimFrame({ ui: { custom } });
    const comp = factory({ requestRender: () => { renders += 1; } }, { fg: (_c, s) => s }) as {
      dispose(): void;
      viewportSize(): { cols: number; rows: number };
    };
    let size = { cols: 150, rows: 43 };
    comp.viewportSize = () => size;

    mock.timers.tick(RESIZE_WATCHDOG_MS); // baseline sync (0×0 → 150×43)
    assert.equal(renders, 1);
    mock.timers.tick(RESIZE_WATCHDOG_MS); // unchanged → no repaint
    assert.equal(renders, 1);

    size = { cols: 150, rows: 8 }; // shrunk; the poll catches it when SIGWINCH is lost
    mock.timers.tick(RESIZE_WATCHDOG_MS);
    assert.equal(renders, 2);

    comp.dispose();
    mock.timers.tick(RESIZE_WATCHDOG_MS * 10); // polling stops after dispose
    assert.equal(renders, 2);
  } finally {
    mock.timers.reset();
  }
});

const todo = (content: string, status: TodoItem['status']): TodoItem => ({ content, status });

test('slimContentLines：空列表 → 居中 no todos yet（不再是 ·）', () => {
  const lines = slimContentLines({ title: null, items: [], width: 40, rows: 8 });
  assert.equal(lines.length, 8);
  assert.ok(lines.every((l) => styledWidth(l) === 40));
  assert.ok(lines.some((l) => l.includes(SLIM_EMPTY_COPY)));
  assert.ok(!lines.some((l) => l.trim() === '·'));
});

test('slimContentLines：行数 < 3 或列数 < 16 → title 档', () => {
  const items = [todo('implement auth', 'in_progress'), todo('write tests', 'pending')];
  const short = slimContentLines({ title: '▶1 ○1 · implement auth', items, width: 40, rows: 2 });
  assert.equal(short.length, 2);
  assert.ok(short.some((l) => l.includes('▶1 ○1')), '矮格走 title');
  assert.ok(!short.some((l) => l.includes('todo:')), '不画 todo 窗');

  const narrow = slimContentLines({ title: '▶1 ○1 · implement auth', items, width: SLIM_TODO_MIN_COLS - 1, rows: 8 });
  assert.ok(narrow.some((l) => l.includes('▶1 ○1')));
  assert.ok(!narrow.some((l) => l.includes('todo:')));
});

test('slimContentLines：中档围绕 in_progress 填满可用行', () => {
  const items = Array.from({ length: 12 }, (_, i) =>
    todo(`task-${i}`, i === 4 ? 'in_progress' : 'pending'));
  const lines = slimContentLines({
    title: '▶1 ○11 · task-4',
    items,
    width: 40,
    rows: 8,
  });
  assert.equal(lines.length, 8);
  assert.ok(lines.every((l) => styledWidth(l) === 40), '满宽不透明');
  const joined = lines.join('\n');
  assert.match(joined, /todo: 1▶ 11○/);
  assert.ok(joined.includes('▶ task-4'), '锚点可见');
  assert.ok(joined.includes('hidden'), '超窗有 +N');
  assert.equal(lines[0].trim().startsWith('todo:'), true, '顶对齐');
});

test('slimContentLines：列表能放下则不画 hidden 行', () => {
  const items = [todo('a', 'in_progress'), todo('b', 'pending')];
  const lines = slimContentLines({ title: '▶1 ○1 · a', items, width: 40, rows: 8 });
  const joined = lines.join('\n');
  assert.ok(joined.includes('▶ a'));
  assert.ok(joined.includes('○ b'));
  assert.ok(!joined.includes('hidden'));
});

test('slimContentLines：归档列表走 title 档', () => {
  const items = [todo('old', 'completed'), todo('done', 'completed')];
  const title = '✓2 done 2h';
  const lines = slimContentLines({
    title,
    items,
    lastWriteAt: 0,
    now: 2 * 60 * 60_000,
    width: 40,
    rows: 8,
  });
  assert.ok(lines.some((l) => l.includes('✓2 done 2h')));
  assert.ok(!lines.some((l) => l.includes('todo:')));
});

test('slimContentLines：刚好够格的窗口画 todo 窗（阈值边界）', () => {
  // SLIM_TODO_MIN_ROWS is the boundary: exactly that many rows fit header + body, one fewer does not.
  const items = [todo('a', 'in_progress'), todo('b', 'pending')];
  const full = slimContentLines({ title: '▶1 ○1 · a', items, width: 40, rows: SLIM_TODO_MIN_ROWS });
  assert.ok(full.some((l) => l.includes('▶ a')), 'at the row threshold the todo window renders');
  const short = slimContentLines({ title: '▶1 ○1 · a', items, width: 40, rows: SLIM_TODO_MIN_ROWS - 1 });
  assert.ok(!short.some((l) => l.includes('▶ a')), 'one row short falls back to the title frame');
});
