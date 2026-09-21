/**
 * D-4 focus domain: the pure focus-poller planners (sample parsing / fire decision / reflow spawn)
 * plus the index.ts wiring — session_start starts polling, a focus transition into this pane replays a
 * `pane.focused` reflow through the real spawn path, and session_shutdown stops the polling.
 *
 * The wiring tests fake the herdr socket (scripted `layout.export` replies) and replace the workbench
 * script with a stub in a temp root, so they cover index.ts plumbing + focus-poller + spawnReflow
 * without touching the developer's live herdr session.
 */
import { join } from 'node:path';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOCUS_FIRE_MIN_INTERVAL_MS,
  collectPaneIds,
  parseFocusSample,
  planFocusTick,
  reflowScriptPath,
  spawnReflow,
  startFocusPoller,
  isHerdr091OrLater,
  resolveDefaultFocusPollMs,
  type FocusPollerState,
  type FocusSample,
} from '../src/focus-poller.ts';
import { herdrSocketTarget } from '../src/herdr-client.ts';
import pier from '../src/index.ts';
import { withCleanup } from './test-utils.ts';

const sample = (focused: string | null, paneIds: string[]): FocusSample => ({ focusedPaneId: focused, paneIds });
const state = (focused: string | null, paneIds: string[], lastFireAt = 0): FocusPollerState => ({
  lastFocusedPaneId: focused,
  lastPaneIds: paneIds,
  lastFireAt,
});

