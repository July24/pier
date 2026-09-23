/** D-4 focus: the pure planners (parse / fire decision / reflow spawn) plus the index.ts wiring.
 *  index.ts builds its herdr client from the environment (no injection seam), so only the wiring test fakes it. */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOCUS_FIRE_MIN_INTERVAL_MS, collectPaneIds, parseFocusSample, planFocusTick, reflowScriptPath, spawnReflow,
  startFocusPoller, isHerdr091OrLater, resolveDefaultFocusPollMs,
  type FocusPollerState, type FocusSample, type SpawnReflowOpts,
} from '../src/focus-poller.ts';
import { herdrSocketTarget } from '../src/herdr-client.ts';
import pier from '../src/index.ts';
import { fakePi, fire, withCleanup, type CleanupContext, type FakePi } from './test-utils.ts';

type SpawnFn = NonNullable<SpawnReflowOpts['spawnFn']>;

const sample = (focused: string | null, paneIds: string[]): FocusSample => ({ focusedPaneId: focused, paneIds });
const state = (focused: string | null, paneIds: string[], lastFireAt = 0): FocusPollerState => ({ lastFocusedPaneId: focused, lastPaneIds: paneIds, lastFireAt });

test('collectPaneIds/parseFocusSample: 真实 layout.export 载荷（单 pane / 分屏 / 缺失 focus）', () => {
  // Observed shape: {type:'layout_export', layout:{focused_pane_id, root:{type:'pane',pane_id}}}
  assert.deepEqual(collectPaneIds({ type: 'pane', pane_id: 'wD:p1' }), ['wD:p1']);
  assert.deepEqual(collectPaneIds({ type: 'split', first: { type: 'pane', pane_id: 'a' }, second: { type: 'split', first: { type: 'pane', pane_id: 'b' }, second: { type: 'pane', pane_id: 'c' } } }), ['a', 'b', 'c']);
  assert.deepEqual(collectPaneIds(null), []);
  assert.deepEqual(parseFocusSample({ root: { type: 'pane', pane_id: 'wD:p2' }, focusedPaneId: 'wD:p2' }), { focusedPaneId: 'wD:p2', paneIds: ['wD:p2'] });
  // An older herdr omits focused_pane_id → null (the caller stays silent instead of treating the root pane as focused)
  assert.deepEqual(parseFocusSample({ root: { type: 'pane', pane_id: 'wD:p2' } }), { focusedPaneId: null, paneIds: ['wD:p2'] });
  assert.equal(parseFocusSample(null), null);
});

test('planFocusTick: 首次采样只记基线；焦点转入本 pane 才触发，cause 取决于同 tick 是否出现新面板', () => {
  // startup: the first sample only records the baseline (starting focused is not a layout change)
  const first = planFocusTick({ myPaneId: 'me', sample: sample('me', ['me']), prev: null, now: 1000 });
  assert.equal(first.fire, false);
  assert.equal(first.state.lastFocusedPaneId, 'me');

  // focus moved onto me with an unchanged pane set ⇒ a human click (cause=user, bypasses the 3s whitelist)
  const click = planFocusTick({ myPaneId: 'me', sample: sample('me', ['other', 'me']), prev: state('other', ['other', 'me']), now: 5000 });
  assert.equal(click.fire, true);
  assert.equal(click.cause, 'user');
  assert.equal(click.state.lastFireAt, 5000);

  // a new pane in the same tick ⇒ cause=null (an auto-focused spawn must not steal the layout, F1)
  const spawn = planFocusTick({ myPaneId: 'me', sample: sample('me', ['other', 'me', 'fresh']), prev: state('other', ['other', 'me']), now: 5000 });
  assert.equal(spawn.fire, true);
  assert.equal(spawn.cause, null);
});

