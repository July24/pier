/**
 * settled 唤醒决策纯核心（反唤醒风暴；session 01a03bf0 实证）。
 *
 * 实证链：ESC 中止 → agent_settled → D96「仍有后台 subagent」提醒
 * sendUserMessage(followUp)（空闲时必触发新 run）→ master 重启 → 用户再 ESC → …
 * 30 连 abort，ESC 永远打不断，Ctrl+C 杀进程才停。
 * 且自然 settle 也有自激励环：settle → 提醒 → 新 run → settle → 提醒……
 *
 * 规则：
 *  - abort 抑制：上次 assistant stopReason === 'aborted' → 本次 settled 不做任何
 *    唤醒型注入（用户显式叫停；结算缓冲保留待下次自然 turn 投递）；
 *  - D96 去重：同一组 running paneId 只提醒一次；集合变化（新 sub / 结算）重置；
 *  - D96 冷却：同集合重提醒至少间隔 REPEAT_NOTICE_MS（集合没变却再提醒 = 噪音）。
 */
export const ABORT_STOP_REASON = 'aborted';

/** D96：同一 running 集合的重提醒冷却。 */
export const D96_REPEAT_NOTICE_MS = 10 * 60_000;

export interface SettleWakeInput {
  /** 本次 settled 前最后一次 assistant turn 的 stopReason（未知 = null，视作自然结束）。 */
  lastStopReason: string | null;
  /** 仍在 running 的后台 subagent（空数组 = 无）。 */
  running: ReadonlyArray<{ paneId: string }>;
  /** 上次 D96 提醒时的集合键（无 = null）。 */
  lastNoticeKey: string | null;
  /** 上次 D96 提醒时间（epoch ms）。 */
  lastNoticeAt: number;
  now: number;
}

export interface SettleWakePlan {
  /** false = 本次 settled 静默：不投任何唤醒型消息。 */
  wake: boolean;
  /** 是否注入 D96「仍在运行」提醒。 */
  notice: boolean;
  /** 新的集合键（提醒时更新；running 空 → null）。 */
  noticeKey: string | null;
  noticeAt: number;
}

export function planSettleWake(input: SettleWakeInput): SettleWakePlan {
  if (input.lastStopReason === ABORT_STOP_REASON) {
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
