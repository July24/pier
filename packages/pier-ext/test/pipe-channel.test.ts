/**
 * M11 pipe-channel 传输层单测（D45：命名确定性 / 往返 / 超时 / 坏帧）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePipeLine,
  pingUntilReady,
  pipeNameFor,
  pipeRequest,
  startPipeServer,
} from '../src/pipe-channel.ts';

test('pipeNameFor: workspace 作用域命名（与 history 目录命名同约定）+ paneId 编码', () => {
  assert.equal(
    pipeNameFor('F:\\herdr-pi', 'w6:p2C'),
    'pi-herdr---F--herdr-pi---w6-p2C',
  );
  assert.equal(
    pipeNameFor('/home/u/proj', 'w1:p9'),
    'pi-herdr----home-u-proj---w1-p9',
  );
});

test('parsePipeLine: JSON 行解析与坏行容错', () => {
  assert.deepEqual(parsePipeLine('{"type":"ping","id":"1"}'), { type: 'ping', id: '1' });
  assert.equal(parsePipeLine('not json'), null);
  assert.equal(parsePipeLine(''), null);
  assert.equal(parsePipeLine('{"type":123}'), null);
});

test('pipeRequest/startPipeServer: 往返 + ping + 错误帧', async () => {
  const name = `pi-herdr-test-${process.pid}-${Date.now()}`;
  const seen: string[] = [];
  const server = startPipeServer(name, async (req) => {
    seen.push(req.type);
    if (req.type === 'ping') return { type: 'ok', id: req.id, detail: 'pong' };
    if (req.type === 'prompt') return { type: 'ok', id: req.id };
    return { type: 'error', id: req.id, message: `unknown ${req.type}` };
  });
  try {
    await new Promise((r) => setTimeout(r, 300)); // 等 listen
    const ping = await pipeRequest(name, { type: 'ping', id: 'p1' });
    assert.deepEqual(ping, { type: 'ok', id: 'p1', detail: 'pong' });
    const prompt = await pipeRequest(name, { type: 'prompt', id: 'p2', text: 'hi' });
    assert.equal(prompt.type, 'ok');
    assert.deepEqual(seen, ['ping', 'prompt']);
    const ready = await pingUntilReady(name, 5000);
    assert.equal(ready, true);
  } finally {
    server.close();
  }
});

test('pipeRequest: 连接不存在 → 抛错（调用方重试）', async () => {
  await assert.rejects(
    () => pipeRequest(`pi-herdr-nobody-${process.pid}-${Date.now()}`, { type: 'ping', id: 'x' }, 1500),
  );
});

test('pingUntilReady: 一直不在 → false', async () => {
  const ok = await pingUntilReady(`pi-herdr-never-${process.pid}-${Date.now()}`, 1200, 300);
  assert.equal(ok, false);
});
