/**
 * Notification payload builder for Herdr's notification.show API (protocol 22): `{ title, body?, position?,
 * sound? }` — the full type is NotificationShowParams below.
 */
/** Valid notification sounds (protocol 22 enum). */
const SOUNDS = { none: true, done: true, request: true };
/** Builds notification.show params from an agent status event, or null when malformed/gated out.
 * Tight gate: only pi agents in the blocked state are notified. */
export function buildNotificationParams(rawEvent, options) {
    if (!rawEvent || typeof rawEvent !== 'object')
        return null;
    const ev = rawEvent;
    if (ev.type !== 'pane.agent_status_changed')
        return null;
    const data = ev.data && typeof ev.data === 'object' ? ev.data : null;
    if (!data || data.agent !== 'pi' || data.agent_status !== 'blocked')
        return null;
    const paneId = typeof data.pane_id === 'string' && data.pane_id.trim()
        ? data.pane_id.trim()
        : (typeof data.pane_id === 'number' ? String(data.pane_id) : '?');
    const titleSuffix = typeof data.title === 'string' && data.title.trim()
        ? ` — ${data.title.trim()}`
        : '';
    const sound = options?.soundOverride ?? process.env.HERDR_NOTIFICATION_SOUND;
    return {
        title: 'Subagent blocked: pi',
        body: `Pane ${paneId} needs a human decision${titleSuffix}`,
        sound: sound && Object.hasOwn(SOUNDS, sound) ? sound : 'request',
    };
}
