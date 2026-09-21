/** Role domain: manifest validation, layered loading, composition, runtime gate and switch planning.
 * Every matrix below names its input, so a regression still points at the exact case that broke. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withCleanup } from './test-utils.ts';
import { validateRoleManifest } from '../src/role-manifest.ts';
import { RESERVED_ROLE_NAMES, ROLES_DIR, listRoleNames, loadRoleConfig, roleLayers, userRolesDir, workspaceRolesDir, type LayerReader, type RoleLoaderError, type RoleReader } from '../src/role-loader.ts';
import { ManifestError, composeForRole, composeManifest, toRuntimeManifest } from '../src/manifest-compose.ts';
import { initialRoleState, latestRoleManifestRecord, manifestFromRecord, planRoleSwitch, planSwitchActiveTools, roleRecordDiffers, type RoleManifestRecord } from '../src/role-state.ts';
import { parseRuntimeManifest, planActiveTools, planToolGate, type RuntimeRoleManifest } from '../src/tool-gate.ts';

/** Known-good manifest literal (independent truth: the finalized probe-role profile). */
const READONLY = {
  role: 'probe-role', version: '1.1.0', description: '只读worker角色：调研+搜索，不修改代码',
  manifest: { tools: ['bash', 'read', 'grep', 'glob', 'web_search', 'todo_write', 'ask_user_question'], rules: { write: 'deny', edit: 'deny', subagent: 'deny', bash: 'ask', '*': 'allow' } },
  services: { todos: { mode: 'serial' } },
} as const;

/* ── role-manifest: file format ────────────────────────────────────── */
test('validateRoleManifest: a good profile passes and keeps every field; omitted or stale fields are tolerated', () => {
  const r = validateRoleManifest(READONLY);
  assert.equal(r.ok, true, JSON.stringify((r as { issues?: string[] }).issues));
  if (!r.ok) return;
  assert.equal(r.value.role, 'probe-role'); assert.equal(r.value.version, '1.1.0');
  assert.equal(r.value.manifest.rules?.bash, 'ask'); assert.equal(r.value.manifest.rules?.write, 'deny');
  assert.equal(r.value.services?.todos?.mode, 'serial');

  const minimal = validateRoleManifest({ role: 'worker-default', version: '1.0.0', manifest: { tools: ['bash', 'read', 'todo_write', 'ask_user_question'] } });
  assert.equal(minimal.ok, true, JSON.stringify((minimal as { issues?: string[] }).issues));
  for (const stance of ['allow', 'deny'] as const) {
    const s = validateRoleManifest({ ...READONLY, manifest: { ...READONLY.manifest, unknownTools: stance } });
    assert.equal(s.ok, true);
    if (s.ok) assert.equal(s.value.manifest.unknownTools, stance);
  }
  // reminderLimit is no longer a contract key: ignored like any other unknown services.todos sub-key.
  assert.equal(validateRoleManifest({ ...READONLY, services: { todos: { mode: 'serial', reminderLimit: 3 } } }).ok, true);
});

