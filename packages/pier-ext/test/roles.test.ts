/**
 * Role domain: manifest validation, layered loading, composition, runtime gate and switch planning.
 * One file because the five seams hand off to each other (file format → load → compose → gate/switch).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRoleManifest } from '../src/role-manifest.ts';
import {
  RESERVED_ROLE_NAMES,
  ROLES_DIR,
  RoleLoaderError,
  listRoleNames,
  loadRoleConfig,
  roleLayers,
  userRolesDir,
  workspaceRolesDir,
  type LayerReader,
} from '../src/role-loader.ts';
import { ManifestError, composeForRole, composeManifest, toRuntimeManifest } from '../src/manifest-compose.ts';
import {
  initialRoleState,
  latestRoleManifestRecord,
  manifestFromRecord,
  planRoleSwitch,
  planSwitchActiveTools,
  roleRecordDiffers,
} from '../src/role-state.ts';
import { parseRuntimeManifest, planActiveTools, planToolGate, type RuntimeRoleManifest } from '../src/tool-gate.ts';

/** Known-good manifest literal (independent truth: the finalized probe-role profile). */
const READONLY = {
  role: 'probe-role',
  version: '1.1.0',
  description: '只读worker角色：调研+搜索，不修改代码',
  manifest: {
    tools: ['bash', 'read', 'grep', 'glob', 'web_search', 'todo_write', 'ask_user_question'],
    rules: { write: 'deny', edit: 'deny', subagent: 'deny', bash: 'ask', '*': 'allow' },
  },
  services: { todos: { mode: 'serial' } },
} as const;

function issuesOf(input: unknown): string[] {
  const result = validateRoleManifest(input);
  assert.equal(result.ok, false, `expected issues for ${JSON.stringify(input)}`);
  return (result as { issues: string[] }).issues;
}

/* ── role-manifest: file format ────────────────────────────────────── */

test('validateRoleManifest: the finalized probe-role profile passes and keeps every field', () => {
  const r = validateRoleManifest(READONLY);
  assert.equal(r.ok, true, JSON.stringify((r as { issues?: string[] }).issues));
  if (!r.ok) return;
  assert.equal(r.value.role, 'probe-role');
  assert.equal(r.value.version, '1.1.0');
  assert.equal(r.value.manifest.rules?.bash, 'ask');
  assert.equal(r.value.manifest.rules?.write, 'deny');
  assert.equal(r.value.services?.todos?.mode, 'serial');
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
    assert.ok(issuesOf(input).some((issue) => issue.includes(expect)), `${what}: expected an issue mentioning "${expect}"`);
  }
});

test('validateRoleManifest: optional fields may all be omitted; stale services sub-keys are ignored', () => {
  const minimal = validateRoleManifest({
    role: 'worker-default',
    version: '1.0.0',
    manifest: { tools: ['bash', 'read', 'todo_write', 'ask_user_question'] },
  });
  assert.equal(minimal.ok, true, JSON.stringify((minimal as { issues?: string[] }).issues));

  for (const stance of ['allow', 'deny'] as const) {
    const r = validateRoleManifest({ ...READONLY, manifest: { ...READONLY.manifest, unknownTools: stance } });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.manifest.unknownTools, stance);
  }
  // reminderLimit is no longer a contract key: ignored like any other unknown services.todos sub-key.
  assert.equal(validateRoleManifest({ ...READONLY, services: { todos: { mode: 'serial', reminderLimit: 3 } } }).ok, true);
});

/* ── role-loader: layered lookup ───────────────────────────────────── */

const GOOD = {
  role: 'worker-default',
  version: '1.0.0',
  manifest: { tools: ['bash', 'read', 'todo_write', 'ask_user_question'] },
};

const CUSTOM = {
  role: 'reviewer',
  version: '1.0.0',
  description: '只读审查',
  manifest: {
    tools: ['read', 'grep', 'web_search', 'todo_write', 'ask_user_question'],
    rules: { write: 'deny', edit: 'deny' },
  },
};

