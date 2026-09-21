/**
 * Session liveness derivations: transcript tail parsing (session-tail), todo-list staleness
 * (stale-core) and the settled-wake decision (settle-wake-core).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactionBusy, deriveSubSessionState, listSessionFiles, parseSessionEntries, sessionDirName, sessionFileById,
  type SessionEntryLike, type SubSessionState,
} from '../src/session-tail.ts';
import { COMPACTION_INFLIGHT_TYPE, COMPACTION_SETTLED_TYPE } from '../src/compact-coordinator.ts';
import { STALE_CLOCK_MS, STALE_TURNS, evaluateStaleness, formatAge, isArchived, openTodos } from '../src/stale-core.ts';
import { planSettleWake } from '../src/settle-wake-core.ts';
import type { TodoItem } from '../src/vocab.ts';
import { jsonl, transcriptMessage, withCleanup } from './test-utils.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

const msg = (role: string, text: string, ts: number, stopReason = 'stop') =>
  transcriptMessage(role, text, ts, stopReason) as SessionEntryLike;
const custom = (customType: string): SessionEntryLike => ({ type: 'custom', customType, data: {}, timestamp: 0 });
const toolCall = (ts: number, n = 1): SessionEntryLike => ({
  type: 'message',
  message: { role: 'assistant', content: Array.from({ length: n }, () => ({ type: 'toolCall' })), timestamp: ts, stopReason: 'toolUse' },
});
const toolResult = (ts: number): SessionEntryLike => ({ type: 'message', message: { role: 'toolResult', content: [], timestamp: ts } });
const idle: SubSessionState = { text: null, pendingTool: false, activity: false, turnEnded: false, compacting: false };

test('parseSessionEntries: tolerates malformed lines, blank lines and non-object records', () => {
  const entries = parseSessionEntries(`{bad json\n\n${jsonl(msg('assistant', 'hello', 100), 'nope', { type: 'session' })}`);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].type, 'message');
  assert.equal(entries[1].type, 'session');
});

test('deriveSubSessionState: role/stopReason/timestamp matrix → tail rows', async (t) => {
  const tail = (over: Partial<SubSessionState>): SubSessionState => ({ ...idle, ...over });
  const cases: Array<{ name: string; entries: SessionEntryLike[]; sinceTs: number; row: SubSessionState }> = [
    {
      name: 'stop-finalized text wins over the toolUse intermediate',
      entries: [msg('user', 'task', 1), msg('assistant', 'thinking...', 2, 'toolUse'), msg('assistant', 'final answer', 3)],
      sinceTs: 0,
      row: tail({ text: 'final answer', activity: true, turnEnded: true }),
    },
    { name: 'sinceTs drops finalized text written before the injection point', entries: [msg('assistant', 'old', 100), msg('assistant', 'new', 200)], sinceTs: 150, row: tail({ text: 'new', activity: true, turnEnded: true }) },
    { name: 'assistant timestamp at the injection point counts', entries: [msg('assistant', 'a', 100)], sinceTs: 100, row: tail({ text: 'a', activity: true, turnEnded: true }) },
    { name: 'a timestamp older than the injection point is invisible', entries: [msg('assistant', 'a', 100)], sinceTs: 101, row: idle },
    { name: 'no assistant message → idle row', entries: [msg('user', 'hi', 1)], sinceTs: 0, row: idle },
    { name: 'toolUse-only assistant → activity without a finished turn', entries: [msg('assistant', 'mid', 1, 'toolUse')], sinceTs: 0, row: tail({ activity: true }) },
    {
      name: 'tool result written but the next assistant not yet → still not ended',
      entries: [msg('user', 'task', 1), msg('assistant', 'thinking', 2, 'toolUse'), msg('toolResult', 'ok', 3)],
      sinceTs: 1,
      row: tail({ activity: true }),
    },
    {
      name: 'assistant without stopReason (streaming) → not ended',
      entries: [{ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], timestamp: 6 } }],
      sinceTs: 1,
      row: tail({ activity: true }),
    },
    { name: 'pending tool call after injection → waiting on a human', entries: [msg('user', 'q', 1), toolCall(10)], sinceTs: 5, row: tail({ pendingTool: true, activity: true }) },
    { name: 'parallel calls with only one result → still pending', entries: [toolCall(10, 2), toolResult(11)], sinceTs: 5, row: tail({ pendingTool: true, activity: true }) },
    { name: 'tool call before the injection point does not count', entries: [toolCall(3)], sinceTs: 5, row: idle },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      assert.deepEqual(deriveSubSessionState(c.entries, c.sinceTs), c.row);
    });
  }
});

test('deriveSubSessionState/compactionBusy: no settlement inside an OCC marker cycle', () => {
  const task = msg('user', 'fix bugs 19795-19799', 1);
  // OCC aborts at a todo boundary: the turn lands as stopReason 'error' with empty content.
  const abortedTurn = msg('assistant', '', 2, 'error');
  const continuation = msg('assistant', 'Let me continue: compile and run tests', 4, 'toolUse');
  const closed = [task, abortedTurn, custom(COMPACTION_INFLIGHT_TYPE)];
  const cases: Array<[name: string, entries: SessionEntryLike[], text: string | null, turnEnded: boolean, compacting: boolean]> = [
    ['inflight marker last → the summary request is running', closed, null, true, true],
    ['settled marker without a continuation turn yet → still machine-paused', [...closed, custom(COMPACTION_SETTLED_TYPE)], null, true, true],
    ['continuation assistant after settled → released', [...closed, custom(COMPACTION_SETTLED_TYPE), continuation], null, false, false],
    ['no markers (older pi / OCC off) → behaviour unchanged', [task, abortedTurn], null, true, false],
    ['closing text written before the cycle is not a settlement while compacting', [task, msg('assistant', 'all tests pass, committed', 5), custom(COMPACTION_INFLIGHT_TYPE)], 'all tests pass, committed', true, true],
  ];
  for (const [name, entries, text, turnEnded, compacting] of cases) {
    const state = deriveSubSessionState(entries, 0);
    assert.equal(state.compacting, compacting, `${name}: compacting`);
    assert.equal(compactionBusy(entries), compacting, `${name}: compactionBusy`);
    assert.equal(state.text, text, `${name}: text`);
    assert.equal(state.turnEnded, turnEnded, `${name}: turnEnded`);
  }
});

test('compactionBusy: later unrelated custom entries do not disturb last-marker-wins', () => {
  const entries = [
    msg('user', 'task', 1),
    custom(COMPACTION_INFLIGHT_TYPE),
    custom(COMPACTION_SETTLED_TYPE),
    msg('assistant', 'continuing', 4, 'toolUse'),
    custom('pi-herdr.subs'), // another custom entry written to the same session afterwards
  ];
  assert.equal(compactionBusy(entries), false);
});

test('sessionDirName: cwd → collision-resistant session dir', () => {
  assert.equal(sessionDirName('F:\\herdr-pi'), '--F%3A%5Cherdr-pi--');
  assert.equal(sessionDirName('/home/u/proj'), '--%2Fhome%2Fu%2Fproj--');
});

test('listSessionFiles/sessionFileById: platform dir candidates, newest-first order and legacy fallback', withCleanup(async (cleanup) => {
  const flat = cleanup.tempDir('sess2').path;
  const dir = path.join(flat, '--F--herdr-pi--');
  fs.mkdirSync(dir, { recursive: true });
  const at = (n: number) => path.join(dir, `2026-01-01T00-00-0${n}_${['aaaa', 'bbbb', 'cccc'][n]}.jsonl`);
  const [a, b, c] = [at(0), at(1), at(2)];
  for (const f of [a, b, c]) fs.writeFileSync(f, '{}');
  const t = Date.now();
  [a, b, c].forEach((f, i) => fs.utimesSync(f, new Date(t - 3000 + i * 1000), new Date(t - 3000 + i * 1000)));
  assert.deepEqual(listSessionFiles('F:\\herdr-pi', flat, 2), [c, b]);
  assert.equal(sessionFileById('F:\\herdr-pi', flat, 'bbbb'), b);
  assert.equal(sessionFileById('F:\\herdr-pi', flat, 'zzzz'), null);
  assert.equal(sessionFileById('Z:\\nowhere', flat, 'bbbb'), null);

  // pi core's own POSIX dir name must resolve (the old %2F/--- encodings failed silently on it),
  // while pier's legacy flattened dir stays readable through the dual read.
  const cwd = '/Users/yehaoyu/Documents/pier';
  const tmp = cleanup.tempDir('sess-a8').path;
  const core = path.join(tmp, '--Users-yehaoyu-Documents-pier--');
  fs.mkdirSync(core, { recursive: true });
  const f = path.join(core, '2026-01-01T00-00-00_dead.jsonl');
  fs.writeFileSync(f, '{}');
  assert.deepEqual(listSessionFiles(cwd, tmp, 4), [f]);
  assert.equal(sessionFileById(cwd, tmp, 'dead'), f);
  assert.equal(sessionFileById(cwd, tmp, 'beef'), null);
  const legacy = path.join(tmp, '---Users-yehaoyu-Documents-pier--');
  fs.mkdirSync(legacy, { recursive: true });
  const g = path.join(legacy, '2026-01-01T00-00-01_beef.jsonl');
  fs.writeFileSync(g, '{}');
  assert.equal(sessionFileById(cwd, tmp, 'beef'), g);
  assert.equal(listSessionFiles(cwd, tmp, 4).length, 2);
}));

/* ── staleness: a fully done list left untouched is stale (turns) or archived (clock) ── */

