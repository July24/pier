/**
 * D98 regression: subagent-deps provide shape (boot crash).
 *
 * Accident: fe99252 dropped `slots` (and duplicated deliverNotice) — loader
 * path crashed `Cannot set properties of undefined (setting 'applyReplySession')`.
 * The bag is now `port`; this test regex-locks required keys in index-master.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../src/index-master.ts', import.meta.url)), 'utf8');

const depsBody = (() => {
  const open = src.indexOf("provide('pi-herdr.subagent-deps', {");
  assert.ok(open >= 0, 'provide call exists');
  const from = src.indexOf('{', open);
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

test('subagent-deps provide: all required SubagentDeps keys present (port crash guard)', () => {
  assert.ok(depsBody.length > 0);
  const body = depsBody;
  for (const key of [
    'client', 'env', 'extPath', 'sessionRoot', 'port',
    'getSessionId', 'getBlockedDepth', 'reconcileOnSettlement',
    'withReconcileNotes', 'claimSettleNotice', 'terminalState', 'todos',
  ]) {
    assert.ok(
      new RegExp(`(^|[\\s{])${key}[:,\\s]`).test(body),
      `deps missing "${key}" — loader mount crashes (D98)`,
    );
  }
});

test('subagent-deps provide: no duplicate keys (deliverNotice double-write guard)', () => {
  const keys = [...depsBody.matchAll(/(^|[\s{])([A-Za-z]+):/g)].map((x) => x[2]);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual(dupes, [], `duplicate keys: ${dupes.join(', ')}`);
});