test('planFocusTick: 焦点在别处/没变/空 paneId 都不触发；限流窗口内的连点不重复 spawn', () => {
  assert.equal(planFocusTick({ myPaneId: 'me', sample: sample('other', ['me', 'other']), prev: state('me', ['me', 'other']), now: 9000 }).fire, false);
  // Steady focus must not re-fire (otherwise every tick spawns a reflow).
  assert.equal(planFocusTick({ myPaneId: 'me', sample: sample('me', ['me']), prev: state('me', ['me'], 1000), now: 9000 }).fire, false);
  assert.equal(planFocusTick({ myPaneId: '', sample: sample('me', ['me']), prev: state('other', ['me']), now: 9000 }).fire, false);
  // Focus elsewhere still advances the baseline (leaving and returning counts as a new transition).
  const away = planFocusTick({ myPaneId: 'me', sample: sample('other', ['me', 'other']), prev: state('me', ['me', 'other']), now: 9000 });
  assert.equal(away.state.lastFocusedPaneId, 'other');

  const firstFire = planFocusTick({ myPaneId: 'me', sample: sample('me', ['me', 'o']), prev: state('o', ['me', 'o']), now: 10_000 });
  assert.equal(firstFire.fire, true);
  const at = (now: number) => planFocusTick({ myPaneId: 'me', sample: sample('me', ['me', 'o']), prev: state('o', ['me', 'o'], firstFire.state.lastFireAt), now });
  assert.equal(at(10_000 + FOCUS_FIRE_MIN_INTERVAL_MS - 1).fire, false);
  // Leaving, returning after the throttle window → fires again
  assert.equal(at(10_000 + FOCUS_FIRE_MIN_INTERVAL_MS).fire, true);
});

test('startFocusPoller: 采样→触发一次（样本失败不推进基线）；intervalMs=0 不注册定时器、stop() 幂等', async () => {
  const samples: Array<FocusSample | Error> = [
    sample('other', ['me', 'other']), sample('me', ['me', 'other']),
    new Error('socket down'),
    sample('me', ['me', 'other']), // the failure never advanced the baseline, so this is still a move to "me"
  ];
  const fired: Array<{ paneId: string; cause: string | null }> = [];
  const errors: unknown[] = [];
  let clock = 1000;
  const poller = startFocusPoller({
    myPaneId: 'me',
    intervalMs: 0, // driven manually so the test never runs a real timer
    now: () => (clock += 1000),
    sample: async () => {
      const next = samples.shift();
      if (next instanceof Error) throw next;
      return next ?? null;
    },
    fire: (paneId, cause) => fired.push({ paneId, cause }),
    onError: (e) => errors.push(e),
  });
  for (let i = 0; i < 4; i += 1) await poller.tick();
  poller.stop();
  assert.deepEqual(fired, [{ paneId: 'me', cause: 'user' }]);
  assert.equal(errors.length, 1);

  const idle = startFocusPoller({ myPaneId: 'me', intervalMs: 0, sample: async () => null, fire: () => { throw new Error('must not fire'); } });
  await idle.tick();
  idle.stop();
  idle.stop();
});

