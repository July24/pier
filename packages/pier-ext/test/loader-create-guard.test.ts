/**
 * Issue #1: npx pier-setup + npm:pi-pier load failures.
 * - User-mode installer must not require packages/pier-ext next to install.mjs
 *   (npx cache only contains install.mjs).
 * - Production must not loader.create() .ts files (Node cannot strip types
 *   under node_modules; native import also misses pi's typebox alias).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const master = readFileSync(fileURLToPath(new URL('../src/index-master.ts', import.meta.url)), 'utf8');
const install = readFileSync(fileURLToPath(new URL('../../../install.mjs', import.meta.url)), 'utf8');

test('production mount uses loader.create only when HMR is active', () => {
  assert.match(master, /loaderReady && cordisApp\.hmrActive/);
  assert.match(master, /loadEntry\(sessionRoot, useLoader,/);
});

test('npx user-mode does not die on installer-package EXT_PATH', () => {
  const dieAt = install.indexOf('if (!existsSync(EXT_PATH)) die');
  assert.ok(dieAt >= 0, 'dev-mode EXT_PATH check still present');
  assert.match(install.slice(Math.max(0, dieAt - 120), dieAt), /if \(dev\)/);
  assert.match(install, /function resolveUserExtPath/);
  assert.match(install, /npm.*node_modules.*pi-pier/);
});