test('validateRoleManifest: rejects every contract violation with a locatable issue', () => {
  const cases: Array<{ what: string; input: unknown; expect: string }> = [
    { what: 'version not x.y.z', input: { ...READONLY, version: '1.0' }, expect: 'version' },
    { what: 'version is a number', input: { ...READONLY, version: 1 }, expect: 'version' },
    { what: 'removed roleType key', input: { ...READONLY, roleType: 'executor' }, expect: 'roleType' },
    { what: 'removed constraints key', input: { ...READONLY, manifest: { ...READONLY.manifest, constraints: {} } }, expect: 'constraints' },
    { what: 'typo in a top-level key', input: { ...READONLY, rulez: {} }, expect: 'rulez' },
    { what: 'bare model name', input: { ...READONLY, model: 'muse-spark' }, expect: 'model' },
    { what: 'multi-slash model', input: { ...READONLY, model: 'a/b/c' }, expect: 'model' },
    { what: 'non-string model', input: { ...READONLY, model: 42 }, expect: 'model' },
    { what: 'unknownTools outside allow/deny', input: { ...READONLY, manifest: { ...READONLY.manifest, unknownTools: 'maybe' } }, expect: 'unknownTools' },
    { what: 'rules value outside allow/ask/deny', input: { ...READONLY, manifest: { ...READONLY.manifest, rules: { bash: 'maybe' } } }, expect: 'bash' },
    { what: 'rules key that is not a tool name', input: { ...READONLY, manifest: { ...READONLY.manifest, rules: { 'a b': 'allow' } } }, expect: 'a b' },
    { what: 'missing coordination tool', input: { ...READONLY, manifest: { ...READONLY.manifest, tools: ['bash', 'read', 'todo_write'] } }, expect: 'ask_user_question' },
    { what: 'empty tools array', input: { ...READONLY, manifest: { ...READONLY.manifest, tools: [] } }, expect: 'todo_write' },
    { what: 'duplicate tool', input: { ...READONLY, manifest: { ...READONLY.manifest, tools: [...READONLY.manifest.tools, 'bash'] } }, expect: 'bash' },
    { what: 'non-string tool', input: { ...READONLY, manifest: { ...READONLY.manifest, tools: ['bash', 42, 'todo_write', 'ask_user_question'] } }, expect: 'tools' },
    { what: 'service mode outside serial/parallel', input: { ...READONLY, services: { todos: { mode: 'concurrent' } } }, expect: 'mode' },
    { what: 'role name outside [a-z0-9-]+', input: { ...READONLY, role: 'Web Search' }, expect: 'role' },
  ];
  for (const { what, input, expect } of cases) {
    const result = validateRoleManifest(input);
    assert.equal(result.ok, false, `${what}: expected a rejection`);
    const issues = result.ok ? [] : result.issues;
    assert.ok(issues.some((issue) => issue.includes(expect)), `${what}: expected an issue mentioning "${expect}" (got ${issues.join(' | ')})`);
  }
});

/* ── role-loader: layered lookup ───────────────────────────────────── */
const CUSTOM = {
  role: 'reviewer', version: '1.0.0', description: '只读审查',
  manifest: { tools: ['read', 'grep', 'web_search', 'todo_write', 'ask_user_question'], rules: { write: 'deny', edit: 'deny' } },
};

/** Windows-shaped base: layer dirs must be derived through roleLayers, never pasted in by hand. */
const WIN = 'F:\\ws';
const [wsDir, userLayerDir, builtinLayerDir] = roleLayers({ baseDir: WIN }).map((layer) => layer.dir);

/** Legacy single-reader injection (bundled-layer semantics); a string value is raw file text. */
const flatRead = (files: Record<string, unknown>): RoleReader => (name) => {
  if (!(name in files)) throw Object.assign(new Error(`ENOENT: ${name}`), { code: 'ENOENT' });
  return typeof files[name] === 'string' ? (files[name] as string) : JSON.stringify(files[name]);
};

/** Three-layer in-memory reader, pasted onto workspace → user → bundled. */
const layerRead = (w: Record<string, unknown>, u: Record<string, unknown> = {}, b: Record<string, unknown> = {}): LayerReader => {
  const byDir: Record<string, Record<string, unknown>> = { [wsDir]: w, [userLayerDir]: u, [builtinLayerDir]: b };
  return (dir, name) => {
    const value = byDir[dir]?.[name];
    return value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value);
  };
};

