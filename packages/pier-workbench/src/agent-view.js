/** Sidebar agent view registration for Herdr (protocol 22 `agent.view.set`): no agent-kind filter
 * (every harness stays visible) plus attention-first ordering. */
/**
 * Builds validated parameters for agent.view.set. Default filter null — the call replaces Herdr's built-in
 * Agents projection UI-wide, so any harness a filter excludes silently disappears from the sidebar.
 */
export function buildAgentViewSetParams(options) {
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
