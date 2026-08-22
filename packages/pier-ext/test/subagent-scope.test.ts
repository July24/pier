/**
 * 档 0：subagent fiber + effect LIFO。
 * 缝：createSessionRoot / mountSubagentScope / dispose。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionRoot,
  disposeSessionRoot,
  mountSubagentScope,
} from '../src/subagent-scope.ts';

test('子作用域 dispose 只清自己的 effect，兄弟还在', async () => {
  const root = createSessionRoot();
  const log: string[] = [];
  const a = await mountSubagentScope(root, 'pA', {
    onDispose: () => { log.push('a'); },
  });
  const b = await mountSubagentScope(root, 'pB', {
    onDispose: () => { log.push('b'); },
  });
  await a.dispose();
  assert.deepEqual(log, ['a']);
  await disposeSessionRoot(root);
  assert.deepEqual(log, ['a', 'b']);
  await b.dispose(); // 二次 dispose 是 no-op
  assert.deepEqual(log, ['a', 'b']);
});

test('root dispose 清 session 级 effect（GC ticker）', async () => {
  const log: string[] = [];
  const root = createSessionRoot({
    onDispose: () => { log.push('session'); },
  });
  await mountSubagentScope(root, 'pA', { onDispose: () => { log.push('a'); } });
  await disposeSessionRoot(root);
  assert.ok(log.includes('session'));
  assert.ok(log.includes('a'));
});