test('loadRoleConfig: missing file, illegal names and malformed manifests are classified', () => {
  const cases: Array<{ what: string; name: string; code: string; files?: Record<string, unknown>; layers?: [Record<string, unknown>, Record<string, unknown>?, Record<string, unknown>?]; msg?: RegExp[]; issues?: RegExp[] }> = [
    { what: 'missing file', name: 'nope', files: {}, code: 'ROLE_NOT_FOUND' },
    { what: 'malformed JSON', name: 'broken', files: { 'broken.json': '{not json' }, code: 'INVALID_ROLE_CONFIG', msg: [/JSON/] },
    { what: 'contract violations', name: 'bad', files: { 'bad.json': { role: 'bad', version: '1.0', roleType: 'nope', manifest: { tools: [] } } }, code: 'INVALID_ROLE_CONFIG', issues: [/version/, /roleType/, /todo_write/] },
    { what: 'manifest under a different name', name: 'alpha', files: { 'alpha.json': { ...CUSTOM, role: 'beta' } }, code: 'INVALID_ROLE_CONFIG', msg: [/beta/] },
    // A hit that fails validation must fail loudly instead of falling through to a lower layer's copy.
    { what: 'invalid manifest at the hit layer', name: 'reviewer', layers: [{ 'reviewer.json': { ...CUSTOM, manifest: { tools: [] } } }, {}, { 'reviewer.json': CUSTOM }], code: 'INVALID_ROLE_CONFIG', msg: [/workspace/] },
  ];
  for (const c of cases) {
    const opts = c.layers ? { layerRead: layerRead(...c.layers), baseDir: WIN } : { read: flatRead(c.files ?? {}) };
    assert.throws(() => loadRoleConfig(c.name, opts), (e: unknown) => {
      const err = e as RoleLoaderError;
      return err.code === c.code && (c.msg ?? []).every((n) => n.test(err.message)) && (c.issues ?? []).every((n) => n.test(err.issues.join('\n')));
    }, c.what);
  }

  // An illegal name must be rejected before any disk access.
  let touched = false;
  const spy = (): string => { touched = true; throw new Error('should not read'); };
  for (const bad of ['../secret', 'a/b', 'A_B', '.hidden', '', 'café']) {
    assert.throws(() => loadRoleConfig(bad, { read: spy }), (e: unknown) => (e as RoleLoaderError).code === 'ROLE_NOT_FOUND', bad);
  }
  assert.equal(touched, false, 'an illegal name must never touch disk');
});

test('bundled manifests: loadable for both built-ins, and worker mirrors master minus the excluded families', () => {
  for (const name of ['worker-default', 'master']) {
    const role = loadRoleConfig(name);
    assert.equal(role.role, name); assert.match(role.version, /^\d+\.\d+\.\d+$/, name);
    assert.equal(role.model, undefined, `${name} leaves model routing to the process default`);
  }
  // D83 inheritance: worker-default.tools ≡ master.tools − subagent − terminal, pinned against drift.
  const EXCLUDED = ['subagent', 'terminal'];
  const master = loadRoleConfig('master');
  const worker = loadRoleConfig('worker-default');
  assert.deepEqual([...new Set(worker.manifest.tools)].sort(), [...new Set(master.manifest.tools.filter((t) => !EXCLUDED.includes(t)))].sort());
  for (const family of EXCLUDED) assert.equal(worker.manifest.rules?.[family], 'deny', `${family} stays denied under unknownTools=allow`);
  for (const need of ['todo_write', 'ask_user_question', 'subagent', 'terminal', 'pwsh', 'web_search']) assert.ok(master.manifest.tools.includes(need), `master.tools should include ${need}`);
  assert.equal(master.manifest.unknownTools, 'allow'); assert.equal(worker.manifest.unknownTools, 'allow');
});