/** Legacy single-reader injection: in-memory file table keyed by file name. */
function readerWith(files: Record<string, unknown>): (name: string) => string {
  return (name) => {
    if (name in files) return JSON.stringify(files[name]);
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
}

/** Three-layer memory reader: byDir keys are pasted onto the layers in roleLayers order. */
function layerReaderWith(byDir: Record<string, Record<string, unknown>>): { read: LayerReader; dirs: string[] } {
  const dirs = roleLayers({ baseDir: 'F:\\ws' }).map((layer) => layer.dir);
  const map = new Map<string, Record<string, unknown>>();
  Object.keys(byDir).forEach((key, i) => {
    if (dirs[i]) map.set(dirs[i]!, byDir[key]!);
  });
  return {
    dirs,
    read: (dir, fileName) => {
      const files = map.get(dir);
      return files && fileName in files ? JSON.stringify(files[fileName]) : null;
    },
  };
}

function loadError(name: string, files: Record<string, unknown>, expect: string): void {
  assert.throws(
    () => loadRoleConfig(name, { read: readerWith(files) }),
    (e: unknown) => (e as RoleLoaderError).code === expect,
  );
}

test('loadRoleConfig: reads and validates; the `*`-allow default is composeForRole\'s job, not the loader\'s', () => {
  const role = loadRoleConfig('worker-default', { read: readerWith({ 'worker-default.json': GOOD }) });
  assert.equal(role.role, 'worker-default');
  assert.deepEqual(role.manifest.tools, GOOD.manifest.tools);
});

test('loadRoleConfig: missing file, illegal names and malformed manifests are classified', () => {
  loadError('nope', {}, 'ROLE_NOT_FOUND');

  let touched = false;
  const spy = (): string => {
    touched = true;
    throw new Error('should not read');
  };
  for (const bad of ['../secret', 'a/b', 'A_B', '.hidden', '', 'café']) {
    assert.throws(() => loadRoleConfig(bad, { read: spy }), (e: unknown) => (e as RoleLoaderError).code === 'ROLE_NOT_FOUND');
  }
  assert.equal(touched, false, 'an illegal name must never touch disk');

  assert.throws(
    () => loadRoleConfig('broken', { read: () => '{not json' }),
    (e: unknown) => (e as RoleLoaderError).code === 'INVALID_ROLE_CONFIG' && /JSON/.test((e as Error).message),
  );

  const badManifest = { role: 'bad', version: '1.0', roleType: 'nope', manifest: { tools: [] } };
  assert.throws(
    () => loadRoleConfig('bad', { read: readerWith({ 'bad.json': badManifest }) }),
    (e: unknown) => {
      const issues = (e as RoleLoaderError).issues.join('\n');
      return /version/.test(issues) && /roleType/.test(issues) && /todo_write/.test(issues);
    },
  );

  assert.throws(
    () => loadRoleConfig('alpha', { read: readerWith({ 'alpha.json': { ...GOOD, role: 'beta' } }) }),
    (e: unknown) => (e as RoleLoaderError).code === 'INVALID_ROLE_CONFIG' && /beta/.test((e as Error).message),
    'a manifest may not attach under a different name',
  );
});

test('bundled manifests: loadable for both built-ins, and worker mirrors master minus the excluded families', () => {
  for (const name of ['worker-default', 'master']) {
    const role = loadRoleConfig(name);
    assert.equal(role.role, name);
    assert.match(role.version, /^\d+\.\d+\.\d+$/, name);
    assert.equal(role.model, undefined, `${name} leaves model routing to the process default`);
  }
  // D83 inheritance: worker-default.tools ≡ master.tools − subagent − terminal, pinned against drift.
  const EXCLUDED = ['subagent', 'terminal'];
  const master = loadRoleConfig('master');
  const worker = loadRoleConfig('worker-default');
  const expected = [...new Set(master.manifest.tools.filter((t) => !EXCLUDED.includes(t)))].sort();
  assert.deepEqual([...new Set(worker.manifest.tools)].sort(), expected);
  for (const family of EXCLUDED) {
    assert.equal(worker.manifest.rules?.[family], 'deny', `${family} stays denied under unknownTools=allow`);
  }
  for (const need of ['todo_write', 'ask_user_question', 'subagent', 'terminal', 'pwsh', 'web_search']) {
    assert.ok(master.manifest.tools.includes(need), `master.tools should include ${need}`);
  }
  assert.equal(master.manifest.unknownTools, 'allow');
  assert.equal(worker.manifest.unknownTools, 'allow');
});

test('layers: workspace wins over user, user over absent, and a miss lists every layer tried', () => {
  const { read } = layerReaderWith({
    w: { 'reviewer.json': { ...CUSTOM, description: 'from ws' } },
    u: { 'reviewer.json': { ...CUSTOM, description: 'from user' }, 'auditor.json': { ...CUSTOM, role: 'auditor' } },
    b: {},
  });
  assert.equal(loadRoleConfig('reviewer', { layerRead: read, baseDir: 'F:\\ws' }).description, 'from ws');
  assert.equal(loadRoleConfig('auditor', { layerRead: read, baseDir: 'F:\\ws' }).description, '只读审查');

  const empty = layerReaderWith({ b: {} });
  assert.throws(
    () => loadRoleConfig('ghost', { layerRead: empty.read, baseDir: 'F:\\ws' }),
    (e: unknown) => {
      const message = (e as Error).message;
      return (e as RoleLoaderError).code === 'ROLE_NOT_FOUND'
        && /workspace/.test(message) && /user/.test(message) && /builtin/.test(message);
    },
  );
});

test('layers: a reserved built-in name may not be overridden, and builtinDirect ignores the bait', () => {
  const { read } = layerReaderWith({
    w: { 'master.json': { ...CUSTOM, role: 'master' } },
    u: { 'worker-default.json': { ...CUSTOM, role: 'worker-default' } },
    b: {},
  });
  for (const name of RESERVED_ROLE_NAMES) {
    assert.throws(
      () => loadRoleConfig(name, { layerRead: read, baseDir: 'F:\\ws' }),
      (e: unknown) => (e as RoleLoaderError).code === 'ROLE_RESERVED' && (e as Error).message.includes(name),
    );
  }

  // builtinDirect is the master's self-application path: skip the user layers and read the bundled
  // file itself, so a workspace master.json cannot make self-application fail open.
  const builtin: LayerReader = (dir, fileName) =>
    dir === ROLES_DIR ? (existsSync(join(dir, fileName)) ? readFileSync(join(dir, fileName), 'utf8') : null) : read(dir, fileName);
  assert.throws(
    () => loadRoleConfig('master', { layerRead: builtin, baseDir: 'F:\\ws' }),
    (e: unknown) => (e as RoleLoaderError).code === 'ROLE_RESERVED',
  );
  const role = loadRoleConfig('master', { layerRead: builtin, baseDir: 'F:\\ws', builtinDirect: true });
  assert.notEqual(role.version, CUSTOM.version);
  assert.ok(role.manifest.tools.includes('subagent'));
});

test('layers: an invalid manifest at the hit layer fails loudly instead of falling through', () => {
  const { read } = layerReaderWith({
    w: { 'reviewer.json': { ...CUSTOM, manifest: { tools: [] } } },
    b: { 'reviewer.json': CUSTOM },
  });
  assert.throws(
    () => loadRoleConfig('reviewer', { layerRead: read, baseDir: 'F:\\ws' }),
    (e: unknown) => (e as RoleLoaderError).code === 'INVALID_ROLE_CONFIG' && /workspace/.test((e as Error).message),
  );
});

test('listRoleNames: the workspace and user layers, deduped and sorted, built-ins excluded', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'pier-roles-ws-'));
  const user = await mkdtemp(join(tmpdir(), 'pier-roles-user-'));
  try {
    await mkdir(join(ws, '.pi-herdr', 'roles'), { recursive: true });
    for (const name of ['reviewer', 'auditor']) await writeFile(join(ws, '.pi-herdr', 'roles', `${name}.json`), '{}');
    await writeFile(join(ws, '.pi-herdr', 'roles', 'notes.txt'), 'ignored');
    await writeFile(join(user, 'auditor.json'), '{}');
    await writeFile(join(user, 'builder.json'), '{}');
    // `auditor` appears in both layers, so it is listed once.
    assert.deepEqual(listRoleNames(ws, user), ['auditor', 'builder', 'reviewer']);
    // Missing directories contribute nothing instead of throwing.
    assert.deepEqual(listRoleNames(join(ws, 'absent'), join(user, 'absent')), []);
  } finally {
    await rm(ws, { recursive: true, force: true });
    await rm(user, { recursive: true, force: true });
  }
});

