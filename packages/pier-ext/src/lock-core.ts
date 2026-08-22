/**
 * M18 文件级写锁纯核心（S2 拍板：默认软 veto；PI_HERDR_WRITE_LOCK=1 硬启；2026-08-18）。
 *
 * 通道（D3 无新协议，schema 实测约束）：锁登记 = herdr `pane.report_metadata` tokens
 * ——键必须匹配 `^[A-Za-z0-9_-]{1,32}$`（路径进不了键！）→ **键 = `lock-<FNV-1a 64位哈希>`，
 * 值 = `<paneId>|<归一路径>`**（值无模式限制，路径放值里保可读性）；
 * 每次上报 ≤16 键（adapter 分批）。冲突检查 = `agent.list` 读全 pane tokens；
 * pane 关闭 → agent 条目消失 = 锁失效；settled → 显式置 null 释放。
 *
 * 语义：
 *  - 参与工具：write / edit（`{path}`；bash 文件目标提取不可靠，v1 声明为 seam）；
 *  - 同 pane 重入放行；异 pane 持有 → 软 warn（工具照跑，结果附警告）/ 硬 block；
 *  - 归一：resolve(cwd) + 反斜杠→斜杠 + 小写（Windows 大小写不敏感）+ 去尾斜杠；
 *  - 哈希碰撞（64 位，~10² 文件量级可忽略）：软模式多一次无害警告；硬模式极小概率误拦。
 */
import { resolve, sep } from 'node:path';

/** 硬启开关（env 名固定）。 */
export const WRITE_LOCK_ENV = 'PI_HERDR_WRITE_LOCK';
/** v1 参与写锁的工具（取 input.path）。 */
export const WRITE_TOOLS = ['write', 'edit'] as const;
/** 锁 token 键前缀（schema：^[A-Za-z0-9_-]{1,32}$）。 */
export const LOCK_TOKEN_PREFIX = 'lock-';
/** 单次 report_metadata 的 token 键上限（schema maxProperties=16）。 */
export const LOCK_BATCH_LIMIT = 16;
/** 锁 token TTL（pane 崩溃兜底；正常路径 settled 即释放）。 */
export const LOCK_TTL_MS = 60 * 60 * 1000;

/** agent.list 里与本模块相关的视图。 */
export interface LockAgentView {
  paneId: string;
  tokens: Record<string, string | null>;
}

/* ── 路径归一 ─────────────────────────────────────────────────────── */

export function normalizeLockPath(p: string, cwd: string): string {
  const abs = resolve(cwd, p);
  const unified = sep === '\\' ? abs.replace(/\\/g, '/') : abs;
  return unified.toLowerCase().replace(/\/+$/, '');
}

/* ── token 编解码（key = 哈希；value = paneId|path） ─────────────── */

/** FNV-1a 64 位 → 16 位 hex（BigInt 纯实现，无 node:crypto 依赖，可单测）。 */
export function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

export function lockTokenKey(normPath: string): string {
  return `${LOCK_TOKEN_PREFIX}${fnv1a64(normPath)}`;
}

export function lockTokenValue(normPath: string, paneId: string): string {
  return `${paneId}|${normPath}`;
}

export function parseLockTokenValue(v: string): { holderPaneId: string; path: string } | null {
  const i = v.indexOf('|');
  if (i <= 0 || i === v.length - 1) return null;
  return { holderPaneId: v.slice(0, i), path: v.slice(i + 1) };
}

/** token 键是否属于锁命名空间。 */
export function isLockTokenKey(key: string): boolean {
  return key.startsWith(LOCK_TOKEN_PREFIX) && key.length > LOCK_TOKEN_PREFIX.length;
}

/* ── 工具路径提取 ─────────────────────────────────────────────────── */

export function writePathsOfTool(toolName: string, input: unknown): string[] {
  if (!(WRITE_TOOLS as readonly string[]).includes(toolName)) return [];
  const p = (input as { path?: unknown } | null | undefined)?.path;
  return typeof p === 'string' && p.trim() ? [p] : [];
}

/* ── 冲突判定（value 解码持有人；同 pane 重入放行） ───────────────── */

export function findLockConflict(
  agents: readonly LockAgentView[],
  ownPaneId: string,
  normPath: string,
): { holderPaneId: string } | null {
  const key = lockTokenKey(normPath);
  for (const a of agents) {
    const v = a.tokens[key];
    if (typeof v !== 'string' || !v) continue;
    const parsed = parseLockTokenValue(v);
    if (parsed && parsed.holderPaneId !== ownPaneId) return { holderPaneId: parsed.holderPaneId };
  }
  return null;
}

/* ── 决策 ─────────────────────────────────────────────────────────── */

export type WriteGuardPlan =
  | { kind: 'skip' }
  | { kind: 'pass'; paths: string[] }
  | { kind: 'warn'; paths: string[]; holderPaneId: string; warning: string }
  | { kind: 'block'; paths: string[]; holderPaneId: string; reason: string };

export function planWriteGuard(opts: {
  toolName: string;
  input: unknown;
  agents: readonly LockAgentView[];
  ownPaneId: string;
  cwd: string;
  hard: boolean;
}): WriteGuardPlan {
  const raw = writePathsOfTool(opts.toolName, opts.input);
  if (raw.length === 0) return { kind: 'skip' };
  const paths = raw.map((p) => normalizeLockPath(p, opts.cwd));
  for (const norm of paths) {
    const conflict = findLockConflict(opts.agents, opts.ownPaneId, norm);
    if (!conflict) continue;
    if (opts.hard) {
      return {
        kind: 'block',
        paths,
        holderPaneId: conflict.holderPaneId,
        reason: `file locked by pane ${conflict.holderPaneId}: ${norm} is being edited in another pane. Wait for it to settle, or coordinate before writing.`,
      };
    }
    return {
      kind: 'warn',
      paths,
      holderPaneId: conflict.holderPaneId,
      warning: formatConflictWarning(norm, conflict.holderPaneId),
    };
  }
  return { kind: 'pass', paths };
}

/* ── token 构造（分批在 adapter） ─────────────────────────────────── */

export function acquireTokensFor(normPaths: readonly string[], paneId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of normPaths) out[lockTokenKey(p)] = lockTokenValue(p, paneId);
  return out;
}

export function releaseTokensFor(normPaths: readonly string[]): Record<string, null> {
  const out: Record<string, null> = {};
  for (const p of normPaths) out[lockTokenKey(p)] = null;
  return out;
}

export function formatConflictWarning(normPath: string, holderPaneId: string): string {
  return `⚠️ write conflict: ${normPath} is locked by pane ${holderPaneId} (it edited this file and has not settled). This write went through (soft mode) — coordinate to avoid clobbering each other's changes.`;
}