const done = (content: string): TodoItem => ({ content, status: 'completed' });
const HOUR = 3_600_000;
const ALL_DONE = [done('Verify gateway'), done('Verify id consistency'), done('Update design doc')];

test('openTodos: pending/in_progress/blocked count, completed/abandoned do not', () => {
  const items: TodoItem[] = [
    { content: 'a', status: 'pending' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'blocked', blocker: 'x' },
    { content: 'd', status: 'completed' },
    { content: 'e', status: 'abandoned' },
  ];
  assert.equal(openTodos(items), 3);
  assert.equal(openTodos(ALL_DONE), 0);
});

test('fresh: open items keep a list fresh at any age (the settled notice is the other guard)', () => {
  const items: TodoItem[] = [done('a'), { content: 'b', status: 'pending' }];
  const st = evaluateStaleness({ items, lastWriteAt: 0, turnsSinceWrite: 999, now: 1e12 });
  assert.equal(st.kind, 'fresh');
  assert.equal(st.open, 1);
});

test('thresholds: turns 6 → stale, wall clock ≥1h → archived (clock outranks turns), below → fresh', () => {
  const at = (now: number, turnsSinceWrite: number) => evaluateStaleness({ items: ALL_DONE, lastWriteAt: 10 * HOUR, turnsSinceWrite, now });
  assert.equal(at(10 * HOUR + 30 * 60_000, 3).kind, 'fresh');
  assert.equal(at(10 * HOUR + 30 * 60_000, STALE_TURNS - 1).kind, 'fresh');
  const stale = at(10 * HOUR + 30 * 60_000, STALE_TURNS);
  assert.equal(stale.kind, 'stale');
  assert.equal(stale.open, 0);
  const archived = at(10 * HOUR + STALE_CLOCK_MS, 1);
  assert.equal(archived.kind, 'archived');
  assert.equal(archived.ageMs, STALE_CLOCK_MS);
});