test('collectPaneIds/parseFocusSample: 真实 layout.export 载荷（单 pane / 分屏 / 缺失 focus）', () => {
  // Observed shape: {type:'layout_export', layout:{focused_pane_id, root:{type:'pane',pane_id}}}
  assert.deepEqual(collectPaneIds({ type: 'pane', pane_id: 'wD:p1' }), ['wD:p1']);
  assert.deepEqual(
    collectPaneIds({ type: 'split', first: { type: 'pane', pane_id: 'a' }, second: { type: 'split', first: { type: 'pane', pane_id: 'b' }, second: { type: 'pane', pane_id: 'c' } } }),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(collectPaneIds(null), []);
  assert.deepEqual(
    parseFocusSample({ root: { type: 'pane', pane_id: 'wD:p2' }, focusedPaneId: 'wD:p2' }),
    { focusedPaneId: 'wD:p2', paneIds: ['wD:p2'] },
  );
  // An older herdr omits focused_pane_id → null (the caller stays silent instead of treating the root pane as focused)
  assert.deepEqual(parseFocusSample({ root: { type: 'pane', pane_id: 'wD:p2' } }), { focusedPaneId: null, paneIds: ['wD:p2'] });
  assert.equal(parseFocusSample(null), null);
});

test('planFocusTick: 首次采样只记基线（启动即聚焦不得触发布局变化）', () => {
  const r = planFocusTick({ myPaneId: 'me', sample: sample('me', ['me']), prev: null, now: 1000 });
  assert.equal(r.fire, false);
  assert.equal(r.state.lastFocusedPaneId, 'me');
});

test('planFocusTick: 焦点转移到我 + 面板集合未变 ⇒ 判定人类点击（cause=user，绕过 3s 白名单）', () => {
  const r = planFocusTick({
    myPaneId: 'me',
    sample: sample('me', ['other', 'me']),
    prev: state('other', ['other', 'me']),
    now: 5000,
  });
  assert.equal(r.fire, true);
  assert.equal(r.cause, 'user');
  assert.equal(r.state.lastFireAt, 5000);
});

test('planFocusTick: 同一 tick 里新面板出现 ⇒ cause=null（spawn 自动聚焦不得抢布局，F1）', () => {
  const r = planFocusTick({
    myPaneId: 'me',
    sample: sample('me', ['other', 'me', 'fresh']),
    prev: state('other', ['other', 'me']),
    now: 5000,
  });
  assert.equal(r.fire, true);
  assert.equal(r.cause, null);
});

test('planFocusTick: 焦点在别处 / 焦点没变 / 空 paneId 都不触发', () => {
  assert.equal(planFocusTick({ myPaneId: 'me', sample: sample('other', ['me', 'other']), prev: state('me', ['me', 'other']), now: 9000 }).fire, false);
  // Steady focus must not re-fire (otherwise every tick spawns a reflow).
  assert.equal(planFocusTick({ myPaneId: 'me', sample: sample('me', ['me']), prev: state('me', ['me'], 1000), now: 9000 }).fire, false);
  assert.equal(planFocusTick({ myPaneId: '', sample: sample('me', ['me']), prev: state('other', ['me']), now: 9000 }).fire, false);
  // Focus elsewhere still advances the baseline (leaving and returning counts as a new transition).
  const away = planFocusTick({ myPaneId: 'me', sample: sample('other', ['me', 'other']), prev: state('me', ['me', 'other']), now: 9000 });
  assert.equal(away.state.lastFocusedPaneId, 'other');
});

test('planFocusTick: 限流窗口内的连点不重复 spawn', () => {
  const first = planFocusTick({ myPaneId: 'me', sample: sample('me', ['me', 'o']), prev: state('o', ['me', 'o']), now: 10_000 });
  assert.equal(first.fire, true);
  const again = planFocusTick({
    myPaneId: 'me',
    sample: sample('me', ['me', 'o']),
    prev: state('o', ['me', 'o'], first.state.lastFireAt),
    now: 10_000 + FOCUS_FIRE_MIN_INTERVAL_MS - 1,
  });
  assert.equal(again.fire, false);
  // Leaving, returning after the throttle window → fires again
  const later = planFocusTick({
    myPaneId: 'me',
    sample: sample('me', ['me', 'o']),
    prev: state('o', ['me', 'o'], first.state.lastFireAt),
    now: 10_000 + FOCUS_FIRE_MIN_INTERVAL_MS,
  });
  assert.equal(later.fire, true);
});

test('startFocusPoller: 采样→触发一次，且样本失败不推进基线', async () => {
  const samples: Array<FocusSample | Error> = [
    sample('other', ['me', 'other']),
    sample('me', ['me', 'other']),
    new Error('socket down'),
    sample('me', ['me', 'other']), // re-sample after the failure: the baseline never advanced, so this is still a move to "me"
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
});

test('startFocusPoller: intervalMs=0 不注册定时器，stop() 幂等', async () => {
  const poller = startFocusPoller({
    myPaneId: 'me',
    intervalMs: 0,
    sample: async () => null,
    fire: () => { throw new Error('must not fire'); },
  });
  await poller.tick();
  poller.stop();
  poller.stop();
});

test('spawnReflow: 以 herdr 事件载荷调用 workbench 脚本（pane.focused + JSON + cause）', () => {
  const seen: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const fakeSpawn = ((cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    seen.push({ cmd, args, env: opts.env });
    return { on: () => {}, unref: () => {} };
  }) as unknown as typeof import('node:child_process').spawn;
  spawnReflow({ paneId: 'wD:p9', cause: 'user', env: { HERDR_SOCKET_PATH: '/tmp/x.sock' }, spawnFn: fakeSpawn });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.args.length, 1);
  assert.match(seen[0]!.args[0]!, /heat-reflow\.mjs$/);
  assert.equal(seen[0]!.env.HERDR_PLUGIN_EVENT, 'pane.focused');
  assert.equal(seen[0]!.env.HERDR_SOCKET_PATH, '/tmp/x.sock');
  assert.deepEqual(JSON.parse(String(seen[0]!.env.HERDR_PLUGIN_EVENT_JSON)), {
    event: 'pane_focused',
    type: 'pane_focused',
    data: { type: 'pane_focused', pane_id: 'wD:p9', cause: 'user' },
  });
});

test('reflowScriptPath: 默认指向同仓库的 workbench 脚本，可用 PIER_WORKBENCH_ROOT 覆盖', () => {
  const def = reflowScriptPath({});
  assert.ok(def.replaceAll('\\', '/').endsWith('packages/pier-workbench/scripts/heat-reflow.mjs'), def);
  assert.equal(reflowScriptPath({ PIER_WORKBENCH_ROOT: '/opt/wb' }), join('/opt/wb', 'scripts', 'heat-reflow.mjs'));
});

test('spawnReflow: spawn 抛错/子进程 error 事件都不得冒泡（焦点热力是舒适功能）', () => {
  const throwing = (() => { throw new Error('ENOENT'); }) as unknown as typeof import('node:child_process').spawn;
  spawnReflow({ paneId: 'p', cause: null, env: {}, spawnFn: throwing });
  const emitting = (() => ({
    on: (evt: string, cb: () => void) => { if (evt === 'error') cb(); },
    unref: () => {},
  })) as unknown as typeof import('node:child_process').spawn;
  spawnReflow({ paneId: 'p', cause: null, env: {}, spawnFn: emitting });
  assert.ok(true);
});

test('Herdr 0.9.1 adaptive cadence: isHerdr091OrLater and resolveDefaultFocusPollMs', () => {
  assert.equal(isHerdr091OrLater('0.9.1'), true);
  assert.equal(isHerdr091OrLater('0.9.1-preview'), true);
  assert.equal(isHerdr091OrLater('0.9.2'), true);
  assert.equal(isHerdr091OrLater('0.10.0'), true);
  assert.equal(isHerdr091OrLater('1.0.0'), true);

  assert.equal(isHerdr091OrLater('0.9.0'), false);
  assert.equal(isHerdr091OrLater('0.8.2'), false);
  assert.equal(isHerdr091OrLater(''), false);
  assert.equal(isHerdr091OrLater(null), false);
  assert.equal(isHerdr091OrLater(undefined), false);

  assert.equal(resolveDefaultFocusPollMs('0.9.1'), 0);
  assert.equal(resolveDefaultFocusPollMs('0.9.0'), 1500);
  assert.equal(resolveDefaultFocusPollMs(null), 1500);
});

/* ── index.ts wiring: polling starts on session_start, stops on session_shutdown ───────────────── */

interface FakePi {
  tools: Map<string, unknown>;
  listeners: Map<string, Array<(...a: unknown[]) => unknown>>;
  registerTool(def: { name: string }): void;
  registerCommand(name: string, options: unknown): void;
  on(event: string, handler: (...a: unknown[]) => unknown): void;
  appendEntry(customType: string, data: unknown): void;
  sendMessage(message: unknown, options?: unknown): void;
  sendUserMessage(content?: string, opts?: unknown): Promise<void>;
  events: {
    on(channel: string, handler: (data: unknown) => void): () => void;
    emit(channel: string, data: unknown): void;
  };
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

function fakePi(): FakePi {
  const bus = new Map<string, Array<(data: unknown) => void>>();
  return {
    tools: new Map(),
    listeners: new Map(),
    registerTool(def) { this.tools.set(def.name, def); },
    registerCommand() {},
    on(event, handler) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]); },
    appendEntry() {},
    sendMessage() {},
    sendUserMessage() { return Promise.resolve(); },
    events: {
      on(channel, handler) {
        bus.set(channel, [...(bus.get(channel) ?? []), handler]);
        return () => { bus.set(channel, (bus.get(channel) ?? []).filter((h) => h !== handler)); };
      },
      emit(channel, data) { for (const h of bus.get(channel) ?? []) h(data); },
    },
    getActiveTools() { return [...this.tools.keys()]; },
    setActiveTools() {},
  };
}

