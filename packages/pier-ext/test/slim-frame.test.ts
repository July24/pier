/**
 * D97 窄格静帧单测：可见性谓词 / 宽度感知折行 / 静帧行 / overlay 注册生命周期。
 * 缝：纯函数 + 进程内单例（resetForTest 隔离）。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SLIM_MIN_COLS,
  SLIM_MIN_ROWS,
  displayWidth,
  frameLines,
  isSlimFrame,
  registerSlimFrame,
  resetForTest,
  updateSlimFrame,
  wrapByWidth,
} from '../src/slim-frame.ts';

beforeEach(() => resetForTest());

test('isSlimFrame：任一轴低于 TUI 下限即静帧', () => {
  assert.equal(isSlimFrame(SLIM_MIN_COLS - 1, 50), true, '竖窄条（左右拆存量布局）');
  assert.equal(isSlimFrame(200, SLIM_MIN_ROWS - 1), true, '矮横条（D97 新拓扑非焦点格）');
  assert.equal(isSlimFrame(SLIM_MIN_COLS, SLIM_MIN_ROWS), false, '两轴达标 → 真 TUI');
  assert.equal(isSlimFrame(200, 50), false);
});

test('displayWidth：CJK 双宽 / ASCII 单宽', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('探查代码'), 8);
  assert.equal(displayWidth('▶2 ○11'), 6);
});

test('wrapByWidth：CJK 硬折 / 英文空格让位 / 短行不折', () => {
  assert.deepEqual(wrapByWidth('探查渠道费用触点', 4), ['探查', '渠道', '费用', '触点']);
  assert.deepEqual(wrapByWidth('map channel fees', 8), ['map', 'channel', 'fees']);
  assert.deepEqual(wrapByWidth('short', 10), ['short']);
});

test('frameLines：垂直居中 + 满宽补齐 + 行数钳制', () => {
  const lines = frameLines('▶2 ○11 ✓1 · 正在做的事', { width: 10, rows: 5 });
  assert.equal(lines.length, 5);
  assert.ok(lines.every((l) => displayWidth(l) === 10), '每行满宽（不透明冻结，不漏底）');
  assert.ok(lines.some((l) => l.includes('▶2 ○11')), '内容行可见');
  assert.ok(lines[0].trim() === '', '首行留白（居中）');
  // 行数小于内容 → 钳到头几行
  const clamped = frameLines('aaa bbb ccc ddd', { width: 3, rows: 2 });
  assert.equal(clamped.length, 2);
});

test('frameLines：空 title → 居中一枚 ·（活着、没计划）', () => {
  const lines = frameLines('', { width: 8, rows: 3 });
  assert.equal(lines.length, 3);
  assert.ok(lines[1].includes('·'), '内容行含 ·');
  assert.ok(lines.every((l) => displayWidth(l) === 8), '满宽补齐');
});

test('registerSlimFrame：无 ui / 无 custom → 静默不注册', () => {
  registerSlimFrame(null);
  registerSlimFrame({ ui: {} });
  // 未抛错且后续 update 是 no-op 即可
  updateSlimFrame('x');
  assert.ok(true);
});

test('registerSlimFrame：注册 → visible 随尺寸切换 → dispose 后可重注册', () => {
  let factory!: (tui: { requestRender(): void }, theme: { fg(c: string, s: string): string }) => object;
  let options!: Record<string, unknown>;
  const custom = (f: typeof factory, o: Record<string, unknown>) => {
    factory = f;
    options = o;
    return new Promise<never>(() => {}); // done 永不调用（overlay 常驻）
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

  // 窄格 → visible true；放大 → false
  assert.equal(overlayOptions.visible(10, 40), true);
  assert.equal(overlayOptions.visible(200, SLIM_MIN_ROWS - 1), true);
  assert.equal(overlayOptions.visible(200, 50), false);

  // 内容更新触发重渲染；幂等（同文本不重绘）
  updateSlimFrame('▶1 ○2 · task');
  assert.equal(renders, 1);
  updateSlimFrame('▶1 ○2 · task');
  assert.equal(renders, 1);

  // 渲染：满宽行
  const lines = comp.render(10);
  assert.ok(lines.length >= 1 && lines.every((l) => displayWidth(l) === 10));

  // dispose 回收单例 → 重注册不被 no-op
  comp.dispose();
  let called = 0;
  registerSlimFrame({ ui: { custom: (f, o) => { called += 1; factory = f; options = o; return new Promise<never>(() => {}); } } });
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