test('directory helpers: workspace/user/bundled layer shapes', () => {
  const WS = process.platform === 'win32' ? 'F:\\ws' : '/ws';
  assert.equal(workspaceRolesDir(WS), join(WS, '.pi-herdr', 'roles'));
  assert.equal(workspaceRolesDir(), join(process.cwd(), '.pi-herdr', 'roles'));
  assert.match(userRolesDir().replace(/\\/g, '/'), /\/\.pi\/agent\/herdr-pi\/roles$/);
  const layers = roleLayers({ baseDir: WS });
  assert.equal(layers.length, 3);
  assert.match(layers[0]!.dir.replace(/\\/g, '/'), /\.pi-herdr\/roles$/);
  assert.match(layers[2]!.dir.replace(/\\/g, '/'), /src\/roles$/);
});

/* ── manifest-compose ──────────────────────────────────────────────── */

test('composeManifest: union of baseline and suggestion, deterministic order, deny wins', () => {
  const union = composeManifest({
    roleBaseline: ['bash', 'edit', 'write', 'todo_write'],
    modelSuggested: ['read', 'grep', 'bash'],
    rulePermissions: { '*': 'allow' },
  });
  assert.deepEqual(union.tools, ['bash', 'edit', 'grep', 'read', 'todo_write', 'write']);

  const denied = composeManifest({
    roleBaseline: ['bash', 'edit', 'read', 'todo_write'],
    modelSuggested: ['write', 'bash'],
    rulePermissions: { write: 'deny', edit: 'deny', '*': 'allow' },
  });
  assert.deepEqual(denied.tools, ['bash', 'read', 'todo_write']);
  assert.deepEqual(denied.permissions, { write: 'deny', edit: 'deny', bash: 'allow', read: 'allow', todo_write: 'allow' });

  // Three-state mix (websearch shape): deny excludes, ask marks, both stay visible in permissions.
  const mixed = composeManifest({
    roleBaseline: ['bash', 'read', 'grep', 'web_search', 'todo_write'],
    modelSuggested: ['bash', 'write'],
    rulePermissions: { bash: 'ask', write: 'deny', edit: 'deny', '*': 'allow' },
  });
  assert.deepEqual(mixed.tools, ['bash', 'grep', 'read', 'todo_write', 'web_search']);
  assert.equal(mixed.permissions.bash, 'ask');
  assert.equal(mixed.permissions.write, 'deny');
});

