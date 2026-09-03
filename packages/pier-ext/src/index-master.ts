/**
 * Master-process plugin mount (cordis loader + terminal/todo/subagent).
 *
 * Why: worker must never load bootstrap/subagent-scope (C3). This module is
 * dynamically imported only from the master branch of index.ts.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Context } from '@deepseek-ai/cordis';
import type { Server } from 'node:net';
import { PiSurface } from './pi-surface.ts';
import { createCordisApp } from './bootstrap.ts';
import { disposeSessionRoot } from './subagent-scope.ts';
import terminalPlugin from './core/terminal.ts';
import todoPlugin from './core/todo.ts';
import subagentPlugin from './core/subagent.ts';
import type { HerdrClientLike, HerdrEnv } from './herdr-client.ts';
import type { TodosService } from './todos-service.ts';
import type { TodoUiSlot } from './core/todo.ts';
import type { SubagentPortBox } from './subagent-port.ts';

export interface MasterPluginMount {
  pi: ExtensionAPI;
  client: HerdrClientLike;
  env: HerdrEnv | null;
  todos: TodosService;
  todoUi: TodoUiSlot;
  mirrorTodos: () => void;
  extPath: string;
  port: SubagentPortBox;
  pipeServerBox: { current: Server | null };
  deliverNotice: (content: string, paneId?: string) => Promise<void>;
  noticePending: () => ReadonlySet<string>;
  getSessionId: () => string;
  getBlockedDepth: () => number;
  reconcileOnSettlement: (description: string, outcome: 'settled' | 'failed') => string[];
  withReconcileNotes: (base: string, notes: readonly string[]) => string;
  claimSettleNotice: (key: string) => boolean;
}

async function loadEntry(
  sessionRoot: Context,
  useLoader: boolean,
  name: string,
  plugin: (ctx: Context) => void,
): Promise<void> {
  if (useLoader) {
    const withLoader = sessionRoot as typeof sessionRoot & {
      loader?: { create: (o: { name: string }) => Promise<unknown> };
    };
    await withLoader.loader?.create({ name });
    return;
  }
  await sessionRoot.plugin(plugin);
}

export async function mountMasterPlugins(m: MasterPluginMount): Promise<void> {
  const cordisApp = await createCordisApp();
  const sessionRoot = cordisApp.root;
  // loader.create re-imports .ts via Node ESM — fails under node_modules (npm:pi-pier
  // strip-types) and misses pi's typebox alias. HMR-only; production uses plugin().
  const useLoader = cordisApp.loaderReady && cordisApp.hmrActive;

  // Pipe server is created in the common segment; closing it from a core
  // plugin would kill it on hmr reload (d87).
  sessionRoot.effect(() => () => {
    if (m.pipeServerBox.current) {
      try { m.pipeServerBox.current.close(); } catch { /* already closed */ }
      m.pipeServerBox.current = null;
    }
  }, 'pipe-server');

  const surface = new PiSurface(m.pi as unknown as object, cordisApp.ledger);
  sessionRoot.provide('pi-herdr.surface', surface);
  const terminalDeps = {
    client: m.client,
    env: m.env,
    state: { activePaneIds: (): Set<string> => new Set() },
  };
  sessionRoot.provide('pi-herdr.terminal-deps', terminalDeps);

  await loadEntry(sessionRoot, useLoader, './core/terminal.ts', terminalPlugin);

  sessionRoot.provide('pi-herdr.todo-deps', {
    todos: m.todos,
    allowParallelInProgress: m.todos.config.allowParallelInProgress,
    maxItems: 15,
    mirrorTodos: m.mirrorTodos,
    appendEntry: (customType: string, data: unknown) => {
      (m.pi as { appendEntry?: (t: string, d: unknown) => void }).appendEntry?.(customType, d);
    },
    state: m.todoUi,
    getBlockedDepth: m.getBlockedDepth,
    stopReminder: {
      getBlockedDepth: m.getBlockedDepth,
      getRunningSubs: () => m.port.current?.listRunningSubs().length ?? 0,
    },
  });
  await loadEntry(sessionRoot, useLoader, './core/todo.ts', todoPlugin);

  sessionRoot.provide('pi-herdr.subagent-deps', {
    client: m.client,
    env: m.env,
    extPath: m.extPath,
    sessionRoot,
    port: m.port,
    deliverNotice: m.deliverNotice,
    noticePending: m.noticePending,
    getSessionId: m.getSessionId,
    reconcileOnSettlement: m.reconcileOnSettlement,
    withReconcileNotes: m.withReconcileNotes,
    claimSettleNotice: m.claimSettleNotice,
    terminalState: terminalDeps.state,
  });
  await loadEntry(sessionRoot, useLoader, './core/subagent.ts', subagentPlugin);

  m.pi.on('session_shutdown', () => {
    void disposeSessionRoot(sessionRoot);
  });
}
