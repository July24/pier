/** D97 slim frame: visibility predicate, width-aware wrapping, frame lines, overlay lifecycle, tiers. */
import { mock, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SLIM_EMPTY_COPY, SLIM_MIN_COLS, SLIM_MIN_ROWS, SLIM_TODO_MIN_COLS, SLIM_TODO_MIN_ROWS, RESIZE_WATCHDOG_MS,
  frameLines, isSlimFrame, registerSlimFrame, resetForTest, slimContentLines, updateSlimFrame, type SlimFrameInput,
} from '../src/slim-frame.ts';
import { styledWidth, wrapStyled } from '../src/ansi-text.ts';
import type { TodoItem } from '../src/vocab.ts';
import { withCleanup } from './test-utils.ts';

beforeEach(() => resetForTest());

const todo = (content: string, status: TodoItem['status']): TodoItem => ({ content, status });
const TWO = [todo('implement auth', 'in_progress'), todo('write tests', 'pending')];

interface Overlay {
  dispose(): void; render(width: number): string[]; viewportSize(): { cols: number; rows: number }; onMaybeResized(): void;
}

/** Drives the factory pi would call; `done()` is never invoked, so the overlay stays resident. */
function mountOverlay(): { comp: Overlay; options: Record<string, unknown>; renders: () => number } {
  let factory!: (tui: { requestRender(): void }, theme: { fg(c: string, s: string): string }) => object;
  let options!: Record<string, unknown>;
  let count = 0;
  const custom = (f: typeof factory, o: Record<string, unknown>) => { factory = f; options = o; return new Promise<never>(() => {}); };
  registerSlimFrame({ ui: { custom } });
  return { comp: factory({ requestRender: () => { count += 1; } }, { fg: (_c, s) => s }) as unknown as Overlay, options, renders: () => count };
}

test('isSlimFrame：任一轴低于 TUI 下限即静帧', async (t) => {
  const cases = [
    { name: '窄列（左右拆分布局）', cols: SLIM_MIN_COLS - 1, rows: 50, expected: true },
    { name: '矮条（D97 新拓扑非焦点格）', cols: 200, rows: SLIM_MIN_ROWS - 1, expected: true },
    { name: '两轴刚好达标 → 真 TUI', cols: SLIM_MIN_COLS, rows: SLIM_MIN_ROWS, expected: false },
    { name: '宽裕面板', cols: 200, rows: 50, expected: false },
  ];
  for (const c of cases) await t.test(c.name, () => assert.equal(isSlimFrame(c.cols, c.rows), c.expected));
});

test('frameLines：垂直居中 + 满宽补齐 + 行数钳制；空 title 落一枚 ·', () => {
  // Full-width padding: a partial row would leak the TUI underneath and reintroduce the flicker.
  const lines = frameLines('▶2 ○11 ✓1 · 正在做的事', { width: 10, rows: 5 });
  assert.equal(lines.length, 5);
  assert.ok(lines.every((l) => styledWidth(l) === 10), '每行满宽（不透明冻结，不漏底）');
  assert.ok(lines.some((l) => l.includes('▶2 ○11')), '内容行可见');
  assert.ok(lines[0].trim() === '', '首行留白（居中）');
  const clamped = frameLines('aaa bbb ccc ddd', { width: 3, rows: 2 });
  assert.equal(clamped.length, 2, '行数少于内容 → 只保留前几行');

  const empty = frameLines('', { width: 8, rows: 3 });
  assert.equal(empty.length, 3);
  assert.ok(empty[1].includes('·'), '空 title → 居中一枚 ·（活着、没计划）');
  assert.ok(empty.every((l) => styledWidth(l) === 8), '满宽补齐');
});

test('wrapStyled：CJK 双宽、英文空格让位、短行不折', () => {
  assert.equal(styledWidth('▶2 ○11'), 6);
  assert.deepEqual(wrapStyled('探查渠道费用触点', 4), ['探查', '渠道', '费用', '触点']);
  assert.deepEqual(wrapStyled('map channel fees', 8), ['map', 'channel', 'fees']);
  assert.deepEqual(wrapStyled('short', 10), ['short']);
});

