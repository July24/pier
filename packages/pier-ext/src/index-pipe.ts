/**
 * Common-segment pipe request handler (prompt / interrupt / reply).
 *
 * Why: index.ts owned the NDJSON switch next to session lifecycle. The
 * dispatch is a pure-ish adapter over the subagent port and notice buffer.
 */
import { formatSettlementNotice } from './vocab.ts';
import type { PipeRequest, PipeResponse } from './pipe-channel.ts';
import type { SubagentPortBox } from './subagent-port.ts';

export interface MachineRequest {
  id: string;
  from: string | null;
  push: boolean;
  sinceTs: number;
}

export interface PipeHandlerSession {
  paneId: string;
  port: SubagentPortBox;
  claimSettleNotice: (key: string) => boolean;
  deliverNotice: (content: string, paneId?: string) => Promise<void>;
  sendUserMessageIn: (content: string) => Promise<void>;
  sendUserMessageAs: (content: string, mode: 'steer' | 'followUp') => Promise<void>;
  abort: () => void;
  setPendingMachineRequest: (req: MachineRequest | null) => void;
}

export async function handlePipeRequest(
  req: PipeRequest,
  s: PipeHandlerSession,
): Promise<PipeResponse> {
  switch (req.type) {
    case 'ping':
      return { type: 'ok', id: req.id, detail: s.paneId };
    case 'prompt':
    case 'follow_up': {
      s.setPendingMachineRequest({
        id: req.id,
        from: req.from ?? null,
        push: req.push === true,
        sinceTs: Date.now(),
      });
      // follow_up + steer → deliver between tool calls (B3). Initial prompt
      // stays followUp so an idle worker starts a new run (D96).
      if (req.steer === true) await s.sendUserMessageAs(req.text, 'steer');
      else await s.sendUserMessageIn(req.text);
      return { type: 'ok', id: req.id };
    }
    case 'interrupt':
      s.abort();
      s.setPendingMachineRequest(null);
      return { type: 'ok', id: req.id };
    case 'reply': {
      s.port.current?.applyReplySession(req.paneId, req.sessionFile);
      if (s.claimSettleNotice(`${req.paneId}:${req.id}`)) {
        const notes = s.port.current?.reconcileOnReply(req.paneId) ?? [];
        const statLine = await s.port.current?.settleStatLine(req.paneId) ?? null;
        const head = formatSettlementNotice(`${req.paneId}`, req.text);
        const body = (req.sessionFile ? `${head}\nSession: ${req.sessionFile}` : head)
          + (statLine ? `\n${statLine}` : '')
          + (notes.length ? `\n${notes.join('\n')}` : '');
        await s.deliverNotice(body, req.paneId);
      }
      return { type: 'ok', id: req.id };
    }
    default: {
      // PipeRequest is closed; parsePipeLine may still forward an unknown type.
      const unknownReq: { type: string; id: string } = req;
      return { type: 'error', id: unknownReq.id, message: `unknown type ${unknownReq.type}` };
    }
  }
}
