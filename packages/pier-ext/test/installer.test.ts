/**
 * Installer + production-loader guards.
 *
 * - Production must not loader.create() .ts files unless HMR is active (Node
 *   cannot strip types under node_modules; the loader path exists for dev HMR).
 * - The installer CLI must stay runnable from an npx cache (no repo checkout).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const master = readFileSync(fileURLToPath(new URL('../src/index-master.ts', import.meta.url)), 'utf8');

test('production mount uses loader.create only when HMR is active', () => {
  assert.match(master, /loaderReady && cordisApp\.hmrActive/);
  assert.match(master, /loadEntry\(sessionRoot, useLoader,/);
});

test('prepare links node_modules/.bin/pier-setup so in-repo npx finds the CLI', () => {
  const r = spawnSync(process.execPath, [join(root, 'install.mjs'), '--prepare'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(existsSync(join(root, 'node_modules', '.bin', 'pier-setup')));
});

test('version --json and --help', () => {
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
