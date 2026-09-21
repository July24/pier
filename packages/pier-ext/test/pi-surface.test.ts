/**
 * pi-surface: the per-module registration proxy (D79) plus its tombstone compensation.
 * Seam: PiSurface.forModule(key) → scoped surface; disposeModule/ledger.disposeKey flip tombstones.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PiSurface } from '../src/pi-surface.ts';
import { DisposeLedger } from '../src/ledger.ts';
import { fakePi, fire, type FakePi } from './test-utils.ts';

const callTool = (pi: FakePi, name: string, ...a: unknown[]) => pi.tools.get(name)?.execute?.(...a);

/** Mount a generation: a `demo` tool returning `tag`, plus a turn_start handler counting its fires. */
function mount(s: PiSurface<FakePi>, key: string, tag: string): { fired: () => number } {
  let fired = 0;
  const scoped = s.forModule(key);
  scoped.registerTool({ name: 'demo', execute: async () => tag });
  scoped.on('turn_start', () => { fired++; });
  return { fired: () => fired };
}

test('surface: registrations pass through while the generation is alive', async () => {
  const pi = fakePi();
  const scoped = new PiSurface(pi).forModule('core/a');
  let fired = 0;
  scoped.on('session_start', () => { fired++; });
  scoped.registerTool({ name: 't1', execute: async () => 'OK' });
  await fire(pi, 'session_start');
  assert.equal(fired, 1);
  assert.equal(await callTool(pi, 't1'), 'OK');
});

test('surface: disposeModule tombstones the handler and puts the tool inert', async () => {
  const pi = fakePi();
  const s = new PiSurface(pi);
  const scoped = s.forModule('core/a');
  let fired = 0;
  scoped.on('turn_start', () => { fired++; });
  scoped.registerTool({ name: 't1', execute: async () => 'OK' });
  assert.equal(s.disposeModule('core/a'), true);
  await fire(pi, 'turn_start');
  assert.equal(fired, 0, 'a tombstoned handler must not fire (hmr double-fire fix)');
  assert.match(((await callTool(pi, 't1')) as { content: Array<{ text: string }> }).content[0]!.text, /disposed/);
  assert.equal(s.disposeModule('core/a'), false, 'a second dispose is an idempotent false');
});

test('surface: hot swap — the new generation wins and the old handler stays silent', async () => {
  const pi = fakePi();
  const s = new PiSurface(pi);
  const v1 = mount(s, 'core/a', 'v1');
  s.disposeModule('core/a'); // hmr compensation tears the old generation down
  const v2 = mount(s, 'core/a', 'v2');
  assert.equal(await callTool(pi, 'demo'), 'v2', 'tools overwrite by name: the new version wins');
  await fire(pi, 'turn_start');
  assert.equal(v1.fired(), 0, 'the old handler is tombstoned (no double fire)');
  assert.equal(v2.fired(), 1, 'the new handler fires once');
});

test('surface: ledger interlock — disposing a key flips its tombstone', async () => {
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const s = new PiSurface(pi, ledger);
  let fired = 0;
  s.forModule('core/a').on('session_start', () => { fired++; });
  ledger.disposeKey('core/a'); // the same path hmr/reload takes
  await fire(pi, 'session_start');
  assert.equal(fired, 0, 'ledger compensation is a tombstone');
});

test('surface: hmr ordering — a disposeKey after the remount must not kill the new generation', async () => {
  // Real cordis-plugin-hmr order: registry.delete → the replacement remounts on the same key →
  // emit('hmr/reload') → ledger.disposeKey(file). Generations mounted after the ledger entry are
  // exempt, so the replacement's tools survive instead of dying on arrival.
  const pi = fakePi();
  const ledger = new DisposeLedger();
  const s = new PiSurface(pi, ledger);
  const KEY = 'file:///F:/repo/src/plugins/demo.ts';
  const v1 = mount(s, KEY, 'v1');
  await fire(pi, 'turn_start');
  assert.equal(v1.fired(), 1, 'precondition: v1 alive');

  const v2 = mount(s, KEY, 'v2'); // the replacement body runs and re-registers
  ledger.disposeKey(KEY); // compensation arrives only after the remount

  assert.equal(await callTool(pi, 'demo'), 'v2', 'the new generation must survive (dead-on-arrival regression)');
  await fire(pi, 'turn_start');
  assert.equal(v1.fired(), 1, 'the old generation went no-op at remount (no double fire)');
  assert.equal(v2.fired(), 1, 'the new generation fires');
});

test('surface: pi 0.86 unsubscribe — retirement removes the listener instead of only tombstoning it', async () => {
  const base = fakePi();
  const removed: string[] = [];
  const pi: FakePi = {
    ...base,
    on(event, handler) {
      base.on(event, handler);
      return () => {
        base.listeners.set(event, (base.listeners.get(event) ?? []).filter((h) => h !== handler));
        removed.push(event);
      };
    },
  };
  const s = new PiSurface(pi);
  const scoped = s.forModule('core/a');
  let fired = 0;
  scoped.on('turn_start', () => { fired++; });
  scoped.registerTool({ name: 't1', execute: async () => 'OK' });
  await fire(pi, 'turn_start');
  assert.equal(fired, 1);
  assert.deepEqual(removed, [], 'no early unsubscribe while alive');

  s.disposeModule('core/a');
  assert.deepEqual(removed, ['turn_start'], 'retirement calls the unsubscribe');
  assert.deepEqual(pi.listeners.get('turn_start') ?? [], [], 'the dispatch list really shrinks');
  assert.match(((await callTool(pi, 't1')) as { content: Array<{ text: string }> }).content[0]!.text, /disposed/, 'tools still tombstone: pi has no unregisterTool');
});
