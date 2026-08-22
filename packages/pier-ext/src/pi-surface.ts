/**
 * 档1 pi-surface（D79）：包住 pi ExtensionAPI 的注册面。
 *
 * 背景（源码实证 pi dist/core/extensions/loader.js）：
 *  - `registerTool(...): void`、`on(...): void` —— **pi 不提供反注册函数**；
 *  - `extension.tools.set(tool.name, …)` —— 工具表按名覆盖：同名重注册 = 覆盖
 *    （hmr 热换后新版本自然顶掉旧条目）；
 *  - 事件监听是列表 —— 重注册会**双触发**（热换泄漏面）。
 *
 * 补偿策略（tombstone，世代化）：每个 core 模块经 `forModule(key)` 拿到scoped 面，
 * 其 registerTool/on 都包 alive 旗标。**世代规则**（d87 修，源读 cordis-plugin-hmr）：
 * hmr partialReload 真实时序 = 重挂新插件**之后**才 emit('hmr/reload') → bootstrap
 * hook 才 disposeKey——若按「翻当前组」实现，翻掉的是新版本正引用的组（死到货）。
 * 故：挂载即自翻同 key 更旧世代（新插件体执行 = 旧版本确定已死）；账本 disposer
 * 只收割「登记世代及之前」，登记后新挂的豁免；disposeModule（显式）翻全部。
 *
 * 与 dispose 账本（D80⑤ 修正后定位）咬合：构造时传入 ledger，forModule
 * 自动登记 `disposeModule(key)`——hmr/reload 按文件名补偿即翻旗。
 */
import type { DisposeLedger } from './ledger.ts';

/** pi 的 ToolResult 最小形态（inert 返回用）。 */
const INERT_TOOL_RESULT = {
  content: [{ type: 'text' as const, text: 'Error: tool module disposed (hot-reloaded away); the new version has re-registered it.' }],
  details: {},
};

/** 模块级 scoped 面：registerTool/on 都带 alive 墓碑；registerCommand 走 Map 覆盖（pi 实测语义，无需墓碑）。 */
export interface ScopedSurface {
  registerTool(def: Record<string, unknown> & { name: string }): void;
  registerCommand(name: string, options: Record<string, unknown>): void;
  on(event: string, handler: (...args: unknown[]) => unknown): void;
}

interface Group {
  alive: boolean;
  /** 挂载世代号（单射递增；账本 disposer 按此判定收割范围）。 */
  epoch: number;
}

/** pi 注册面代理（D79）。raw 直通非注册方法（append/exec/setActiveTools…）。 */
export class PiSurface<P extends object> {
  private groups = new Map<string, Group>();
  /** 每 key 的世代列表（挂载即自翻更旧 → 活口至多 1 个，死口待账本回收）。 */
  private generations = new Map<string, Group[]>();
  private epochCounter = 0;
  /** 账本登记世代（disposer 只收割 epoch ≤ 此值；消费即删，下次挂载补登）。 */
  private ledgerEntryEpoch = new Map<string, number>();
  private readonly pi: P;
  private readonly ledger?: DisposeLedger;

  constructor(pi: P, ledger?: DisposeLedger) {
    this.pi = pi;
    this.ledger = ledger;
  }

  /** 原始 pi（不经包装的直通面；已迁移模块不应再用其注册）。 */
  get raw(): P {
    return this.pi;
  }

  /**
   * 拿一个模块的 scoped 注册面。**每次调用 = 新世代**：挂载即自翻同 key 旧世代
   * （新插件体执行意味着旧版本已死——hmr registry.delete 与手动重挂两态统一）。
   * 账本登记按 key 单例（消费后下次挂载补登）。
   */
  forModule(key: string): ScopedSurface {
    this.epochCounter += 1;
    const epoch = this.epochCounter;
    for (const g of this.generations.get(key) ?? []) g.alive = false;
    const group: Group = { alive: true, epoch };
    this.generations.set(key, [group]);
    this.groups.set(key, group);
    if (this.ledger && !this.ledgerEntryEpoch.has(key)) {
      this.ledgerEntryEpoch.set(key, epoch);
      this.ledger.add(key, () => {
        const bound = this.ledgerEntryEpoch.get(key) ?? epoch;
        this.ledgerEntryEpoch.delete(key);
        this.generations.set(
          key,
          (this.generations.get(key) ?? []).filter((g) => {
            if (g.epoch <= bound) {
              g.alive = false;
              return false;
            }
            return true;
          }),
        );
      });
    }
    return {
      registerTool: (def) => {
        const original = def.execute as ((...a: unknown[]) => unknown) | undefined;
        const wrapped = original
          ? async (...a: unknown[]) => {
            if (!group!.alive) return INERT_TOOL_RESULT;
            return original(...a);
          }
          : undefined;
        (this.pi as { registerTool?: (d: unknown) => void }).registerTool?.(
          wrapped ? { ...def, execute: wrapped } : def,
        );
      },
      registerCommand: (name, options) => {
        // pi 的 commands 是 Map<name>（dist 实测 .set）——同名重注册覆盖，热换安全；
        // handler 包墓碑仅为对称保险（覆盖语义下旧 handler 不会再被调）。
        const handler = options.handler as ((...a: unknown[]) => unknown) | undefined;
        const wrapped = handler
          ? (...a: unknown[]) => (group!.alive ? handler(...a) : undefined)
          : undefined;
        (this.pi as { registerCommand?: (n: string, o: Record<string, unknown>) => void })
          .registerCommand?.(name, wrapped ? { ...options, handler: wrapped } : options);
      },
      on: (event, handler) => {
        const wrapped = (...a: unknown[]) => (group!.alive ? handler(...a) : undefined);
        (this.pi as { on?: (e: string, h: (...a: unknown[]) => unknown) => void }).on?.(event, wrapped);
      },
    };
  }

  /** 翻墓碑（显式拆除，hmr 补偿不走这里）：翻该 key 全部世代；组不存在返回 false。 */
  disposeModule(key: string): boolean {
    const had = this.groups.has(key);
    for (const g of this.generations.get(key) ?? []) g.alive = false;
    this.generations.delete(key);
    this.groups.delete(key);
    this.ledgerEntryEpoch.delete(key);
    return had;
  }

  /** 组数（测试/诊断）。 */
  get moduleCount(): number {
    return this.groups.size;
  }
}