test('layers: workspace wins over user, user over absent, and a miss lists every layer tried', () => {
  const read = layerRead({ 'reviewer.json': { ...CUSTOM, description: 'from ws' } }, { 'reviewer.json': { ...CUSTOM, description: 'from user' }, 'auditor.json': { ...CUSTOM, role: 'auditor' } });
  const hit = loadRoleConfig('reviewer', { layerRead: read, baseDir: WIN });
  assert.equal(hit.description, 'from ws');
  // A hit is returned validated and verbatim: the `*`-allow default is added by composeForRole, not here.
  assert.deepEqual(hit.manifest.tools, CUSTOM.manifest.tools); assert.deepEqual(hit.manifest.rules, CUSTOM.manifest.rules);
  assert.equal(loadRoleConfig('auditor', { layerRead: read, baseDir: WIN }).description, '只读审查');

  assert.throws(() => loadRoleConfig('ghost', { layerRead: layerRead({}), baseDir: WIN }), (e: unknown) => {
    const message = (e as Error).message;
    return (e as RoleLoaderError).code === 'ROLE_NOT_FOUND' && /workspace/.test(message) && /user/.test(message) && /builtin/.test(message);
  });

  // Layer layout: workspace → user → bundled, with the workspace one derived from the base dir.
  const WS = process.platform === 'win32' ? 'F:\\ws' : '/ws';
  assert.equal(workspaceRolesDir(WS), join(WS, '.pi-herdr', 'roles')); assert.equal(workspaceRolesDir(), join(process.cwd(), '.pi-herdr', 'roles'));
  assert.match(userRolesDir().replace(/\\/g, '/'), /\/\.pi\/agent\/herdr-pi\/roles$/);
  const layers = roleLayers({ baseDir: WS });
  assert.equal(layers.length, 3); assert.match(layers[0]!.dir.replace(/\\/g, '/'), /\.pi-herdr\/roles$/);
  assert.match(layers[2]!.dir.replace(/\\/g, '/'), /src\/roles$/);
});

test('layers: a reserved built-in name may not be overridden, and builtinDirect ignores the bait', () => {
  const read = layerRead({ 'master.json': { ...CUSTOM, role: 'master' } }, { 'worker-default.json': { ...CUSTOM, role: 'worker-default' } });
  for (const name of RESERVED_ROLE_NAMES) {
    assert.throws(() => loadRoleConfig(name, { layerRead: read, baseDir: WIN }),
      (e: unknown) => (e as RoleLoaderError).code === 'ROLE_RESERVED' && (e as Error).message.includes(name), name);
  }

  // builtinDirect is the master's self-application path: skipping the user layers keeps a workspace
  // master.json from making self-application fail open.
  const bundled: LayerReader = (dir, fileName) =>
    dir === ROLES_DIR ? (existsSync(join(dir, fileName)) ? readFileSync(join(dir, fileName), 'utf8') : null) : read(dir, fileName);
  const role = loadRoleConfig('master', { layerRead: bundled, baseDir: WIN, builtinDirect: true });
  assert.notEqual(role.version, CUSTOM.version); assert.ok(role.manifest.tools.includes('subagent'));
});

test('listRoleNames: the workspace and user layers, deduped and sorted, built-ins excluded', withCleanup(async (cleanup) => {
  const ws = cleanup.tempDir('roles-ws').path;
  const user = cleanup.tempDir('roles-user').path;
  await mkdir(join(ws, '.pi-herdr', 'roles'), { recursive: true });
  for (const name of ['reviewer', 'auditor']) await writeFile(join(ws, '.pi-herdr', 'roles', `${name}.json`), '{}');
  await writeFile(join(ws, '.pi-herdr', 'roles', 'notes.txt'), 'ignored');
  for (const name of ['auditor', 'builder']) await writeFile(join(user, `${name}.json`), '{}');
  // `auditor` appears in both layers, so it is listed once.
  assert.deepEqual(listRoleNames(ws, user), ['auditor', 'builder', 'reviewer']);
  // Missing directories contribute nothing instead of throwing.
  assert.deepEqual(listRoleNames(join(ws, 'absent'), join(user, 'absent')), []);
}));

/* ── manifest-compose ──────────────────────────────────────────────── */
test('composeManifest: union of baseline and suggestion, deterministic order, deny wins', () => {
  const union = composeManifest({ roleBaseline: ['bash', 'edit', 'write', 'todo_write'], modelSuggested: ['read', 'grep', 'bash'], rulePermissions: { '*': 'allow' } });
  assert.deepEqual(union.tools, ['bash', 'edit', 'grep', 'read', 'todo_write', 'write']);

  const denied = composeManifest({ roleBaseline: ['bash', 'edit', 'read', 'todo_write'], modelSuggested: ['write', 'bash'], rulePermissions: { write: 'deny', edit: 'deny', '*': 'allow' } });
  assert.deepEqual(denied.tools, ['bash', 'read', 'todo_write']);
  assert.deepEqual(denied.permissions, { write: 'deny', edit: 'deny', bash: 'allow', read: 'allow', todo_write: 'allow' });

  // Three-state mix (websearch shape): deny excludes, ask marks, both stay visible in permissions.
  const mixed = composeManifest({ roleBaseline: ['bash', 'read', 'grep', 'web_search', 'todo_write'], modelSuggested: ['bash', 'write'], rulePermissions: { bash: 'ask', write: 'deny', edit: 'deny', '*': 'allow' } });
  assert.deepEqual(mixed.tools, ['bash', 'grep', 'read', 'todo_write', 'web_search']); assert.equal(mixed.permissions.bash, 'ask');
  assert.equal(mixed.permissions.write, 'deny');
});