test('composeManifest: `*` supplies the default, explicit rules win, deny rules survive outside the tool set', () => {
  const explicit = composeManifest({
    roleBaseline: ['read', 'todo_write'],
    modelSuggested: [],
    rulePermissions: { '*': 'ask' },
  });
  assert.deepEqual(explicit.permissions, { read: 'ask', todo_write: 'ask' });

  const noStar = composeManifest({ roleBaseline: ['read', 'todo_write'], modelSuggested: [], rulePermissions: { write: 'deny' } });
  assert.deepEqual(noStar.permissions, { write: 'deny', read: 'allow', todo_write: 'allow' });

  const stance = composeManifest({
    roleBaseline: ['bash', 'read', 'todo_write'],
    modelSuggested: [],
    rulePermissions: { subagent: 'deny', terminal: 'deny', '*': 'allow' },
    unknownTools: 'allow',
  });
  assert.equal(stance.unknownTools, 'allow');
  assert.equal(stance.permissions.subagent, 'deny');
  assert.ok(!stance.tools.includes('subagent'));
});

test('composeManifest: empty result and empty baseline are loud, non-string tools are dropped', () => {
  assert.throws(
    () => composeManifest({ roleBaseline: ['bash'], modelSuggested: ['read'], rulePermissions: { bash: 'deny', read: 'deny', '*': 'deny' } }),
    (e: unknown) => e instanceof ManifestError && e.code === 'EMPTY_MANIFEST' && /bash/.test(e.message) && /read/.test(e.message),
  );
  assert.throws(
    () => composeManifest({ roleBaseline: [], modelSuggested: ['bash'], rulePermissions: { '*': 'allow' } }),
    (e: unknown) => e instanceof ManifestError && e.code === 'INVALID_ROLE_CONFIG' && /todo_write/.test(e.message),
  );

  const dirty = composeManifest({ roleBaseline: ['read', 'todo_write', 42 as never], modelSuggested: [], rulePermissions: {} });
  assert.deepEqual(dirty.tools, ['read', 'todo_write']);
  assert.deepEqual(dirty, composeManifest({ roleBaseline: ['read', 'todo_write', 42 as never], modelSuggested: [], rulePermissions: {} }));
});

