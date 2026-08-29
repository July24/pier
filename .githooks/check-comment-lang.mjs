#!/usr/bin/env node
/**
 * Fail if staged pier-ext src files introduce CJK in comments.
 * Runtime strings (notices, role issues) are code, not comments.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CJK = /[\u3400-\u9fff]/;
const COMMENT = /^\s*(\/\/|\/\*|\*)/;

function stagedSrcFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], {
    encoding: 'utf8',
  });
  return out.split(/\r?\n/).filter((f) => f.startsWith('packages/pier-ext/src/') && f.endsWith('.ts'));
}

const hits = [];
for (const file of stagedSrcFiles()) {
  let text;
  try {
    text = execFileSync('git', ['show', `:${file}`], { encoding: 'utf8' });
  } catch {
    text = readFileSync(file, 'utf8');
  }
  const lines = text.split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMMENT.test(line) && CJK.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
  }
}

if (hits.length) {
  console.error('✗ Chinese in comments (use English WHY). Runtime strings are fine:\n');
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