test('composeManifest: `*` supplies the default, explicit rules win, deny rules survive outside the tool set', () => {
  const explicit = composeManifest({ roleBaseline: ['read', 'todo_write'], modelSuggested: [], rulePermissions: { '*': 'ask' } });
  assert.deepEqual(explicit.permissions, { read: 'ask', todo_write: 'ask' });

  const noStar = composeManifest({ roleBaseline: ['read', 'todo_write'], modelSuggested: [], rulePermissions: { write: 'deny' } });
  assert.deepEqual(noStar.permissions, { write: 'deny', read: 'allow', todo_write: 'allow' });

  const stance = composeManifest({ roleBaseline: ['bash', 'read', 'todo_write'], modelSuggested: [], rulePermissions: { subagent: 'deny', terminal: 'deny', '*': 'allow' }, unknownTools: 'allow' });
  assert.equal(stance.unknownTools, 'allow'); assert.equal(stance.permissions.subagent, 'deny');
  assert.ok(!stance.tools.includes('subagent'));
});

test('composeManifest: empty result and empty baseline are loud, non-string tools are dropped', () => {
  assert.throws(() => composeManifest({ roleBaseline: ['bash'], modelSuggested: ['read'], rulePermissions: { bash: 'deny', read: 'deny', '*': 'deny' } }),
    (e: unknown) => e instanceof ManifestError && e.code === 'EMPTY_MANIFEST' && /bash/.test(e.message) && /read/.test(e.message));
  assert.throws(() => composeManifest({ roleBaseline: [], modelSuggested: ['bash'], rulePermissions: { '*': 'allow' } }),
    (e: unknown) => e instanceof ManifestError && e.code === 'INVALID_ROLE_CONFIG' && /todo_write/.test(e.message));

  const dirty = { roleBaseline: ['read', 'todo_write', 42 as never], modelSuggested: [], rulePermissions: {} };
  assert.deepEqual(composeManifest(dirty).tools, ['read', 'todo_write']);
  assert.deepEqual(composeManifest(dirty), composeManifest(dirty), 'composition is deterministic');
});

test('toRuntimeManifest: one projection from a composed profile to the runtime shape', () => {
  const composed = composeForRole('master', [], { loadRoleOpts: { builtinDirect: true } });
  const runtime = toRuntimeManifest(composed);
  assert.equal(runtime.role, 'master'); assert.equal(runtime.version, composed.role.version);
  assert.deepEqual(runtime.tools, composed.manifest.tools); assert.deepEqual(runtime.permissions, composed.manifest.permissions);
  assert.equal(runtime.unknownTools, composed.manifest.unknownTools); assert.deepEqual(runtime.services, composed.role.services ?? {});
  assert.equal(runtime.guidelines, undefined, 'master ships no guidelines');
});

/* ── tool-gate: runtime gate and visibility ────────────────────────── */
const WORKER: RuntimeRoleManifest = { role: 'worker-readonly', version: '1.1.0', tools: ['bash', 'read', 'grep', 'web_search', 'todo_write', 'ask_user_question'], permissions: { bash: 'ask', write: 'deny', '*': 'allow' } };
const STANCE: RuntimeRoleManifest = { role: 'worker-default', version: '1.3.0', tools: ['bash', 'read', 'todo_write'], permissions: { subagent: 'deny', terminal: 'deny', '*': 'allow' }, unknownTools: 'allow' };

