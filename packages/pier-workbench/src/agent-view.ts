/** Sidebar agent view registration for Herdr (protocol 22 `agent.view.set`): no agent-kind filter
 * (every harness stays visible) plus attention-first ordering. */

export type AgentViewBuiltinField =
  | 'status' | 'workspace_id' | 'tab_id' | 'pane_id' | 'agent' | 'seen' | 'state_change_seq';

export type AgentViewBuiltinSortField =
  | 'workspace_order' | 'tab_order' | 'pane_order' | 'attention'
  | 'status' | 'agent' | 'seen' | 'state_change_seq';

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
 * Builds validated parameters for agent.view.set. Default filter null — the call replaces Herdr's built-in
 * Agents projection UI-wide, so any harness a filter excludes silently disappears from the sidebar.
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
