/**
 * Sidebar agent view registration for Herdr (protocol 22 `agent.view.set`): no agent-kind filter
 * (every harness stays visible) plus attention-first ordering.
 */

export type AgentViewBuiltinField =
  | 'status' | 'workspace_id' | 'tab_id' | 'pane_id' | 'agent' | 'seen' | 'state_change_seq';

export type AgentViewBuiltinSortField =
  | 'workspace_order' | 'tab_order' | 'pane_order' | 'attention'
  | 'status' | 'agent' | 'seen' | 'state_change_seq';

/** A custom field token, or one of herdr's builtins. */
export type AgentViewField = AgentViewBuiltinField | { token: string };
export type AgentViewSortField = AgentViewBuiltinSortField | { token: string };

export interface AgentViewSort {
  field: AgentViewSortField;
  order?: 'asc' | 'desc';
}

export type AgentViewFilter =
  | { op: 'all'; filters: AgentViewFilter[] }
  | { op: 'any'; filters: AgentViewFilter[] }
  | { op: 'not'; filter: AgentViewFilter }
  | { op: 'exists'; field: AgentViewField }
  | { op: 'eq'; field: AgentViewField; value: string | boolean | number }
  | { op: 'in'; field: AgentViewField; values: Array<string | boolean | number> };

export interface AgentViewSetParams {
  source: string;
  label?: string | null;
  filter?: AgentViewFilter | null;
  sort?: AgentViewSort[];
}

export interface BuildAgentViewOptions {
  source?: string;
  label?: string;
  filter?: AgentViewFilter | null;
}

/**
 * Builds validated parameters for agent.view.set.
 *
 * The default filter is null — no harness restriction. `agent.view.set` replaces Herdr's built-in
 * Agents projection for the whole UI, so any harness missing from a filter silently disappears from the
 * sidebar: a `pi`-only filter used to hide every omp pane (D105). Only the ordering is opinionated.
 */
export function buildAgentViewSetParams(options?: BuildAgentViewOptions): AgentViewSetParams {
  return {
    source: options?.source ?? 'pier.workbench',
    label: options?.label ?? 'Pier',
    filter: options?.filter !== undefined ? options.filter : null,
    sort: [
      { field: 'attention', order: 'desc' },
      { field: 'pane_order', order: 'asc' },
    ],
  };
}