test('planToolGate: no manifest stays open; allow/ask/deny follow the manifest and the stance', () => {
  const cases: Array<{ what: string; tool: string; manifest: RuntimeRoleManifest | null; kind: string; notice?: string; reason?: RegExp[] }> = [
    { what: 'no manifest stays open', tool: 'bash', manifest: null, kind: 'open' },
    { what: 'listed tool', tool: 'read', manifest: WORKER, kind: 'allow' },
    { what: 'ask carries the approval notice', tool: 'bash', manifest: WORKER, kind: 'ask', notice: '[APPROVAL_NEEDED] worker-readonly.bash' },
    { what: 'permission deny on a tool pruned out of tools', tool: 'write', manifest: WORKER, kind: 'deny', reason: [/worker-readonly/, /write/] },
    { what: 'explicit deny outside the tool set', tool: 'subagent', manifest: WORKER, kind: 'deny' },
    { what: 'unknown tool under allow stance (D82)', tool: 'muse_deep_think', manifest: STANCE, kind: 'allow' },
    { what: 'listed tool under allow stance', tool: 'bash', manifest: STANCE, kind: 'allow' },
    { what: 'unknown tool under deny stance', tool: 'muse_deep_think', manifest: { ...WORKER, unknownTools: 'deny' }, kind: 'deny' },
    { what: 'unknown tool under ask stance', tool: 'muse_deep_think', manifest: { ...STANCE, permissions: { ...STANCE.permissions, '*': 'ask' } }, kind: 'ask', notice: '[APPROVAL_NEEDED] worker-default.muse_deep_think' },
  ];
  for (const c of cases) {
    const plan = planToolGate(c.tool, c.manifest);
    assert.equal(plan.kind, c.kind, `${c.what}: ${JSON.stringify(plan)}`);
    if (plan.kind === 'ask' && c.notice !== undefined) assert.equal(plan.notice, c.notice, c.what);
    for (const needle of c.reason ?? []) assert.match((plan as { reason: string }).reason, needle, c.what);
  }
});

test('planActiveTools: intersects with the manifest, never clears the set, reports no-op as unchanged', () => {
  const cases: Array<{ what: string; tools: string[]; active: string[]; opts?: Parameters<typeof planActiveTools>[2]; expect: { next: string[]; changed: boolean } | null }> = [
    // A plugin that registers four web tools but is granted only web_search loses the other three.
    { what: 'prunes to the manifest', tools: ['bash', 'read', 'grep', 'web_search', 'todo_write'], active: ['read', 'bash', 'web_search', 'source_check', 'fetch_content', 'get_search_content', 'todo_write'], expect: { next: ['read', 'bash', 'web_search', 'todo_write'], changed: true } },
    { what: 'no-op reports unchanged', tools: ['read', 'bash', 'todo_write', 'grep'], active: ['read', 'bash', 'todo_write'], expect: { next: ['read', 'bash', 'todo_write'], changed: false } },
    { what: 'nothing would remain', tools: ['web_search'], active: ['read', 'bash', 'edit'], expect: null },
    { what: 'empty manifest tools', tools: [], active: ['read', 'bash'], expect: null },
    { what: 'empty active set', tools: ['read'], active: [], expect: null },
    // Allow stance hides only the explicit denies.
    { what: 'allow stance keeps unknown tools', tools: STANCE.tools, active: ['read', 'bash', 'subagent', 'terminal', 'muse_deep_think', 'todo_write'], opts: { unknownTools: STANCE.unknownTools, permissions: STANCE.permissions }, expect: { next: ['read', 'bash', 'muse_deep_think', 'todo_write'], changed: true } },
    { what: 'allow stance already satisfied', tools: ['read', 'bash'], active: ['read', 'bash', 'muse_deep_think'], opts: { unknownTools: 'allow', permissions: { '*': 'allow' } }, expect: { next: ['read', 'bash', 'muse_deep_think'], changed: false } },
    { what: 'all denied fails open', tools: ['bash'], active: ['subagent', 'terminal'], opts: { unknownTools: 'allow', permissions: { subagent: 'deny', terminal: 'deny' } }, expect: null },
  ];
  for (const c of cases) assert.deepEqual(planActiveTools(c.tools, c.active, c.opts), c.expect, c.what);
});

