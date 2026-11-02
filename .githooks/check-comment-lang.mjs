#!/usr/bin/env node
/**
 * Fail if staged source files introduce CJK in comments.
 * Runtime strings (notices, role issues) are code, not comments.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const CJK = /[\u3400-\u9fff]/;
const COMMENT = /^\s*(\/\/|\/\*|\*)/;

const TARGET_SCOPES = [
  'packages/pier-ext/src/',
  'install.mjs',
];

function isTargetFile(file) {
  if (!file || file.endsWith('.toml')) return false;
  if (file === 'install.mjs') return true;
  return TARGET_SCOPES.some((scope) => scope !== 'install.mjs' && file.startsWith(scope));
}

const explicit = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const isExplicit = explicit.length > 0;

function resolveFilesToCheck() {
  if (isExplicit) {
    return explicit.filter(isTargetFile);
  }
  if (process.argv.includes('--all')) {
    const out = execFileSync('git', ['ls-files'], { encoding: 'utf8' });
    return out.split(/\r?\n/).filter(isTargetFile);
  }
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], {
    encoding: 'utf8',
  });
  return out.split(/\r?\n/).filter(isTargetFile);
}

const hits = [];
for (const file of resolveFilesToCheck()) {
  if (!existsSync(file)) continue;
  let text;
  if (isExplicit) {
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
  } else {
    try {
      text = execFileSync('git', ['show', `:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
    }
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
