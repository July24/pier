/**
 * Notification payload builder for Herdr's notification.show API (protocol 22): `{ title, body?, position?,
 * sound? }` — the full type is NotificationShowParams below.
 */

export interface NotificationShowParams {
  title: string;
  body?: string | null;
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | null;
  sound?: 'none' | 'done' | 'request';
}

export interface NotificationOptions {
  /** Overrides HERDR_NOTIFICATION_SOUND (invalid values fall back to 'request'). */
  soundOverride?: string;
}

/** Valid notification sounds (protocol 22 enum). */
const SOUNDS: Record<string, true> = { none: true, done: true, request: true };

/** Builds notification.show params from an agent status event, or null when malformed/gated out.
 * Tight gate: only pi agents in the blocked state are notified. */
export function buildNotificationParams(
  rawEvent: unknown,
  options?: NotificationOptions
): NotificationShowParams | null {
  if (!rawEvent || typeof rawEvent !== 'object') return null;
  const ev = rawEvent as Record<string, unknown>;
  if (ev.type !== 'pane.agent_status_changed') return null;
  const data = ev.data && typeof ev.data === 'object' ? ev.data as Record<string, unknown> : null;
  if (!data || data.agent !== 'pi' || data.agent_status !== 'blocked') return null;

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
    sound: sound && Object.hasOwn(SOUNDS, sound) ? (sound as NotificationShowParams['sound']) : 'request',
  };
}
