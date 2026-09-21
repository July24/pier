/**
 * Pure core for the settled-wake decision (prevents wake storms).
 *
 * A settle wake that injects messages creates a self-triggering loop (settle → notice → new run →
 * settle → …) that even ESC cannot break, so: an aborted previous turn injects nothing; a running
 * set is announced once and only re-announced after REPEAT_NOTICE_MS or when the set changes.
 */

export const ABORT_STOP_REASON = 'aborted';

/** D96: cooldown before repeating a notice for the same running set. */
export const D96_REPEAT_NOTICE_MS = 10 * 60_000;

export interface SettleWakeInput {
  /** stopReason of the last assistant turn before this settlement (unknown = null, treated as natural completion). */
  lastStopReason: string | null;
  /** True when abort was triggered intentionally by internal mechanisms like OCC. */
  intentionalAbort?: boolean;
  /** Background subagents still running (empty means none). */
  running: ReadonlyArray<{ paneId: string }>;
  /** Set key recorded for the previous D96 notice (none = null). */
  lastNoticeKey: string | null;
  /** Timestamp of the previous D96 notice (epoch ms). */
  lastNoticeAt: number;
  now: number;
}

export interface SettleWakePlan {
  /** false means this settlement stays silent and emits no wake-up message. */
  wake: boolean;
  /** Whether to inject the D96 "still running" notice. */
  notice: boolean;
  /** New set key (updated when notifying; empty running set → null). */
  noticeKey: string | null;
  noticeAt: number;
}

export function planSettleWake(input: SettleWakeInput): SettleWakePlan {
  if (input.intentionalAbort || input.lastStopReason === ABORT_STOP_REASON) {
    return { wake: false, notice: false, noticeKey: input.lastNoticeKey, noticeAt: input.lastNoticeAt };
  }
  const key = input.running.length === 0 ? null : input.running.map((s) => s.paneId).sort().join(',');
  if (key === null) {
    return { wake: true, notice: false, noticeKey: null, noticeAt: input.lastNoticeAt };
  }
  const newSet = key !== input.lastNoticeKey;
  const cooled = input.now - input.lastNoticeAt >= D96_REPEAT_NOTICE_MS;
  const notice = newSet || cooled;
  return { wake: true, notice, noticeKey: key, noticeAt: notice ? input.now : input.lastNoticeAt };
}