test('toRuntimeManifest: one projection from a composed profile to the runtime shape', () => {
  const composed = composeForRole('master', [], { loadRoleOpts: { builtinDirect: true } });
  const runtime = toRuntimeManifest(composed);
  assert.equal(runtime.role, 'master');
  assert.equal(runtime.version, composed.role.version);
  assert.deepEqual(runtime.tools, composed.manifest.tools);
  assert.deepEqual(runtime.permissions, composed.manifest.permissions);
  assert.equal(runtime.unknownTools, composed.manifest.unknownTools);
  assert.deepEqual(runtime.services, composed.role.services ?? {});
  assert.equal(runtime.guidelines, undefined, 'master ships no guidelines');
});

/* ── tool-gate: runtime gate and visibility ────────────────────────── */

const WORKER: RuntimeRoleManifest = {
  role: 'worker-readonly',
  version: '1.1.0',
  tools: ['bash', 'read', 'grep', 'web_search', 'todo_write', 'ask_user_question'],
  permissions: { bash: 'ask', write: 'deny', '*': 'allow' },
};

const STANCE: RuntimeRoleManifest = {
  role: 'worker-default',
  version: '1.3.0',
  tools: ['bash', 'read', 'todo_write'],
  permissions: { subagent: 'deny', terminal: 'deny', '*': 'allow' },
  unknownTools: 'allow' as const,
};

test('planToolGate: no manifest stays open; allow/ask/deny follow the manifest and the stance', () => {
  assert.deepEqual(planToolGate('bash', null), { kind: 'open' });
  assert.equal(planToolGate('read', WORKER).kind, 'allow');
  assert.deepEqual(planToolGate('bash', WORKER), { kind: 'ask', notice: '[APPROVAL_NEEDED] worker-readonly.bash' });

  const unlisted = planToolGate('write', WORKER); // in permissions but pruned out of tools
  assert.equal(unlisted.kind, 'deny');
  if (unlisted.kind === 'deny') {
    assert.match(unlisted.reason, /worker-readonly/);
    assert.match(unlisted.reason, /write/);
  }
  assert.equal(planToolGate('subagent', WORKER).kind, 'deny');
});

test('planToolGate: unknown-tool stance decides visibility (D82), explicit deny still wins', () => {
  assert.equal(planToolGate('muse_deep_think', STANCE).kind, 'allow');
  assert.equal(planToolGate('subagent', STANCE).kind, 'deny');
  assert.equal(planToolGate('bash', STANCE).kind, 'allow');
  assert.equal(planToolGate('muse_deep_think', { ...WORKER, unknownTools: 'deny' }).kind, 'deny');

  const askUnknown: RuntimeRoleManifest = { ...STANCE, permissions: { ...STANCE.permissions, '*': 'ask' } };
  assert.deepEqual(planToolGate('muse_deep_think', askUnknown), {
    kind: 'ask',
    notice: '[APPROVAL_NEEDED] worker-default.muse_deep_think',
  });
});

test('planActiveTools: intersects with the manifest, never clears the set, reports no-op as unchanged', () => {
  // A plugin that registers four web tools but is granted only web_search loses the other three.
  const active = ['read', 'bash', 'web_search', 'source_check', 'fetch_content', 'get_search_content', 'todo_write'];
  const pruned = planActiveTools(['bash', 'read', 'grep', 'web_search', 'todo_write'], active);
  assert.deepEqual(pruned?.next, ['read', 'bash', 'web_search', 'todo_write']);
  assert.equal(pruned?.changed, true);

  const already = planActiveTools(['read', 'bash', 'todo_write', 'grep'], ['read', 'bash', 'todo_write']);
  assert.deepEqual(already, { next: ['read', 'bash', 'todo_write'], changed: false });

  assert.equal(planActiveTools(['web_search'], ['read', 'bash', 'edit']), null); // nothing would remain
  assert.equal(planActiveTools([], ['read', 'bash']), null);
  assert.equal(planActiveTools(['read'], []), null);
});