test('spawnReflow: 事件载荷/脚本路径正确，spawn 抛错或子进程 error 都不冒泡', () => {
  const seen: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const fakeSpawn = ((_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    seen.push({ args, env: opts.env });
    return { on: () => {}, unref: () => {} };
  }) as unknown as SpawnFn;
  spawnReflow({ paneId: 'wD:p9', cause: 'user', env: { HERDR_SOCKET_PATH: '/tmp/x.sock' }, spawnFn: fakeSpawn });
  assert.equal(seen.length, 1, 'exactly one child process per replay');
  assert.match(seen[0]!.args[0]!, /heat-reflow\.mjs$/);
  assert.equal(seen[0]!.env.HERDR_PLUGIN_EVENT, 'pane.focused');
  assert.equal(seen[0]!.env.HERDR_SOCKET_PATH, '/tmp/x.sock');
  assert.deepEqual(JSON.parse(String(seen[0]!.env.HERDR_PLUGIN_EVENT_JSON)), {
    event: 'pane_focused', type: 'pane_focused', data: { type: 'pane_focused', pane_id: 'wD:p9', cause: 'user' },
  });

  // the script lives in this repo unless a relocated checkout overrides the root
  const def = reflowScriptPath({});
  assert.ok(def.replaceAll('\\', '/').endsWith('packages/pier-workbench/scripts/heat-reflow.mjs'), def);
  assert.equal(reflowScriptPath({ PIER_WORKBENCH_ROOT: '/opt/wb' }), path.join('/opt/wb', 'scripts', 'heat-reflow.mjs'));
  // An npm pi-pier install has no sibling workbench: the checkout recorded by the workbench hooks is used.
  const recordedScript = path.join('/herdr/plugins/pier.workbench', 'scripts', 'heat-reflow.mjs');
  const npmIo = (recorded: string | null) => ({ exists: (f: string) => f === recordedScript, recordedRoot: () => recorded });
  assert.equal(reflowScriptPath({}, npmIo('/herdr/plugins/pier.workbench')), recordedScript);
  assert.ok(reflowScriptPath({}, npmIo(null)).replaceAll('\\', '/').endsWith('packages/pier-workbench/scripts/heat-reflow.mjs'), 'nothing recorded → the sibling default');
  assert.ok(reflowScriptPath({}, { exists: () => true, recordedRoot: () => '/elsewhere' }).replaceAll('\\', '/').endsWith('packages/pier-workbench/scripts/heat-reflow.mjs'), 'an existing sibling wins over the record');

  // focus heat is a comfort feature: neither a throwing spawn nor a child `error` event may escape
  const throwing = (() => { throw new Error('ENOENT'); }) as unknown as SpawnFn;
  spawnReflow({ paneId: 'p', cause: null, env: {}, spawnFn: throwing });
  const emitting = (() => ({ on: (evt: string, cb: () => void) => { if (evt === 'error') cb(); }, unref: () => {} })) as unknown as SpawnFn;
  spawnReflow({ paneId: 'p', cause: null, env: {}, spawnFn: emitting });
});

test('Herdr 0.9.1 adaptive cadence: isHerdr091OrLater and resolveDefaultFocusPollMs', () => {
  for (const version of ['0.9.1', '0.9.1-preview', '0.9.2', '0.10.0', '1.0.0']) assert.equal(isHerdr091OrLater(version), true, version);
  for (const version of ['0.9.0', '0.8.2', '', null, undefined]) assert.equal(isHerdr091OrLater(version), false, String(version));
  assert.equal(resolveDefaultFocusPollMs('0.9.1'), 0);
  assert.equal(resolveDefaultFocusPollMs('0.9.0'), 1500);
  assert.equal(resolveDefaultFocusPollMs(null), 1500);
});

/* ── index.ts wiring ── */
type HerdrServer = { close(): Promise<void>; calls: string[] };

/** Minimal herdr server: answers layout.export with a scripted focus sequence, records every method. */
function fakeHerdrServer(socketPath: string, focuses: Array<string | null>): Promise<HerdrServer> {
  const calls: string[] = [];
  let index = 0;
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let req: { id?: string; method?: string };
      try { req = JSON.parse(buf.slice(0, nl)); } catch { sock.destroy(); return; }
      const method = String(req.method ?? '');
      calls.push(method);
      const focused = focuses[Math.min(index, focuses.length - 1)] ?? null;
      if (method === 'layout.export') index += 1;
      // Both panes always exist; only the focused one moves (a click, not a spawn).
      const root = { type: 'split', first: { type: 'pane', pane_id: 'wX:pOther' }, second: { type: 'pane', pane_id: 'wX:pMe' } };
      const result = method === 'layout.export'
        ? { type: 'layout_export', layout: { workspace_id: 'wX', tab_id: 'wX:t1', zoomed: false, focused_pane_id: focused, root } }
        : { type: 'ok' };
      sock.end(JSON.stringify({ id: req.id ?? '1', result }) + '\n');
    });
  });
  return new Promise<HerdrServer>((resolve) => server.listen(herdrSocketTarget(socketPath), () => resolve({
    calls,
    close: () => new Promise<void>((done) => {
      // closeAllConnections exists at runtime (Node ≥18.2) but is missing from these @types/node.
      const closable = server as unknown as { closeAllConnections?(): void };
      closable.closeAllConnections?.();
      server.close(() => done());
    }),
  })));
}