async function fire(pi: FakePi, event: string, ...args: unknown[]): Promise<void> {
  for (const h of pi.listeners.get(event) ?? []) await h(...args);
}

/** Minimal herdr server: answers layout.export with a scripted focus sequence, records other calls. */
function fakeHerdrServer(socketPath: string, focuses: Array<string | null>): Promise<{ close(): Promise<void>; calls: string[] }> {
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
      if (method === 'layout.export') {
        const focused = focuses[Math.min(index, focuses.length - 1)] ?? null;
        index += 1;
        // Both panes always exist; only the focused one moves (a click, not a spawn).
        const root = {
          type: 'split',
          first: { type: 'pane', pane_id: 'wX:pOther' },
          second: { type: 'pane', pane_id: 'wX:pMe' },
        };
        sock.end(JSON.stringify({
          id: req.id ?? '1',
          result: {
            type: 'layout_export',
            layout: { workspace_id: 'wX', tab_id: 'wX:t1', zoomed: false, focused_pane_id: focused, root },
          },
        }) + '\n');
        return;
      }
      sock.end(JSON.stringify({ id: req.id ?? '1', result: { type: 'ok' } }) + '\n');
    });
  });
  const ready = Promise.withResolvers<{ close(): Promise<void>; calls: string[] }>();
  server.listen(herdrSocketTarget(socketPath), () => {
    ready.resolve({
      calls,
      close: () => new Promise<void>((done) => {
        const s = server as unknown as { closeAllConnections?: () => void };
        s.closeAllConnections?.();
        server.close(() => done());
      }),
    });
  });
  return ready.promise;
}

