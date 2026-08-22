/**
 * 档1 dispose 账本（D80⑤ + D79）。
 *
 * 背景：hmr partial reload **不跑旧 fiber 的 effect-disposers**（spike A 实证）——
 * 模块持有的进程级资源（setInterval / pipe server / watcher）在热换后泄漏。
 * 补偿：core 模块把进程级资源登记进账本（key = 模块文件）；hmr/reload 事件
 * 按文件名触发 disposeKey，拆掉旧版本登记的资源；session_shutdown 走 disposeAll。
 *
 * D79 同构复用：未来 pi-surface proxy 的注册反清理（registerTool/on 的账本）
 * 与本账本同一机制（key 可用 'pi-surface' 等逻辑名，不必是文件）。
 *
 * 纯逻辑零依赖；接缝在 bootstrap（hmr 事件）与 index（session_shutdown）。
 */

import { fileURLToPath } from 'node:url';

/** 规范化 key：file:// URL 与普通路径统一为绝对路径（hmr filename 与 import.meta.url 可互比）。 */
export function normalizeModuleKey(spec: string): string {
  let s = String(spec);
  try {
    if (s.startsWith('file://')) s = fileURLToPath(s);
  } catch {
    /* 非法 URL 按原样使用 */
  }
  return s.replace(/\\/g, '/');
}

export class DisposeLedger {
  /** 登记序（LIFO 拆除与 cordis effect 语义一致）。 */
  private order: Array<{ key: string; dispose: () => void }> = [];

  /** 登记一个待拆资源；返回撤销函数（资源自拆后从账本移除，防二次拆）。 */
  add(spec: string, dispose: () => void): () => void {
    const entry = { key: normalizeModuleKey(spec), dispose };
    this.order.push(entry);
    return () => {
      const i = this.order.indexOf(entry);
      if (i >= 0) this.order.splice(i, 1);
    };
  }

  /** hmr 补偿（D80⑤）：只拆匹配 key 的登记项（LIFO），返回拆除数。 */
  disposeKey(spec: string | string[]): number {
    const keys = new Set((Array.isArray(spec) ? spec : [spec]).map(normalizeModuleKey));
    let n = 0;
    for (let i = this.order.length - 1; i >= 0; i--) {
      if (keys.has(this.order[i].key)) {
        const { dispose } = this.order[i];
        this.order.splice(i, 1);
        try { dispose(); } catch { /* 补偿拆除非致命 */ }
        n++;
      }
    }
    return n;
  }

  /** 全量 LIFO（session_shutdown 路径），返回拆除数。 */
  disposeAll(): number {
    let n = 0;
    while (this.order.length > 0) {
      const { dispose } = this.order.pop()!;
      try { dispose(); } catch { /* 同上 */ }
      n++;
    }
    return n;
  }

  get size(): number {
    return this.order.length;
  }
}
