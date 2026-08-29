/**
 * storage-layout: session dir encoding, history path, role dirs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  historyFilePath,
  sessionDirName,
  userRolesDir,
  workspaceRolesDir,
} from '../src/storage-layout.ts';
import { sessionDirName as sessionDirNameReexport } from '../src/session-tail.ts';
import { historyFilePath as historyFilePathReexport } from '../src/history-store.ts';
import { userRolesDir as userRolesDirReexport } from '../src/role-loader.ts';

test('sessionDirName: cwd flattening matches observed pi convention', () => {
  assert.equal(sessionDirName('F:\\herdr-pi'), '--F--herdr-pi--');
  assert.equal(sessionDirName('/home/u/proj'), '---home-u-proj--');
});

test('historyFilePath: agentRoot + sessionDirName + history.jsonl', () => {
  assert.equal(
    historyFilePath('C:\\home\\.pi\\agent', 'F:\\herdr-pi'),
    join('C:\\home\\.pi\\agent', 'herdr-pi', 'history', '--F--herdr-pi--', 'history.jsonl'),
  );
});

test('userRolesDir: ~/.pi/agent/herdr-pi/roles (legacy layout, not XDG)', () => {
  assert.equal(userRolesDir(), join(homedir(), '.pi', 'agent', 'herdr-pi', 'roles'));
});

test('workspaceRolesDir: <base>/.pi-herdr/roles', () => {
  assert.equal(workspaceRolesDir('/repo'), join('/repo', '.pi-herdr', 'roles'));
});

test('re-exports stay stable for existing importers', () => {
  assert.equal(sessionDirNameReexport, sessionDirName);
  assert.equal(historyFilePathReexport, historyFilePath);
  assert.equal(userRolesDirReexport, userRolesDir);
});
