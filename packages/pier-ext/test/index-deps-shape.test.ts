/**
 * D98 防回归：index.ts 的 subagent-deps provide 形状（用户实证启动崩溃）。
 *
 * 事故：fe99252 重构 deps 时丢了 `slots` 字段（还引入 deliverNotice 重复键）——
 * loader 路径（master 真启动）d.slots === undefined → subagent 插件挂载即炸
 * "Cannot set properties of undefined (setting 'applyReplySession')"。
 * 单测（spawn/core-subagent）都自己造完整 deps，provide 形状无人守——本测
 * 用正则从源码提取 provide 调用，锁死 SubagentDeps 必需键全部在场。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');

const depsBody = (() => {
  const open = src.indexOf("provide('pi-herdr.subagent-deps', {");
  assert.ok(open >= 0, 'provide 调用存在');
  const from = src.indexOf('{', open);
  // 同文件括号配平（对象字面量无嵌套复杂度，逐字符扫描足够）
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return '';
})();

test('subagent-deps provide：SubagentDeps 全部必需键在场（slots 崩溃防回归）', () => {
  assert.ok(depsBody.length > 0);
  const body = depsBody;
  for (const key of [
    'client', 'env', 'extPath', 'sessionRoot', 'slots',
    'getSessionId', 'getBlockedDepth', 'reconcileOnSettlement',
    'withReconcileNotes', 'claimSettleNotice', 'terminalState', 'todos',
  ]) {
    // 键两种形态：`key: value` 或简写 `key,`
    assert.ok(
      new RegExp(`(^|[\\s{])${key}[:,\\s]`).test(body),
      `deps 缺 "${key}" —— loader 路径挂载即崩（D98 实证）`,
    );
  }
});

test('subagent-deps provide：无重复键（deliverNotice 双写防回归）', () => {
  const keys = [...depsBody.matchAll(/(^|[\s{])([A-Za-z]+):/g)].map((x) => x[2]);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual(dupes, [], `重复键：${dupes.join(', ')}`);
});
