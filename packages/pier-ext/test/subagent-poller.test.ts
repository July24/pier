/**
 * pollLoop transition planners: takeover, blocked gate, observation, vacuum.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planBlockedGate,
  planObservationTick,
  planTakeoverTick,
  planVacuumTick,
} from '../src/subagent-poller.ts';

test('planTakeoverTick: missing agent → ignore', () => {
  assert.equal(planTakeoverTick({
    currentStatus: null, previousStatus: 'working', idleStartedAt: 1, now: 2, idleMs: 60_000,
  }).kind, 'ignore');
});

test('planTakeoverTick: idle edge starts timer; sustained idle returns control', () => {
  assert.equal(planTakeoverTick({
    currentStatus: 'idle', previousStatus: 'working', idleStartedAt: null, now: 10, idleMs: 60_000,
  }).kind, 'start-idle');
  assert.equal(planTakeoverTick({
    currentStatus: 'idle', previousStatus: 'idle', idleStartedAt: 1, now: 60_002, idleMs: 60_000,
  }).kind, 'return-control');
  assert.deepEqual(planTakeoverTick({
    currentStatus: 'idle', previousStatus: 'idle', idleStartedAt: 1, now: 50_000, idleMs: 60_000,
  }), { kind: 'hold', lastAgentStatus: 'idle', clearIdleTimer: false });
});

test('planTakeoverTick: working/blocked clears idle timer', () => {
  assert.deepEqual(planTakeoverTick({
    currentStatus: 'working', previousStatus: 'idle', idleStartedAt: 1, now: 2, idleMs: 60_000,
  }), { kind: 'hold', lastAgentStatus: 'working', clearIdleTimer: true });
});

test('planBlockedGate: first blocked notifies; subsequent stay silent; idle clears', () => {
  assert.deepEqual(planBlockedGate('blocked', false), { kind: 'stay-blocked', notify: true });
  assert.deepEqual(planBlockedGate('blocked', true), { kind: 'stay-blocked', notify: false });
  assert.equal(planBlockedGate('idle', true).kind, 'clear-gate');
  assert.equal(planBlockedGate(null, false).kind, 'pass');
});

test('planObservationTick: first settle starts window; working after grace = takeover', () => {
  assert.equal(planObservationTick({
    observationStartedAt: null, now: 10, windowMs: 30_000, agentStatus: 'idle',
    machineInjectAgoMs: 1, machineInjectGraceMs: 60_000,
  }).kind, 'start-observation');
  assert.equal(planObservationTick({
    observationStartedAt: 1, now: 10, windowMs: 30_000, agentStatus: 'working',
    machineInjectAgoMs: 61_000, machineInjectGraceMs: 60_000,
  }).kind, 'user-takeover');
  assert.equal(planObservationTick({
    observationStartedAt: 1, now: 10, windowMs: 30_000, agentStatus: 'working',
    machineInjectAgoMs: 100, machineInjectGraceMs: 60_000,
  }).kind, 'machine-inject-reset');
});

test('planObservationTick: wait until window elapses then settle', () => {
  assert.equal(planObservationTick({
    observationStartedAt: 1, now: 29_000, windowMs: 30_000, agentStatus: 'idle',
    machineInjectAgoMs: 99_000, machineInjectGraceMs: 60_000,
  }).kind, 'wait');
  assert.equal(planObservationTick({
    observationStartedAt: 1, now: 30_001, windowMs: 30_000, agentStatus: 'idle',
    machineInjectAgoMs: 99_000, machineInjectGraceMs: 60_000,
  }).kind, 'settle');
});

test('planVacuumTick: null waitState is heartbeat; dead pane beats timeout', () => {
  assert.deepEqual(planVacuumTick({
    waitState: null, paneAlive: true, now: 50, lastActivityAt: 1, timeoutMs: 100,
  }), { refreshActivity: true, action: 'continue' });
  assert.deepEqual(planVacuumTick({
    waitState: 'idle', paneAlive: false, now: 50, lastActivityAt: 1, timeoutMs: 10,
  }), { refreshActivity: false, action: 'pane-closed' });
  assert.deepEqual(planVacuumTick({
    waitState: 'idle', paneAlive: true, now: 50, lastActivityAt: 1, timeoutMs: 10,
  }), { refreshActivity: false, action: 'timeout' });
});