test('parseRuntimeManifest: malformed env is null (fail-open), garbage stance degrades to deny', () => {
  for (const raw of [undefined, '', 'not-json', 'null', '[]', '{"tools":["bash"]}', '{"role":"w"}', '{"role":1,"tools":["bash"]}', '{"role":"w","tools":"bash"}']) {
    assert.equal(parseRuntimeManifest(raw), null, JSON.stringify(raw));
  }
  const ok = parseRuntimeManifest(JSON.stringify({ role: 'worker-readonly', tools: ['bash', 'read'], permissions: { '*': 'allow' }, unknownTools: 'allow' }));
  assert.equal(ok?.role, 'worker-readonly'); assert.deepEqual(ok?.tools, ['bash', 'read']);
  assert.equal(ok?.unknownTools, 'allow');

  const garbage = parseRuntimeManifest(JSON.stringify({ role: 'w', tools: ['bash'], permissions: {}, unknownTools: 'maybe' }));
  assert.equal(garbage?.unknownTools, 'deny'); assert.equal(planToolGate('muse_deep_think', garbage).kind, 'deny');
  assert.deepEqual(parseRuntimeManifest(JSON.stringify({ role: 'w', tools: [], guidelines: [' ok ', 7, ''] }))?.guidelines, [' ok ']);
});

/* ── role-state: replay, change-only writes, switch planning ───────── */
const WORKER_STATE_MANIFEST: RuntimeRoleManifest = { role: 'worker-default', version: '1.0.0', tools: ['read', 'bash', 'grep', 'todo_write', 'ask_user_question'], permissions: { '*': 'allow' }, unknownTools: 'deny' };

test('replay: takes the last well-formed entry and skips junk without losing the rest', () => {
  const entries = [
    { type: 'custom', customType: 'pi-herdr.role-manifest', data: { version: 1, role: 'worker-default', tools: ['read'], permissions: {}, unknownTools: 'deny' } },
    { type: 'message', role: 'user' },
    { type: 'custom', customType: 'pi-herdr.todo-edit', data: { edits: [] } },
    { type: 'custom', customType: 'pi-herdr.role-manifest', data: { role: 42 } }, // malformed: role is not a string
    { type: 'custom', customType: 'pi-herdr.role-manifest', data: { version: 1, role: 'reviewer', tools: ['read', 'grep'], permissions: { write: 'deny' }, unknownTools: 'allow', guidelines: ['bash 只用于运行测试'], origin: 'switch', switchedBy: 'p-master', ts: 123 } },
  ];
  const rec = latestRoleManifestRecord(entries);
  assert.equal(rec?.role, 'reviewer'); assert.equal(rec?.origin, 'switch');
  assert.equal(rec?.switchedBy, 'p-master'); assert.equal(rec?.ts, 123);
  assert.deepEqual(rec?.guidelines, ['bash 只用于运行测试']); assert.equal(latestRoleManifestRecord([entries[3], { type: 'custom', customType: 'x', data: null }]), null);
});

test('replay: malformed fields fall back to defaults and feed manifestFromRecord', () => {
  const rec = latestRoleManifestRecord([{ type: 'custom', customType: 'pi-herdr.role-manifest', data: { role: 'r', tools: ['read'], permissions: 'not-an-object', guidelines: ['ok', 7, null], unknownTools: 'weird' } }]);
  assert.ok(rec); assert.deepEqual(rec.guidelines, ['ok']);
  assert.deepEqual(rec.permissions, {}); assert.equal(rec.unknownTools, 'deny');
  const manifest = manifestFromRecord(rec);
  assert.equal(manifest.role, 'r'); assert.equal(manifest.version, undefined);
  assert.deepEqual(manifest.tools, ['read']); assert.deepEqual(manifest.guidelines, ['ok']);

  const empty = latestRoleManifestRecord([{ type: 'custom', customType: 'pi-herdr.role-manifest', data: { role: 'r', tools: ['read'], guidelines: [] } }]);
  assert.ok(empty); assert.equal(empty.guidelines, undefined);
  assert.equal(manifestFromRecord(empty).guidelines, undefined);
});

