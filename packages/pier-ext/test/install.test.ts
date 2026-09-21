/**
 * Boot and installer guards — both about starting pier outside a dev checkout: the cordis tree
 * bootstrap (Loader + conditionally mounted HMR) and the `pier-setup` CLI.
 *
 * - Production must not loader.create() .ts files unless HMR is active (Node cannot strip types
 *   under node_modules; the loader path exists for dev HMR only).
 * - The installer CLI must stay runnable from an npx cache (no repo checkout).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCordisApp, detectExposeInternals } from '../src/bootstrap.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const master = readFileSync(fileURLToPath(new URL('../src/index-master.ts', import.meta.url)), 'utf8');

test('bootstrap: Loader mounts, hmr stays off, dispose runs the shutdown hook', async () => {
  let disposed = false;
  const app = await createCordisApp({ onDispose: () => { disposed = true; } });
  assert.equal(app.loaderReady, true);
  const withLoader = app.root as unknown as { loader?: { builtins: Record<string, unknown> } };
  assert.ok(withLoader.loader, 'the loader service is on the tree');
  assert.ok(withLoader.loader.builtins.group, 'the cordis:group builtin is registered (D80③)');
  assert.equal(app.hmrActive, false, 'no --expose-internals + PI_HERDR_HMR → hmr is not mounted (zero watchers)');
  assert.equal(typeof detectExposeInternals(), 'boolean');
  assert.equal(detectExposeInternals(), process.execArgv.includes('--expose-internals'), 'the flag is read from the current execArgv');
  await app.root.fiber.dispose();
  assert.equal(disposed, true, 'onDispose runs on tree teardown (session_shutdown path)');
});

test('production mount uses loader.create only when HMR is active', () => {
  assert.match(master, /loaderReady && cordisApp\.hmrActive/);
  assert.match(master, /loadEntry\(sessionRoot, useLoader,/);
});

test('prepare links node_modules/.bin/pier-setup so in-repo npx finds the CLI', () => {
  const r = spawnSync(process.execPath, [join(root, 'install.mjs'), '--prepare'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(existsSync(join(root, 'node_modules', '.bin', 'pier-setup')));
});

test('installer CLI: version --json and --help', () => {
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
