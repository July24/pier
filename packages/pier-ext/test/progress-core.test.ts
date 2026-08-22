/**
 * M16：进度徽标 + 速率估算（开发方案.md §M16；保守形态优先）。
 * 缝：estimateEta / formatProgressSuffix / planToolBadge（纯函数）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ETA_MIN_SAMPLES,
  PROGRESS_HIDE_MS,
  RATE_WINDOW_MS,
  UNFINISHED_CAP,
  estimateEta,
  formatProgressSuffix,
  planToolBadge,
} from '../src/progress-core.ts';

/* ── 速率估算（kimi 估算器语义：窗口速率 + 未完成 cap + 置信度门） ── */

test('estimateEta：<2 完成点 → null（保守：只显示 N/M）', () => {
  assert.equal(ETA_MIN_SAMPLES, 2);
  assert.equal(estimateEta({ completedAt: [], total: 7, now: 1000 }), null);
  assert.equal(estimateEta({ completedAt: [1000], total: 7, now: 2000 }), null);
});

test('estimateEta：≥2 完成点 → 按点间距估速率；剩余 × 间距 = eta', () => {
  // 3 个点：0s、60s、120s 完成 → 速率 = 2 步/120s = 1 步/60s；剩 4 步 → eta 240s
  const e = estimateEta({ completedAt: [0, 60_000, 120_000], total: 7, now: 130_000 });
  assert.ok(e);
  assert.equal(e!.remaining, 4);
  assert.equal(e!.etaMs, 240_000);
  assert.equal(e!.confidence, 'ok');
});

test('estimateEta：完成点全在窗口外（陈旧）→ null', () => {
  // 完成于 10 分钟前，now 远离 → 陈旧不估
  assert.equal(
    estimateEta({ completedAt: [0, 60_000], total: 7, now: 10 * 60_000 }),
    null,
  );
});

test('estimateEta：全部完成（remaining=0）→ eta 0；total=0 → null', () => {
  const done = estimateEta({ completedAt: [0, 60_000], total: 2, now: 61_000 });
  assert.ok(done);
  assert.equal(done!.etaMs, 0);
  assert.equal(estimateEta({ completedAt: [0, 60_000], total: 0, now: 61_000 }), null);
});

test('estimateEta：爆发后停顿（完成点新鲜度超窗）→ null', () => {
  // 10 秒内完成 2 步（爆发），然后 20 分钟无进展 → 数据陈旧，不估
  assert.equal(
    estimateEta({ completedAt: [590_000, 600_000], total: 7, now: 1_800_000 }),
    null,
  );
});

/* ── 进度后缀（title 内嵌，保守 N/M 优先） ─────────────────────── */

test('formatProgressSuffix：保守 N/M；无 eta 只报计数；total=0 空', () => {
  assert.equal(formatProgressSuffix({ completed: 3, total: 7, eta: null }), '3/7');
  assert.equal(formatProgressSuffix({ completed: 3, total: 7, eta: { etaMs: 240_000, confidence: 'ok' } }), '3/7 ~4m');
  assert.equal(formatProgressSuffix({ completed: 0, total: 0, eta: null }), '');
  assert.equal(formatProgressSuffix({ completed: 5, total: 5, eta: null }), '5/5 ✓');
});

test('formatProgressSuffix：eta 取整到分钟（<60s 显示 <1m；小时用 h）', () => {
  assert.equal(formatProgressSuffix({ completed: 1, total: 9, eta: { etaMs: 30_000, confidence: 'ok' } }), '1/9 <1m');
  assert.equal(formatProgressSuffix({ completed: 1, total: 9, eta: { etaMs: 90_000, confidence: 'ok' } }), '1/9 ~2m');
  assert.equal(formatProgressSuffix({ completed: 1, total: 9, eta: { etaMs: 3_600_000, confidence: 'ok' } }), '1/9 ~1h');
});

/* ── 工具徽标（report_agent.message 通道） ─────────────────────── */

test('planToolBadge：单工具名；多工具首 + 计数；空 → null（不覆盖）', () => {
  assert.equal(planToolBadge([]), null);
  assert.equal(planToolBadge(['bash']), '🔧 bash');
  assert.equal(planToolBadge(['bash', 'read', 'grep']), '🔧 bash +2');
});

/* ── 常量锁定（kimi 语义对齐） ─────────────────────────────────── */

test('常量：窗口 45s / cap 0.85 / 展示超时隐藏', () => {
  assert.equal(RATE_WINDOW_MS, 45_000);
  assert.equal(UNFINISHED_CAP, 0.85);
  assert.ok(PROGRESS_HIDE_MS > 0);
});