/** Mounts index.ts (this pane = wX:pMe) over a scripted socket with a reflow stub recording its env. */
async function bootFocusIndex(cleanup: CleanupContext): Promise<{ pi: FakePi; server: HerdrServer; marker: string }> {
  const env = cleanup.env();
  for (const key of ['PI_HERDR_SUBAGENT', 'PI_HERDR_ROLE_MANIFEST']) env.delete(key);
  // PIER_FOCUS_POLL_MS: fast enough for a test, still a real timer.
  for (const [key, value] of Object.entries({ HERDR_ENV: '1', HERDR_PANE_ID: 'wX:pMe', HERDR_TAB_ID: 'wX:t1', HERDR_WORKSPACE_ID: 'wX', PIER_FOCUS_POLL_MS: '40' })) env.set(key, value);

  const tmp = cleanup.tempDir('pier-focus-d4').path;
  const socketPath = path.join(tmp, 'herdr.sock');
  const marker = path.join(tmp, 'reflow.jsonl');
  const wbRoot = path.join(tmp, 'wb');
  env.set('HERDR_SOCKET_PATH', socketPath);
  env.set('PIER_WORKBENCH_ROOT', wbRoot);
  fs.mkdirSync(path.join(wbRoot, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(wbRoot, 'scripts', 'heat-reflow.mjs'),
    `import * as fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, process.env.HERDR_PLUGIN_EVENT + ' ' + process.env.HERDR_PLUGIN_EVENT_JSON + '\\n');\n`);

  // First sample: someone else is focused; every later sample: this pane is focused.
  const server = await fakeHerdrServer(socketPath, ['wX:pOther', 'wX:pMe']);
  const pi = fakePi();
  const cwd = path.join(tmp, 'ws');
  fs.mkdirSync(cwd, { recursive: true });
  await pier(pi as never);
  await fire(pi, 'session_start', { reason: 'new' }, { cwd, sessionManager: { getBranch: () => [] } });
  return { pi, server, marker };
}

test('index D-4: 焦点转回本 pane ⇒ 以 pane.focused 事件重放 reflow；shutdown 停止轮询', withCleanup(async (cleanup) => {
  const { pi, server, marker } = await bootFocusIndex(cleanup);
  // Real wall-clock waits: the poller's own interval and the child process are genuinely asynchronous.
  const reflowLines = () => fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean) : [];
  const samples = () => server.calls.filter((m) => m === 'layout.export').length;
  try {
    const deadline = Date.now() + 5000;
    while (reflowLines().length === 0 && Date.now() < deadline) await delay(40);

    const lines = reflowLines();
    assert.equal(lines.length, 1, 'exactly one reflow replay for one focus transition');
    assert.match(lines[0]!, /^pane\.focused /);
    const payload = JSON.parse(lines[0]!.slice('pane.focused '.length));
    assert.equal(payload.data.pane_id, 'wX:pMe');
    assert.equal(payload.data.cause, 'user');

    // Shutdown stops polling: no further spawns even though the focus stays on this pane.
    await fire(pi, 'session_shutdown');
    // Let any already-queued tick settle, then require the sample count to stop growing at all.
    await delay(200);
    const settled = samples();
    await delay(300); // > 6 poll intervals: a live poller would be obvious
    assert.equal(samples(), settled, 'no sampling after shutdown');
    assert.equal(reflowLines().length, 1);
  } finally {
    await server.close();
  }
}));