test('conservative: unknown lastWriteAt (old sessions) suppresses only the clock axis; empty list is fresh', () => {
  const st = evaluateStaleness({ items: ALL_DONE, lastWriteAt: null, turnsSinceWrite: 99, now: 1e12 });
  assert.equal(st.kind, 'stale');
  assert.equal(st.ageMs, null);
  assert.equal(isArchived(ALL_DONE, null, 1e12), false);
  assert.equal(evaluateStaleness({ items: [], lastWriteAt: 0, turnsSinceWrite: 99, now: 1e12 }).kind, 'fresh');
});

test('isArchived: title path uses the clock axis only, and open items are never archived', () => {
  const t0 = 100 * HOUR;
  assert.equal(isArchived(ALL_DONE, t0, t0 + HOUR - 1), false);
  assert.equal(isArchived(ALL_DONE, t0, t0 + HOUR), true);
  assert.equal(isArchived([{ content: 'x', status: 'in_progress' }], t0, t0 + 10 * HOUR), false);
});

test('formatAge: m / floored h / d', () => {
  assert.equal(formatAge(45 * 60_000), '45m');
  assert.equal(formatAge(90 * 60_000), '1h');
  assert.equal(formatAge(16 * HOUR), '16h');
  assert.equal(formatAge(50 * HOUR), '2d');
});