test('planActiveTools: allow stance hides only explicit denies, and still fails open when all are denied', () => {
  const active = ['read', 'bash', 'subagent', 'terminal', 'muse_deep_think', 'todo_write'];
  const plan = planActiveTools(STANCE.tools, active, { unknownTools: STANCE.unknownTools, permissions: STANCE.permissions });
  assert.deepEqual(plan?.next, ['read', 'bash', 'muse_deep_think', 'todo_write']);
  assert.equal(plan?.changed, true);

  const allKept = planActiveTools(['read', 'bash'], ['read', 'bash', 'muse_deep_think'], {
    unknownTools: 'allow',
    permissions: { '*': 'allow' },
  });
  assert.deepEqual(allKept, { next: ['read', 'bash', 'muse_deep_think'], changed: false });

  assert.equal(
    planActiveTools(['bash'], ['subagent', 'terminal'], { unknownTools: 'allow', permissions: { subagent: 'deny', terminal: 'deny' } }),
    null,
  );
});

test('parseRuntimeManifest: malformed env is null (fail-open), garbage stance degrades to deny', () => {
  for (const raw of [undefined, '', 'not-json', 'null', '[]', '{"tools":["bash"]}', '{"role":"w"}', '{"role":1,"tools":["bash"]}', '{"role":"w","tools":"bash"}']) {
    assert.equal(parseRuntimeManifest(raw), null, JSON.stringify(raw));
  }
  const ok = parseRuntimeManifest(JSON.stringify({ role: 'worker-readonly', tools: ['bash', 'read'], permissions: { '*': 'allow' }, unknownTools: 'allow' }));
  assert.equal(ok?.role, 'worker-readonly');
  assert.deepEqual(ok?.tools, ['bash', 'read']);
  assert.equal(ok?.unknownTools, 'allow');

  const garbage = parseRuntimeManifest(JSON.stringify({ role: 'w', tools: ['bash'], permissions: {}, unknownTools: 'maybe' }));
  assert.equal(garbage?.unknownTools, 'deny');
  assert.equal(planToolGate('muse_deep_think', garbage).kind, 'deny');
  assert.deepEqual(parseRuntimeManifest(JSON.stringify({ role: 'w', tools: [], guidelines: [' ok ', 7, ''] }))?.guidelines, [' ok ']);
});

/* ── role-state: replay, change-only writes, switch planning ───────── */

const WORKER_STATE_MANIFEST: RuntimeRoleManifest = {
  role: 'worker-default',
  version: '1.0.0',
  tools: ['read', 'bash', 'grep', 'todo_write', 'ask_user_question'],
  permissions: { '*': 'allow' },
  unknownTools: 'deny',
};

function roleEntry(data: unknown): unknown {
  return { type: 'custom', customType: 'pi-herdr.role-manifest', data };
}

test('replay: takes the last well-formed entry and skips junk without losing the rest', () => {
  const entries = [
    roleEntry({ version: 1, role: 'worker-default', tools: ['read'], permissions: {}, unknownTools: 'deny' }),
    { type: 'message', role: 'user' },
    { type: 'custom', customType: 'pi-herdr.todo-edit', data: { edits: [] } },
    roleEntry({ role: 42 }), // malformed: role is not a string
    roleEntry({
      version: 1,
      role: 'reviewer',
      tools: ['read', 'grep'],
      permissions: { write: 'deny' },
      unknownTools: 'allow',
      guidelines: ['bash 只用于运行测试'],
      origin: 'switch',
      switchedBy: 'p-master',
      ts: 123,
    }),
  ];
  const rec = latestRoleManifestRecord(entries);
  assert.equal(rec?.role, 'reviewer');
  assert.equal(rec?.origin, 'switch');
  assert.equal(rec?.switchedBy, 'p-master');
  assert.equal(rec?.ts, 123);
  assert.deepEqual(rec?.guidelines, ['bash 只用于运行测试']);
  assert.equal(latestRoleManifestRecord([entries[3], { type: 'custom', customType: 'x', data: null }]), null);
});