test('registerSlimFrame：无 ui / 无 custom / 逃生口都不注册，且不占用单例', withCleanup((cleanup) => {
  let called = 0;
  const bump = (): Promise<never> => { called += 1; return new Promise<never>(() => {}); };
  registerSlimFrame(null);
  registerSlimFrame({ ui: {} });
  updateSlimFrame({ title: 'x' }); // no active overlay yet: a no-op
  registerSlimFrame({ ui: { custom: bump } });
  assert.equal(called, 1, '静默跳过的注册不得占用单例');

  for (const key of ['PIER_SLIM_FRAME', 'PI_HERDR_SLIM_FRAME']) {
    resetForTest();
    cleanup.env().set(key, '0'); // legacy spelling must keep working
    registerSlimFrame({ ui: { custom: bump } });
    assert.equal(called, 1, `${key}=0 逃生口`);
  }
}));

test('registerSlimFrame：注册 → visible 随尺寸切换 → dispose 后可重注册', () => {
  const { comp, options, renders } = mountOverlay();

  assert.equal(options.overlay, true, '浮层不清屏');
  const overlayOptions = options.overlayOptions as { nonCapturing: boolean; visible: (c: number, r: number) => boolean };
  assert.equal(overlayOptions.nonCapturing, true, '键盘不捕获');
  assert.equal(overlayOptions.visible(10, 40), true);
  assert.equal(overlayOptions.visible(200, SLIM_MIN_ROWS - 1), true);
  assert.equal(overlayOptions.visible(200, 50), false);

  updateSlimFrame({ title: '▶1 ○2 · task' });
  assert.equal(renders(), 1);
  updateSlimFrame({ title: '▶1 ○2 · task' }); // identical text is idempotent (no repaint)
  assert.equal(renders(), 1);

  const lines = comp.render(10);
  assert.ok(lines.length >= 1 && lines.every((l) => styledWidth(l) === 10));

  comp.dispose();
  let called = 0;
  registerSlimFrame({ ui: { custom: () => { called += 1; return new Promise<never>(() => {}); } } });
  assert.equal(called, 1, 'dispose 后可重注册');
});

test('D98 resize watchdog：尺寸变化 → requestRender；未变化不重绘；dispose 解除监听/轮询', async (t) => {
  await t.test('SIGWINCH', () => {
    const listenersBefore = process.listenerCount('SIGWINCH');
    const { comp, renders } = mountOverlay();
    assert.equal(process.listenerCount('SIGWINCH'), listenersBefore + 1, '注册后挂上 SIGWINCH');

    const size = { cols: 150, rows: 43 };
    comp.viewportSize = () => size;
    comp.onMaybeResized(); // seeds the baseline (0×0 read at construction → 150×43)
    assert.equal(renders(), 1);
    comp.onMaybeResized(); // unchanged size → no repaint
    assert.equal(renders(), 1);
    size.rows = 4; // heat-reflow compressed the pane → exactly one repaint (the D98 fix)
    comp.onMaybeResized();
    assert.equal(renders(), 2);

    comp.dispose();
    assert.equal(process.listenerCount('SIGWINCH'), listenersBefore, 'dispose 后解除 SIGWINCH');
  });

  await t.test('轮询兜底（SIGWINCH 丢失场景）', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const { comp, renders } = mountOverlay();
      const size = { cols: 150, rows: 43 };
      comp.viewportSize = () => size;

      mock.timers.tick(RESIZE_WATCHDOG_MS); // baseline sync (0×0 → 150×43)
      assert.equal(renders(), 1);
      mock.timers.tick(RESIZE_WATCHDOG_MS); // unchanged → no repaint
      assert.equal(renders(), 1);
      size.rows = 8; // shrunk; the poll catches it when SIGWINCH is lost
      mock.timers.tick(RESIZE_WATCHDOG_MS);
      assert.equal(renders(), 2);

      comp.dispose();
      mock.timers.tick(RESIZE_WATCHDOG_MS * 10); // polling stops after dispose
      assert.equal(renders(), 2);
    } finally {
      mock.timers.reset();
    }
  });
});