test('roleRecordDiffers: writes the anchor once, then only when role or tools changed', () => {
  const state = initialRoleState(WORKER_STATE_MANIFEST);
  const record = (over: Partial<RoleManifestRecord> = {}): RoleManifestRecord => ({ version: 1 as const, role: 'worker-default', tools: [...WORKER_STATE_MANIFEST.tools], permissions: {}, unknownTools: 'deny' as const, ...over });
  const cases: Array<[string, RoleManifestRecord | null, boolean]> = [
    ['first start must write the anchor', null, true],
    ['resume without a switch is a no-op', record(), false],
    ['role changed', record({ role: 'reviewer', tools: ['read'] }), true],
    ['a manifest evolution rewrites', record({ tools: ['read'] }), true],
  ];
  for (const [what, rec, expect] of cases) assert.equal(roleRecordDiffers(rec, state), expect, what);
  assert.equal(roleRecordDiffers(record(), initialRoleState(null)), false, 'unarmed sessions never write');
});

test('planRoleSwitch: widening is "the target adds a tool", diffs are both directions', () => {
  const cases: Array<[string, string[], string[], { widening: boolean; added: string[]; removed: string[] }]> = [
    ['widening', ['read', 'grep'], ['read', 'grep', 'bash'], { widening: true, added: ['bash'], removed: [] }],
    ['narrowing', ['read', 'bash', 'edit'], ['read', 'bash'], { widening: false, added: [], removed: ['edit'] }],
  ];
  for (const [what, from, to, expect] of cases) assert.deepEqual(planRoleSwitch(from, to), expect, what);
});

test('planSwitchActiveTools: the universe is every registered tool, so a switch can re-admit tools', () => {
  const REGISTERED = ['read', 'bash', 'edit', 'write', 'grep', 'todo_write', 'ask_user_question', 'subagent'];
  const cases: Array<{ what: string; tools: string[]; registered: string[]; opts?: Parameters<typeof planSwitchActiveTools>[2]; expect: string[] }> = [
    // worker-default (no edit/write) pruned the active set; switching to a role that allows edit must
    // re-admit it, which intersection with the CURRENT active set could not do.
    { what: 're-admits pruned tools', tools: ['read', 'bash', 'edit', 'todo_write', 'ask_user_question'], registered: REGISTERED, expect: ['read', 'bash', 'edit', 'todo_write', 'ask_user_question'] },
    // Allow stance: keep every registered tool but the explicit denies.
    { what: 'allow stance keeps registered tools', tools: ['read', 'bash'], registered: ['read', 'bash', 'web_search', 'subagent', 'todo_write'], opts: { unknownTools: 'allow', permissions: { subagent: 'deny' } }, expect: ['read', 'bash', 'web_search', 'todo_write'] },
    // Unregistered manifest entries are ignored; an empty result is a legitimate shrink, not a no-op.
    { what: 'unregistered entries are ignored', tools: ['read', 'ghost_tool'], registered: ['read', 'bash'], expect: ['read'] },
    { what: 'all tools unknown', tools: ['nope'], registered: ['read', 'bash'], expect: [] },
  ];
  for (const c of cases) assert.deepEqual(planSwitchActiveTools(c.tools, c.registered, c.opts), c.expect, c.what);
});

test('initialRoleState: env origin with no switch trace; a bare pi session carries no manifest', () => {
  const state = initialRoleState(WORKER_STATE_MANIFEST);
  assert.equal(state.manifest?.role, 'worker-default'); assert.equal(state.origin, 'env');
  assert.equal(state.switchedBy, null); assert.equal(state.switchedAt, null);
  assert.equal(initialRoleState(null).manifest, null);
});
