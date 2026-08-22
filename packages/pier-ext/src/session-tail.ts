/**
 * pi 会话 JSONL 尾部解析（纯函数库，v1.1 结果通道）。
 *
 * v1.1（DESIGN.md §12）起，子代理的结果不再从 pane 文本解析，而是读子代理的
 * 会话文件（pi 会话 JSONL，权威、机器精确、无回声污染/滚动盲区）。
 * 本模块只依赖 pi 会话格式（session-format 文档实测形状）：
 *   行 = {type, id, parentId, message:{role, content:[{type:'text',text}...], timestamp, stopReason}}
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SessionMessageLike {
  role?: string;
  content?: Array<{ type?: string; text?: string } | unknown> | unknown;
  timestamp?: number;
  stopReason?: string;
}

export interface SessionEntryLike {
  type?: string;
  message?: SessionMessageLike | unknown;
  [k: string]: unknown;
}

/** 容忍式逐行解析（损坏行/非 JSON 行跳过）。 */
export function parseSessionEntries(text: string): SessionEntryLike[] {
  const entries: SessionEntryLike[] = [];
  for (const line of (text ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object') entries.push(obj as SessionEntryLike);
    } catch {
      /* 截断/损坏行跳过 */
    }
  }
  return entries;
}

function messageOf(entry: SessionEntryLike): SessionMessageLike | null {
  if (entry.type !== 'message') return null;
  const m = entry.message;
  if (typeof m !== 'object' || m === null) return null;
  return m as SessionMessageLike;
}

function textOf(m: SessionMessageLike): string {
  const content = m.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (typeof c === 'object' && c !== null && (c as { type?: string }).type === 'text') {
        return (c as { text?: string }).text ?? '';
      }
      return '';
    })
    .join('\n')
    .trim();
}

/**
 * 取最后一次"已定稿"的 assistant 文本（stopReason === 'stop'，排除 toolUse 中间态）。
 * sinceTs 用于过滤注入时间点之前的旧消息。
 */
export function lastAssistantText(
  entries: readonly SessionEntryLike[],
  opts: { sinceTs?: number } = {},
): { text: string; timestamp: number } | null {
  let best: { text: string; timestamp: number } | null = null;
  for (const entry of entries) {
    const m = messageOf(entry);
    if (!m || m.role !== 'assistant') continue;
    if (m.stopReason !== 'stop') continue;
    const ts = typeof m.timestamp === 'number' ? m.timestamp : 0;
    if (opts.sinceTs !== undefined && ts < opts.sinceTs) continue;
    if (!best || ts >= best.timestamp) best = { text: textOf(m), timestamp: ts };
  }
  return best;
}

/** 会话是否出现注入时间点之后的 assistant 消息（任意 stopReason，探测活跃）。 */
export function hasAssistantAfter(
  entries: readonly SessionEntryLike[],
  sinceTs: number,
): boolean {
  return entries.some((e) => {
    const m = messageOf(e);
    return !!m && m.role === 'assistant' && (typeof m.timestamp === 'number' ? m.timestamp : 0) >= sinceTs;
  });
}

/**
 * 注入后是否存在"已发起但尚无结果"的 toolCall（工具执行中，如 ask_user_question
 * 等人类输入）→ 未真正结算（v1.3 M8 结算竞态修复）。并行调用按深度计数。
 */
export function hasPendingToolCall(entries: readonly SessionEntryLike[], sinceTs: number): boolean {
  let depth = 0;
  for (const entry of entries) {
    const m = messageOf(entry);
    if (!m) continue;
    const ts = typeof m.timestamp === 'number' ? m.timestamp : 0;
    if (ts < sinceTs) continue;
    if (m.role === 'assistant') {
      const content = m.content;
      if (Array.isArray(content)) {
        depth += content.filter((c) => typeof c === 'object' && c !== null && (c as { type?: string }).type === 'toolCall').length;
      }
    }
    if (m.role === 'toolResult') depth -= 1;
  }
  return depth > 0;
}

/** pi 会话目录名：cwd → `--F--herdr-pi--` 形态（实测命名约定）。 */
export function sessionDirName(cwd: string): string {
  const flat = cwd.replace(/[\\/]/g, '-').replace(/:/g, '-');
  return `--${flat}--`;
}

/** cwd 会话目录下按 mtime 倒序取最新 limit 个会话文件（v1.3 M7 候选定位）。 */
export function listSessionFiles(cwd: string, agentDir: string, limit = 4): string[] {
  const dir = path.join(agentDir, sessionDirName(cwd));
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files: Array<{ file: string; mtime: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(dir, name);
    try {
      files.push({ file: full, mtime: fs.statSync(full).mtimeMs });
    } catch {
      /* 跳过消失文件 */
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, limit).map((f) => f.file);
}

/**
 * 按 session id 定位会话文件（文件名形如 `<ts>_<id>.jsonl`，pi 实测命名）。
 * 官方 herdr 集成上报 agent_session 为 kind 'id' 时用它还原路径。
 */
export function sessionFileById(cwd: string, agentDir: string, id: string): string | null {
  const dir = path.join(agentDir, sessionDirName(cwd));
  const suffix = `_${id}.jsonl`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (name.endsWith(suffix)) return path.join(dir, name);
  }
  return null;
}

export function readSessionFile(file: string): SessionEntryLike[] | null {
  try {
    return parseSessionEntries(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
