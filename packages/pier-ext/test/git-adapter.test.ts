/**
 * git-adapter: injectable exec, timeout, error normalization.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodeGitAdapter, type GitExecFile } from '../src/git-adapter.ts';

function fakeExec(impl: GitExecFile): GitExecFile {
  return impl;
}

test('run: prefixes git -C cwd and forwards timeout', async () => {
  const calls: Array<{ file: string; args: readonly string[]; timeout: number }> = [];
  const exec = fakeExec(async (file, args, opts) => {
    calls.push({ file, args, timeout: opts.timeout });
    return { stdout: 'ok\n', stderr: '' };
  });
  const git = new NodeGitAdapter('git', 1234, exec);
  const result = await git.run('/repo', ['rev-parse', 'HEAD']);
  assert.equal(result.stdout, 'ok\n');
  assert.deepEqual(calls, [{
    file: 'git',
    args: ['-C', '/repo', 'rev-parse', 'HEAD'],
    timeout: 1234,
  }]);
});

test('listWorktrees / status: convenience wrappers around run', async () => {
  const seen: string[][] = [];
  const exec = fakeExec(async (_file, args) => {
    seen.push([...args]);
    return { stdout: 'out', stderr: '' };
  });
  const git = new NodeGitAdapter('git', 1000, exec);
  await git.listWorktrees('/wt');
  await git.status('/wt');
  assert.deepEqual(seen[0], ['-C', '/wt', 'worktree', 'list', '--porcelain']);
  assert.deepEqual(seen[1], ['-C', '/wt', 'status', '--short']);
});

test('run: normalizes thrown errors with operation name', async () => {
  const exec = fakeExec(async () => {
    const err = new Error('ENOENT');
    (err as Error & { code: string }).code = 'ENOENT';
    throw err;
  });
  const git = new NodeGitAdapter('git', 1000, exec);
  await assert.rejects(
    () => git.run('/repo', ['status', '--porcelain']),
    (err: Error) => {
      assert.match(err.message, /^Git status failed: ENOENT/);
      return true;
    },
  );
});

test('run: non-Error throw still becomes GitError', async () => {
  const exec = fakeExec(async () => {
    throw 'boom';
  });
  const git = new NodeGitAdapter('git', 1000, exec);
  await assert.rejects(
    () => git.run('/repo', ['diff']),
    (err: Error) => {
      assert.equal(err.message, 'Git diff failed: boom');
      return true;
    },
  );
});
