/** Guards `docs/decisions.md` anchors against renames, module merges and file shrinks (`path:line` must still land on a line that exists). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ANCHOR = /`([^`\n]+?):(\d+)`/g;

/** Lines of content: a trailing newline does not add one, a missing one does not remove the last. */
const countLines = (text: string): number => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

test('decisions.md: every `path:line` anchor names an existing file with that many lines', () => {
  const doc = readFileSync(resolve(repoRoot, 'docs', 'decisions.md'), 'utf8');
  const anchors = [...doc.matchAll(ANCHOR)].map((m) => ({ path: m[1]!, line: Number(m[2]) }));
  assert.ok(anchors.length > 0, 'no `path:line` anchors found — did the index format change?');
  const broken: string[] = [];
  for (const { path, line } of anchors) {
    let lines: number;
    try {
      lines = countLines(readFileSync(resolve(repoRoot, path), 'utf8'));
    } catch {
      broken.push(`\`${path}:${line}\` — file does not exist`);
      continue;
    }
    if (line > lines) broken.push(`\`${path}:${line}\` — file has only ${lines} lines`);
  }
  assert.deepEqual(broken, [], `stale decision anchors:\n${broken.join('\n')}`);
});