/* ── settle wake: no wake storm (abort silence, one notice per running set per 10 min) ── */

const SUBS = [{ paneId: 'wA:p6' }, { paneId: 'wA:p7' }];
const KEY = 'wA:p6,wA:p7';
const T0 = 100 * 60_000;

test('abort suppression: a settled turn after ESC wakes nothing and keeps the dedup anchor', () => {
  const plan = planSettleWake({ lastStopReason: 'aborted', running: SUBS, lastNoticeKey: null, lastNoticeAt: 0, now: T0 });
  assert.equal(plan.wake, false);
  assert.equal(plan.notice, false);
  assert.equal(plan.noticeKey, null);
  assert.equal(plan.noticeAt, 0);
});

test('natural settle with a new running set → one notice carrying the set key', () => {
  const plan = planSettleWake({ lastStopReason: 'stop', running: SUBS, lastNoticeKey: null, lastNoticeAt: 0, now: T0 });
  assert.equal(plan.wake, true);
  assert.equal(plan.notice, true);
  assert.equal(plan.noticeKey, KEY);
  assert.equal(plan.noticeAt, T0);
});

test('same running set: a settle seconds later stays silent, 10 minutes later re-notifies', () => {
  const at = (now: number) => planSettleWake({ lastStopReason: 'stop', running: SUBS, lastNoticeKey: KEY, lastNoticeAt: T0, now });
  const selfLoop = at(T0 + 1000); // the run started by the notice settles within seconds
  assert.equal(selfLoop.wake, true);
  assert.equal(selfLoop.notice, false);
  assert.equal(selfLoop.noticeKey, KEY, 'the anchor is untouched');
  assert.equal(at(T0 + 10 * 60_000 - 1).notice, false);
  const due = at(T0 + 10 * 60_000);
  assert.equal(due.notice, true);
  assert.equal(due.noticeAt, T0 + 10 * 60_000);
});

test('a changed running set bypasses the cooldown; an empty set resets the anchor', () => {
  const grown = planSettleWake({ lastStopReason: 'stop', running: [...SUBS, { paneId: 'wA:p9' }], lastNoticeKey: KEY, lastNoticeAt: T0, now: T0 + 5000 });
  assert.equal(grown.notice, true, 'a new sub bypasses the cooldown');
  const emptied = planSettleWake({ lastStopReason: 'stop', running: [], lastNoticeKey: KEY, lastNoticeAt: T0, now: T0 + 5000 });
  assert.equal(emptied.notice, false);
  assert.equal(emptied.noticeKey, null, 'an empty set resets the anchor so the next subs notify again');
});

test('unknown stopReason (null, older pi) counts as a natural end: no notice is lost', () => {
  const plan = planSettleWake({ lastStopReason: null, running: SUBS, lastNoticeKey: null, lastNoticeAt: 0, now: T0 });
  assert.equal(plan.wake, true);
  assert.equal(plan.notice, true);
});
