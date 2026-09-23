/**
 * Settled-wake decision (prevents wake storms): a settle wake that injects messages creates a
 * self-triggering loop (settle → notice → new run → settle → …) that even ESC cannot break, so an
 * aborted previous turn injects nothing and a running set is announced once, re-announced only after
 * D96_REPEAT_NOTICE_MS or when the set changes.
 */

export const ABORT_STOP_REASON = 'aborted';

/** D96: cooldown before repeating a notice for the same running set. */
export const D96_REPEAT_NOTICE_MS = 10 * 60_000;

export interface SettleWakeInput {
  /** stopReason of the last assistant turn (null = treated as natural completion). */
  lastStopReason: string | null;
  /** True when abort was triggered intentionally by internal mechanisms like OCC. */
  intentionalAbort?: boolean;
  running: ReadonlyArray<{ paneId: string }>;
  lastNoticeKey: string | null;
  lastNoticeAt: number;
  now: number;
}

export interface SettleWakePlan {
  /** false means this settlement stays silent and emits no wake-up message. */
  wake: boolean;
  /**
   * Hand the settlement to the compaction coordinator. An OCC abort is silent (no wake) yet is the
   * very settlement the selected compaction waits for; only a foreign (ESC) abort skips it.
   */
  compact: boolean;
  notice: boolean;
  /** New set key; empty running set → null. */
  noticeKey: string | null;
  noticeAt: number;
}

export function planSettleWake(input: SettleWakeInput): SettleWakePlan {
  if (input.intentionalAbort || input.lastStopReason === ABORT_STOP_REASON) {
    return {
      wake: false,
      compact: input.intentionalAbort === true,
      notice: false,
      noticeKey: input.lastNoticeKey,
      noticeAt: input.lastNoticeAt,
    };
  }
  const key = input.running.length === 0 ? null : input.running.map((s) => s.paneId).sort().join(',');
  if (key === null) {
    return { wake: true, compact: true, notice: false, noticeKey: null, noticeAt: input.lastNoticeAt };
  }
  const newSet = key !== input.lastNoticeKey;
  const cooled = input.now - input.lastNoticeAt >= D96_REPEAT_NOTICE_MS;
  const notice = newSet || cooled;
  return { wake: true, compact: true, notice, noticeKey: key, noticeAt: notice ? input.now : input.lastNoticeAt };
}
