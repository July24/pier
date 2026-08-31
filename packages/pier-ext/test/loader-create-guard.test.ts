/**
 * Issue #1: npx pier-setup + npm:pi-pier load failures.
 * - User-mode installer must not require packages/pier-ext next to install.mjs
 *   (npx cache only contains install.mjs).
 * - Production must not loader.create() .ts files (Node cannot strip types
 *   under node_modules; native import also misses pi's typebox alias).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

test('prepare links node_modules/.bin/pier-setup so in-repo npx finds the CLI', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const r = spawnSync(process.execPath, [join(root, 'install.mjs'), '--prepare'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(existsSync(join(root, 'node_modules', '.bin', 'pier-setup')));
});

test('update does not uninstall first', () => {
  assert.match(install, /function update\(/);
  assert.doesNotMatch(install, /command === 'update'\)[^{]*\{[^}]*uninstall\(\)/);
  assert.match(install, /pi', \['update'/);
});

test('version --json and --help', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const cli = join(root, 'install.mjs');
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /pier-setup version/);
  assert.match(help.stdout, /pier-setup update/);
  const ver = spawnSync(process.execPath, [cli, 'version', '--json'], { encoding: 'utf8' });
  assert.equal(ver.status, 0, ver.stderr);
  const data = JSON.parse(ver.stdout);
  assert.equal(data.installer.name, 'pier-setup');
  assert.ok(data.installer.version);
  assert.ok('piExt' in data && 'herdr' in data && 'latest' in data);
});
