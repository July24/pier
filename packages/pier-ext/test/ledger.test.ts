/**
 * 档1 dispose 账本（D80⑤ hmr 补偿 + D79 反注册共用）。
 * 缝：DisposeLedger（纯逻辑）——add/disposeKey(按文件)/disposeAll(LIFO)/normalizeModuleKey。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { DisposeLedger, normalizeModuleKey } from '../src/ledger.ts';

test('ledger：disposeKey 只拆匹配 key（hmr 补偿语义），未匹配保留', () => {
  const led = new DisposeLedger();
  const ran: string[] = [];
  led.add('F:/x/src/a.ts', () => ran.push('a'));
  led.add('F:/x/src/b.ts', () => ran.push('b'));
  led.add('F:/x/src/a.ts', () => ran.push('a2'));
  const n = led.disposeKey('F:\\x\\src\\a.ts'); // Windows 路径形态也要命中
  assert.equal(n, 2);
  assert.deepEqual(ran.sort(), ['a', 'a2']);
  assert.equal(led.size, 1, 'b 保留');
});

test('ledger：disposeAll LIFO（与 cordis effect 语义一致）；异常不中断后续拆除', () => {
  const led = new DisposeLedger();
  const ran: string[] = [];
  led.add('a', () => ran.push('1'));
  led.add('b', () => { throw new Error('boom'); });
  led.add('c', () => ran.push('3'));
  const n = led.disposeAll();
  assert.equal(n, 3);
  assert.deepEqual(ran, ['3', '1'], 'LIFO 且异常被吞');
  assert.equal(led.size, 0);
});

test('ledger：add 返回撤销函数（资源自拆后移除，防 hmr 补偿二次拆）', () => {
  const led = new DisposeLedger();
  let disposed = 0;
  const undo = led.add('a', () => disposed++);
  undo();
  assert.equal(led.size, 0);
  assert.equal(led.disposeKey('a'), 0, '已撤销不再拆');
  assert.equal(disposed, 0);
});

test('normalizeModuleKey：file:// URL 与路径互比（import.meta.url vs hmr filename）', () => {
  // 平台原生绝对路径对（pathToFileURL 内部会 resolve，异平台形态路径不能跨平台回环）
  const native = resolve('x.ts');
  assert.equal(normalizeModuleKey(pathToFileURL(native).href), normalizeModuleKey(native));
  // Windows hmr filename 形态：反斜杠统一为斜杠（纯字符串语义，与平台无关）
  assert.equal(normalizeModuleKey('F:\\repo\\pier\\x.ts'), 'F:/repo/pier/x.ts');
  assert.equal(normalizeModuleKey('pi-surface'), 'pi-surface', '逻辑名原样（D79 反注册场景）');
});
