/**
 * 档1 收尾：workbench（herdr 侧）第二棵树 —— D78 树边界=进程边界 的另半区。
 *
 * 配方同 pi-herdr/bootstrap.ts（狗粮验收），但按 D81 三分法裁剪：
 * workbench 钩子脚本 = **one-shot 短命进程**（worker 原型）——裸 Context 根 +
 * 手动 mount，**无 loader/hmr/timer**（热换只属于长命的 master 进程）。
 *
 * 插件形态模块（src/reflow.ts 等）经服务注入拿依赖（`workbench.deps`），
 * 进程退出前 dispose——与 master 侧同一纪律。
 */
import { Context } from '@deepseek-ai/cordis';

export interface WorkbenchApp {
  /** 树根（one-shot：挂插件 → 跑完 → dispose → 退出）。 */
  root: Context;
}

export async function createWorkbenchApp(): Promise<WorkbenchApp> {
  const root = new Context();
  return { root };
}
