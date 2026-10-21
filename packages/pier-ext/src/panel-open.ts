/** Shared Pier panel opening: `/dashboard` and `/pier-tree` both render through one popup entrypoint.
 *
 * Herdr popups are a singleton session resource (`popup.close` has no id) and are session-modal, so
 * the human cannot invoke another slash command while one is open. The command therefore chooses
 * the initial tab via env; tabs are switched inside the panel (`1`/`2`/`Tab`). A `ui_busy` result is
 * surfaced instead of silently retrying as a tab. */
import type { HerdrClientLike, HerdrEnv } from './herdr-client.ts';

export type PierPanel = 'dashboard' | 'tree';
export type PierPanelOpenResult = 'popup' | 'busy' | 'tab' | 'unavailable';

export interface PierPanelOpenDeps {
  client: HerdrClientLike;
  env: HerdrEnv | null;
}

/**
 * Open the shared popup on the requested tab. `busy` means another popup/modal owns the session;
 * the caller should tell the human to close it.
 */
export async function openPierPanel(
  deps: PierPanelOpenDeps,
  opts: { panel: PierPanel; treeFile?: string | null },
): Promise<PierPanelOpenResult> {
  const { client, env } = deps;
  if (!client.available || !env) return 'unavailable';

  try {
    const res = await client.openPluginPane({
      pluginId: 'pier.workbench',
      entrypoint: 'panel',
      placement: 'popup',
      width: '90%',
      height: '80%',
      focus: true,
      env: {
        PIER_PANEL: opts.panel,
        ...(opts.treeFile ? { PIER_TREE_FILE: opts.treeFile } : {}),
      },
    });
    if (res.mode === 'fallback_tab') return 'tab';
    if (res.mode === 'busy') return 'busy';
    return 'popup';
  } catch {
    return 'unavailable';
  }
}
