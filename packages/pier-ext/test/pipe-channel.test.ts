/**
 * M11 pipe-channel 传输层单测（D45：命名确定性 / 往返 / 超时 / 坏帧）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePipeLine,
  pingUntilReady,
  pipeNameCandidates,
  pipeNameFor,
  pipeRequest,
  pipeRequestTo,
  startPipeServer,
} from '../src/pipe-channel.ts';

test('pipeNameFor: collision-resistant workspace encoding + paneId', () => {
  assert.equal(
    pipeNameFor('F:\\herdr-pi', 'w6:p2C'),
    'pi-herdr---F%3A%5Cherdr-pi---w6-p2C',
  );
  assert.equal(
    pipeNameFor('/home/u/proj', 'w1:p9'),
    'pi-herdr---%2Fhome%2Fu%2Fproj---w1-p9',
  );
});

test('pipeNameCandidates: new encoding first, then legacy', () => {
  assert.deepEqual(pipeNameCandidates('F:\\herdr-pi', 'w6:p2C'), [
    'pi-herdr---F%3A%5Cherdr-pi---w6-p2C',
    'pi-herdr---F--herdr-pi---w6-p2C',
  ]);
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

test('pipeRequestTo: reaches a server listening on the legacy name', async () => {
  const cwd = 'F:\\herdr-pi';
  const paneId = `w-test:${process.pid}`;
  const names = pipeNameCandidates(cwd, paneId);
  assert.equal(names.length, 2);
  const server = startPipeServer(names[1], async (req) => {
    if (req.type === 'ping') return { type: 'ok', id: req.id, detail: 'legacy' };
    return { type: 'error', id: req.id, message: `unknown ${req.type}` };
  });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const res = await pipeRequestTo(cwd, paneId, { type: 'ping', id: 'mig' }, 2000);
    assert.equal(res.type, 'ok');
    if (res.type === 'ok') assert.equal(res.detail, 'legacy');
  } finally {
    server.close();
  }
});