interface TierCase { name: string; input: SlimFrameInput & { width: number; rows: number }; expect: string[]; absent: string[] }

const TIER_CASES: TierCase[] = [
  { name: '空列表 → 居中 SLIM_EMPTY_COPY（不再是 ·）', input: { title: null, items: [], width: 40, rows: 8 }, expect: [SLIM_EMPTY_COPY], absent: ['·'] },
  { name: '行数 < 3 → title 档', input: { title: '▶1 ○1 · implement auth', items: TWO, width: 40, rows: 2 }, expect: ['▶1 ○1'], absent: ['todo:'] },
  { name: '列数 < 16 → title 档', input: { title: '▶1 ○1 · implement auth', items: TWO, width: SLIM_TODO_MIN_COLS - 1, rows: 8 }, expect: ['▶1 ○1'], absent: ['todo:'] },
  { name: '归档列表 → title 档', input: { title: '✓2 done 2h', items: [todo('old', 'completed'), todo('done', 'completed')], lastWriteAt: 0, now: 2 * 60 * 60_000, width: 40, rows: 8 }, expect: ['✓2 done 2h'], absent: ['todo:'] },
  // SLIM_TODO_MIN_ROWS is the boundary: exactly that many rows fit header + body, one fewer does not.
  { name: '刚好够格 → todo 窗', input: { title: '▶1 ○1 · a', items: [todo('a', 'in_progress'), todo('b', 'pending')], width: 40, rows: SLIM_TODO_MIN_ROWS }, expect: ['▶ a'], absent: [] },
  { name: '少一行 → 退回 title 帧', input: { title: '▶1 ○1 · a', items: [todo('a', 'in_progress'), todo('b', 'pending')], width: 40, rows: SLIM_TODO_MIN_ROWS - 1 }, expect: [], absent: ['▶ a'] },
];

test('slimContentLines：空列表 / 矮窗 / 窄窗 / 归档按档位退让', async (t) => {
  for (const c of TIER_CASES) {
    await t.test(c.name, () => {
      const lines = slimContentLines(c.input);
      assert.equal(lines.length, c.input.rows);
      assert.ok(lines.every((l) => styledWidth(l) === c.input.width), '满宽不透明');
      const joined = lines.join('\n');
      for (const e of c.expect) assert.ok(joined.includes(e), `expect ${e}`);
      for (const a of c.absent) assert.ok(!joined.includes(a), `absent ${a}`);
    });
  }
});

test('slimContentLines：中档围绕 in_progress 填满可用行，列表放得下就不画 hidden', async (t) => {
  const cases = [
    { name: '超窗列表：锚点可见 + hidden 计数', title: '▶1 ○11 · task-4', items: Array.from({ length: 12 }, (_, i) => todo(`task-${i}`, i === 4 ? 'in_progress' : 'pending')), expect: ['todo: 1▶ 11○', '▶ task-4', 'hidden'], absent: [] as string[] },
    { name: '列表放得下：无 hidden 行', title: '▶1 ○1 · a', items: [todo('a', 'in_progress'), todo('b', 'pending')], expect: ['▶ a', '○ b'], absent: ['hidden'] },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      const lines = slimContentLines({ title: c.title, items: c.items, width: 40, rows: 8 });
      assert.equal(lines.length, 8);
      assert.ok(lines.every((l) => styledWidth(l) === 40), '满宽不透明');
      assert.equal(lines[0].trim().startsWith('todo:'), true, '顶对齐');
      const joined = lines.join('\n');
      for (const e of c.expect) assert.ok(joined.includes(e), `expect ${e}`);
      for (const a of c.absent) assert.ok(!joined.includes(a), `absent ${a}`);
    });
  }
});
