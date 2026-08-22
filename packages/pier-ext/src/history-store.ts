/**
 * workspace 历史记录（v1.2，DESIGN.md §13.4）。
 *
 * 任务历史 = append-only JSONL，按 cwd 分区（与 pi 会话分区同构）：
 *   <agentRoot>/herdr-pi/history/--<cwd>--/history.jsonl
 * 记录不可变：GC 只关 pane，绝不删历史。恢复双保险：sessionFile + launchCommand 快照。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sessionDirName } from './session-tail.ts';

/** 旧 short/resident → task；空/缺省 → task；role 名原样。 */
export function normalizeEntryKind(kind: string | null | undefined): string {
  if (!kind || kind === 'short' || kind === 'resident') return 'task';
  return kind;
}

/** 结算回写：只接受 .jsonl 路径，非法不覆盖（O6）。 */
export function applyReportedSessionFile(
  current: string | null,
  reported: string | null | undefined,
): string | null {
  if (typeof reported === 'string' && /\.jsonl$/i.test(reported)) return reported;
  return current;
}

export interface HistoryEntry {
  taskId: string;
  /** 'task' 或 role 名；读盘时 short/resident 归一为 task。 */
  kind: string;
  paneId: string;
  tabId: string;
  /** v1.3：任务 tab 名（历史回看/复活参考；旧条目缺省）。 */
  tabName?: string;
  workspaceId: string;
  cwd: string;
  description: string;
  /** 子代理会话文件（resume 首选）。 */
  sessionFile: string | null;
  /** 启动命令快照（sessionFile 丢失时重建空会话续接）。 */
  launchCommand: string[];
  status: 'running' | 'settled' | 'consumed' | 'closed';
  outcome?: string | null;
  createdAt: number;
  /** 消费时间（M13c 起随条目落盘；GC TTL 判据的 durable 记录）。 */
  consumedAt?: number | null;
  closedAt?: number | null;
  /** 打回重做/复活时的前代 paneId。 */
  revivedFrom?: string | null;
}

export function historyFilePath(agentRoot: string, cwd: string): string {
  return path.join(agentRoot, 'herdr-pi', 'history', sessionDirName(cwd), 'history.jsonl');
}

/** 容忍式逐行解析（损坏行跳过）。 */
export function parseHistoryEntries(text: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const line of (text ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object' && typeof obj.taskId === 'string') {
        const raw = obj as HistoryEntry;
        entries.push({ ...raw, kind: normalizeEntryKind(raw.kind) });
      }
    } catch {
      /* 跳过损坏行 */
    }
  }
  return entries;
}

function serializeEntry(entry: HistoryEntry): string {
  return JSON.stringify(entry);
}

/** 读取历史文件；不存在返回 []。 */
export function readHistory(file: string): HistoryEntry[] {
  try {
    return parseHistoryEntries(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/** 追加一条（确保目录存在）。 */
export function appendHistory(file: string, entry: HistoryEntry): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, serializeEntry(entry) + '\n');
  } catch {
    /* 尽力而为：历史写入失败不影响主流程 */
  }
}

/** 折叠：每个 taskId 的全部代际（按 createdAt 升序）。 */
export function generationsByTask(entries: readonly HistoryEntry[]): Map<string, HistoryEntry[]> {
  const map = new Map<string, HistoryEntry[]>();
  for (const e of entries) {
    const arr = map.get(e.taskId) ?? [];
    arr.push(e);
    map.set(e.taskId, arr);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.createdAt - b.createdAt);
  return map;
}

/** 取 taskId 的最新代（resume 用）。 */
export function latestGeneration(entries: readonly HistoryEntry[], taskId: string): HistoryEntry | null {
  const gens = generationsByTask(entries).get(taskId);
  if (!gens || gens.length === 0) return null;
  return gens[gens.length - 1];
}