test('replay: malformed fields fall back to defaults and feed manifestFromRecord', () => {
  const rec = latestRoleManifestRecord([
    roleEntry({ role: 'r', tools: ['read'], permissions: 'not-an-object', guidelines: ['ok', 7, null], unknownTools: 'weird' }),
  ]);
  assert.ok(rec);
  assert.deepEqual(rec.guidelines, ['ok']);
  assert.deepEqual(rec.permissions, {});
  assert.equal(rec.unknownTools, 'deny');
  const manifest = manifestFromRecord(rec);
  assert.equal(manifest.role, 'r');
  assert.equal(manifest.version, undefined);
  assert.deepEqual(manifest.tools, ['read']);
  assert.deepEqual(manifest.guidelines, ['ok']);

  const empty = latestRoleManifestRecord([roleEntry({ role: 'r', tools: ['read'], guidelines: [] })]);
  assert.ok(empty);
  assert.equal(empty.guidelines, undefined);
  assert.equal(manifestFromRecord(empty).guidelines, undefined);
});

test('roleRecordDiffers: writes the anchor once, then only when role or tools changed', () => {
  const state = initialRoleState(WORKER_STATE_MANIFEST);
  const record = (over: Partial<Parameters<typeof roleRecordDiffers>[0]>) => ({
    version: 1 as const,
    role: 'worker-default',
    tools: [...WORKER_STATE_MANIFEST.tools],
    permissions: {},
    unknownTools: 'deny' as const,
    ...over,
  });
  assert.equal(roleRecordDiffers(null, state), true, 'first start must write the anchor');
  assert.equal(roleRecordDiffers(record({}), state), false, 'resume without a switch is a no-op');
  assert.equal(roleRecordDiffers(record({ role: 'reviewer', tools: ['read'] }), state), true);
  assert.equal(roleRecordDiffers(record({ tools: ['read'] }), state), true, 'a manifest evolution rewrites');
  assert.equal(roleRecordDiffers(record({}), initialRoleState(null)), false, 'unarmed sessions never write');
});

test('planRoleSwitch: widening is "the target adds a tool", diffs are both directions', () => {
  const widen = planRoleSwitch(['read', 'grep'], ['read', 'grep', 'bash']);
  assert.deepEqual(widen, { widening: true, added: ['bash'], removed: [] });
  const narrow = planRoleSwitch(['read', 'bash', 'edit'], ['read', 'bash']);
  assert.deepEqual(narrow, { widening: false, added: [], removed: ['edit'] });
});

test('planSwitchActiveTools: the universe is every registered tool, so a switch can re-admit tools', () => {
  // worker-default (no edit/write) pruned the active set; switching to a role that allows edit must
  // re-admit it, which intersection with the CURRENT active set could not do.
  const registered = ['read', 'bash', 'edit', 'write', 'grep', 'todo_write', 'ask_user_question', 'subagent'];
  assert.deepEqual(
    planSwitchActiveTools(['read', 'bash', 'edit', 'todo_write', 'ask_user_question'], registered),
    ['read', 'bash', 'edit', 'todo_write', 'ask_user_question'],
  );
  // Allow stance: keep every registered tool but the explicit denies.
  assert.deepEqual(
    planSwitchActiveTools(['read', 'bash'], ['read', 'bash', 'web_search', 'subagent', 'todo_write'], {
      unknownTools: 'allow',
      permissions: { subagent: 'deny' },
    }),
    ['read', 'bash', 'web_search', 'todo_write'],
  );
  // Unregistered manifest entries are ignored; an empty result is a legitimate shrink, not a no-op.
  assert.deepEqual(planSwitchActiveTools(['read', 'ghost_tool'], ['read', 'bash']), ['read']);
  assert.deepEqual(planSwitchActiveTools(['nope'], ['read', 'bash']), []);
});

test('initialRoleState: env origin with no switch trace; a bare pi session carries no manifest', () => {
  const state = initialRoleState(WORKER_STATE_MANIFEST);
  assert.equal(state.manifest?.role, 'worker-default');
  assert.equal(state.origin, 'env');
  assert.equal(state.switchedBy, null);
  assert.equal(state.switchedAt, null);
  assert.equal(initialRoleState(null).manifest, null);
});
