/**
 * Subagent outbound port (composition root → plugin).
 *
 * Why: index used to pass a bag of independently-nullable callbacks that the
 * plugin mutated field-by-field. A missing bag crashed at mount
 * (`Cannot set properties of undefined (setting 'applyReplySession')`).
 * Binding one `current` object is atomic: all methods or none.
 */
export interface RunningSub {
  paneId: string;
  description: string;
}

export interface SubagentPort {
  applyReplySession(paneId: string, sessionFile: string | null): void;
  reconcileOnReply(paneId: string): string[];
  listRunningSubs(): RunningSub[];
  settleStatLine(paneId: string): Promise<string | null>;
}

export interface SubagentPortBox {
  current: SubagentPort | null;
}

export function emptySubagentPortBox(): SubagentPortBox {
  return { current: null };
}