test('index D-4: 焦点转回本 pane ⇒ 以 pane.focused 事件重放 reflow；shutdown 停止轮询', withCleanup(async (cleanup) => {
  const env = cleanup.env();
  env.delete('PI_HERDR_SUBAGENT');
  env.set('HERDR_ENV', '1');
  env.set('HERDR_PANE_ID', 'wX:pMe');
  env.set('HERDR_TAB_ID', 'wX:t1');
  env.set('HERDR_WORKSPACE_ID', 'wX');
  env.delete('PI_HERDR_ROLE_MANIFEST');
  env.set('PIER_FOCUS_POLL_MS', '40');

  const tmp = cleanup.tempDir('pier-focus-d4').path;
  const socketPath = path.join(tmp, 'herdr.sock');
  env.set('HERDR_SOCKET_PATH', socketPath);

  // Stub workbench: record the event env it was invoked with (real spawn, no layout changes).
  const wbRoot = path.join(tmp, 'wb');
  fs.mkdirSync(path.join(wbRoot, 'scripts'), { recursive: true });
  const marker = path.join(tmp, 'reflow.jsonl');
  fs.writeFileSync(path.join(wbRoot, 'scripts', 'heat-reflow.mjs'),
    `import * as fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, process.env.HERDR_PLUGIN_EVENT + ' ' + process.env.HERDR_PLUGIN_EVENT_JSON + '\\n');\n`);
  env.set('PIER_WORKBENCH_ROOT', wbRoot);

  // First sample: someone else is focused; every later sample: this pane is focused.
  const server = await fakeHerdrServer(socketPath, ['wX:pOther', 'wX:pMe']);
  const pi = fakePi();
  const cwd = path.join(tmp, 'ws');
  fs.mkdirSync(cwd, { recursive: true });

  try {
    await pier(pi as never);
    await fire(pi, 'session_start', { reason: 'new' }, { cwd, sessionManager: { getBranch: () => [] } });

    const deadline = Date.now() + 5000;
    let lines: string[] = [];
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 40));
      lines = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean) : [];
      if (lines.length > 0) break;
    }

    assert.equal(lines.length, 1, 'exactly one reflow replay for one focus transition');
    assert.match(lines[0]!, /^pane\.focused /);
    const payload = JSON.parse(lines[0]!.slice('pane.focused '.length));
    assert.equal(payload.data.pane_id, 'wX:pMe');
    assert.equal(payload.data.cause, 'user');

    // Shutdown stops polling: no further spawns even though the focus stays on this pane.
    await fire(pi, 'session_shutdown');
    // Let any already-queued tick settle, then require the sample count to stop growing at all.
    await new Promise((r) => setTimeout(r, 200));
    const samplesAfterSettle = server.calls.filter((m) => m === 'layout.export').length;
    await new Promise((r) => setTimeout(r, 300)); // > 6 poll intervals: a live poller would be obvious
    assert.equal(
      server.calls.filter((m) => m === 'layout.export').length,
      samplesAfterSettle,
      'no sampling after shutdown',
    );
    assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).length, 1);
  } finally {
    await server.close();
  }
}));

test('index D-4: PIER_FOCUS_POLL_MS=0 关闭轮询（退回只依赖 herdr 事件）', withCleanup(async (cleanup) => {
  const env = cleanup.env();
  env.delete('PI_HERDR_SUBAGENT');
  env.set('HERDR_ENV', '1');
  env.set('HERDR_PANE_ID', 'wX:pMe');
  env.set('HERDR_TAB_ID', 'wX:t1');
  env.set('HERDR_WORKSPACE_ID', 'wX');
  env.delete('PI_HERDR_ROLE_MANIFEST');
  env.set('PIER_FOCUS_POLL_MS', '0');
  env.delete('PIER_WORKBENCH_ROOT');

  const tmp = cleanup.tempDir('pier-focus-off').path;
  const socketPath = path.join(tmp, 'herdr.sock');
  env.set('HERDR_SOCKET_PATH', socketPath);
  const server = await fakeHerdrServer(socketPath, ['wX:pMe']);
  const pi = fakePi();
  const cwd = path.join(tmp, 'ws');
  fs.mkdirSync(cwd, { recursive: true });

  try {
    await pier(pi as never);
    await fire(pi, 'session_start', { reason: 'new' }, { cwd, sessionManager: { getBranch: () => [] } });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(server.calls.includes('layout.export'), false, 'disabled poller must not sample the layout');
  } finally {
    await fire(pi, 'session_shutdown');
    await server.close();
  }
}));
