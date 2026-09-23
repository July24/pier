# 能效机制试用指南 —— OCC / ObservationPack / EPR + jev 决策层

> **面向对象**：第一次给 pier 开启能效机制的使用者。
> **本文只讲四件事**：怎么开、看什么、怎么判断划不划算、怎么反馈/关掉。
> 逐轮复审与设计讨论属本地开发文档（不入库）；本指南面向使用者。
> **状态**：三机制默认全关、逐项 fail-open，可按需逐项开启试用。

---

## 0. 30 秒摘要

| 机制 | 做什么 | 主要收益 | 何时值得开 |
|---|---|---|---|
| **ObservationPack (OBS)** | 大工具输出（默认 >10KB）发满 `fullSends` 轮后，在**投影层**替换为占位符 + `obs_recall` 分页取回（会话 JSONL 不变） | 不再每轮重放巨型输出 | 长测试/构建日志反复出现时 |
| **EPR (Evidence-Preserving Reducer)** | `bash` 诊断命令（test/build/lint 类）的长日志在进程内用轻量模型提炼成"收据"，**原文强制落盘可回读** | 一轮省掉整段日志重放 | 经常跑 `npm test`/`pytest`/`cargo test` 且日志很长 |
| **jev 决策层** | 可选的 TypeSafe "System One" 分类调用,给下面三机制补判断:EPR 诊断命令门(jev 优先、正则兜底)、结算通知按相关性排序、OBS 摘录选中段(中段窗恒在) | 清单外工具链不再漏提炼;关键失败不被折叠;少一次 recall | 愿意配一个 Typesafe API key 时 |

四者互相独立，可单独开；互斥规则（EPR 收据不再打包、`obs_recall` 输出不提炼等）已内置。

---

## 1. 开启方式

### 1.1 环境变量（最快，只影响当前进程）

```bash
# 先用 OBS 试水（推荐第一步）：打包 + 审计日志
PI_HERDR_OBS_PACK_ENABLE=1 PI_HERDR_OBS_PACK_LOG=1 pi

# 再叠加 EPR：需要指定一个便宜的提炼模型（不指定则继承当前会话模型，通常不划算）
PI_HERDR_OBS_PACK_ENABLE=1 PI_HERDR_OBS_PACK_LOG=1 \
PI_HERDR_REDUCER_ENABLE=1 PI_HERDR_REDUCER_LOG=1 PI_HERDR_REDUCER_MODEL=cliproxy/gemini-3.8-flash-high \
pi

# 最后叠加 OCC：需要显式给压缩成本比率（auto 会尝试从 ctx.model.cost 推导）
PI_HERDR_COMPACT_ENABLE=1 PI_HERDR_COMPACT_LOG=1 PI_HERDR_CACHE_RATIO=auto pi
```

| 环境变量 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `PI_HERDR_OBS_PACK_ENABLE` | `0`/`1` | `0` | OBS 占位替换总开关 |
| `PI_HERDR_OBS_PACK_LOG` | `0`/`1` | `0` | 写 `observation.jsonl` |
| `PI_HERDR_REDUCER_ENABLE` | `0`/`1` | `0` | EPR 提炼总开关 |
| `PI_HERDR_REDUCER_LOG` | `0`/`1` | `0` | 写 `reducer.jsonl` |
| `PI_HERDR_REDUCER_MODEL` | `provider/model` | 继承当前模型 | 专用轻量提炼模型 |
| `PI_HERDR_COMPACT_ENABLE` | `0`/`1` | `0` | OCC 压缩总开关（会覆盖 pi 的 `compaction.enabled=false`） |
| `PI_HERDR_COMPACT_LOG` | `0`/`1` | `0` | 写 `compact.jsonl` |
| `PIER_JEV_ENABLE` | `0`/`1` | `0` | jev 决策层总开关(还需 key,见 §8) |
| `PIER_JEV_LOG` | `0`/`1` | `0` | 写 `jev.jsonl`(不含任何请求/响应明文) |
| `PIER_JEV_API_KEY` | 字符串 | – | API key;优先级 `PIER_JEV_API_KEY` > 配置文件 `jev.apiKey` > `TYPESAFE_API_KEY` |

> 环境变量优先级最高，便于临时试用与 A/B。想彻底关掉就删掉变量或置 `0`。

### 1.2 配置文件（持久生效）

- 用户级：`~/.pi/agent/herdr-pi/config.json`
- 工作区级：`<repo>/.pi-herdr/config.json` —— **仅当该项目被 pi 标记为受信时才生效**（未受信时整份忽略并在 stderr 告警一次）

```json
{
  "version": 1,
  "onlineContextCompact": {
    "enabled": false,
    "logEnabled": false,
    "cacheWriteReadRatio": "auto",
    "firstCompactionRequestScale": 2.0,
    "subsequentCompactionMargin": 1.5,
    "keepRecentTokens": 20000
  },
  "observationPack": {
    "enabled": true,
    "logEnabled": true,
    "thresholdBytes": 10240,
    "fullSends": 2,
    "recallChunkBytes": 16384,
    "excerptBytes": 1024
  },
  "evidencePreservingReducer": {
    "enabled": false,
    "logEnabled": false,
    "model": "cliproxy/gemini-3.8-flash-high",
    "minBytes": 4096,
    "maxChars": 600000,
    "maxOutputTokens": 2048,
    "timeoutMs": 5000,
    "localOnly": false
  },
  "jev": {
    "enabled": true,
    "logEnabled": true,
    "apiKey": "sk-...(console.typesafe.ai/settings/keys 申请)",
    "model": "jev-1.13.0",
    "timeoutMs": 2000,
    "minConfidence": 0.6
  }
}
```

语义要点（试用期最容易踩的三条）：

1. **优先级**：环境变量 > 工作区配置 > 用户配置 > 内置默认（全 `false`）。
2. **工作区配置是整体覆盖**，不与用户配置深合并（"工作区只写一行 `enabled:false` 就能关掉"是可预期的）。
3. **未知键 / 类型非法 → 该机制强制 `enabled:false`**（一次收集全部问题，打印单行 stderr 警告，不会中断会话）。所以"写了配置但没生效"时请先看 stderr 的 `[pi-herdr] efficiency config warning`。
4. `onlineContextCompact.keepRecentTokens` 缺省会**继承 pi 的 `compaction.keepRecentTokens`**；若 pi 里设了 `compaction.enabled=false`，OCC 会同步禁用（除非 `PI_HERDR_COMPACT_ENABLE=1` 强制）。

---

## 2. 建议的试用顺序（一次只加一个）

| 步骤 | 开什么 | 先确认 |
|---|---|---|
| 1 | OBS（`OBS_PACK_ENABLE=1` + `OBS_PACK_LOG=1`） | 折叠后模型还能正常干活；`obs_recall` 能取回原文 |
| 2 | + EPR（配 `REDUCER_MODEL`） | 收据能定位失败原因；回退（fallback）不频繁 |
| 3 | + OCC（`COMPACT_ENABLE=1`） | 压缩时机合理、压缩后能自动续跑、未完成 todo 被保留 |

每一步至少跑一次真实的长任务（测试/构建/多步重构）再决定是否叠加下一步。

---

## 3. 看什么（观测入口）

```bash
/pier-config                 # 4 平面索引（含 OCC/OBS/EPR 的一行状态）
/pier-config show efficiency # 三个机制全部键的 生效值 / 来源 / 影响
/pier-config check           # 校验（env 越界、JSON 损坏等）
```

日志与对象都在 pi 会话目录下（`ctx.sessionManager.getSessionDir()`，通常形如
`~/.pi/agent/sessions/<项目编码>/<会话 id>/`）：

```text
<sessionDir>/herdr-pi/<sessionId>/
├── observation-pack/objects/obs_<hash24>.txt          # OBS 归档的原始大输出（0600）
├── evidence-preserving-reducer/objects/<sha256>.txt   # EPR 归档的原始日志（0600，收据里给出该路径）
└── efficiency-logs/
    ├── observation.jsonl    # packed / packed-batch / recall
    ├── reducer.jsonl        # applied / fallback（含 reason）/ 耗时
    └── compact.jsonl        # decision（含原因枚举）/ 压缩完成摘要
```

- 每个 `.jsonl` 超过 5MB 会自动轮转为 `.old`；`objects/` 超过 300 文件或 50MB 会自动剪掉最旧的。
- 常见字段：`schema`/`mechanism`/`ts`/`sessionId`；OBS 的 `obsId`/`originalBytes`/`grossSavedTokens`/`sendCount`/`source`；EPR 的 `commandSha256`（**不记命令明文**）/`sourceBytes`/`verificationOk`/`reason`/`action`/`durationMs`；OCC 的 `decision`/`breakevenRequests`/`expectedRemainingRequests`/`epoch`。
- OCC 的 `decision` 枚举含义：`economic`（经济学触发）、`window_protection`（窗口保护触发）、`deferred_*`（本轮不压，附原因）、`native_not_compactable`（pi 原生切不出历史消息，放弃 abort）、`non_positive_saving`/`horizon_unavailable`/`cache_ratio_unavailable`（样本或参数不足）。

---

## 4. 粗判"是否划算"

| 机制 | 三个数字 | 判定 |
|---|---|---|
| OBS | `grossSavedTokens` 累计 vs `recall` 次数 | 命中多、召回少 = 省；若模型频繁 recall 同一 id，说明 `excerptBytes`/`thresholdBytes` 需要调 |
| EPR | `action:"applied"` 占比、`compressionRatio`、`reason` 分布 | applied 多且 `truncated-source`/`likely-secret`/`hash-failure` 少 = 稳；若多为 `hash-failure`，考虑换更听话的 reducer 模型 |
| OCC | `breakevenRequests` vs `expectedRemainingRequests`、压缩后是否续跑 | breakeven 明显小于预期剩余请求 = 值得；频繁 `deferred_economic` = 样本还不足（多跑几个 todo 边界会自动校准） |

> 注意：OBS 的 `grossSavedTokens` 是**毛收益**（未扣打包造成的缓存重写代价）；真正的判定请结合是否"压缩点/里程碑边界"发生。

---

## 5. 安全边界与回滚

- **默认全关**：不开启时三机制完全不介入（不写对象、不写日志、不动投影）。
- **EPR 会把日志发给模型**：`localOnly: true` 时只归档不提炼；命中 `api_key|authorization|bearer|access_token|secret` 特征的行会直接放弃提炼、原样输出全文（遥测只记 `reason:"likely-secret"`）。
- **未受信项目的工作区配置整份忽略**；EPR 另外还会在运行时校验 `ctx.isProjectTrusted()`。
- **回滚**：删掉环境变量 / 把配置里的 `enabled` 置 `false` 即可即时恢复；已产生的日志与对象只影响磁盘占用（会被自动剪枝），不会影响会话正确性。
- **jev 关闭时的护栏**(2026-09-19 翻转,门序重排后):EPR 的执行序为 廉价前置(截断或
  预览 ≥ minBytes)→ 诊断门(纯代码正则)→ 全文解析/密钥扫描。jev 关闭时诊断门退化为
  正则判定,候选集合、证据行(`truncated-source`/`likely-secret`)分布、输出解析次数
  与翻转前**完全一致**——无护栏例外。

---

## 6. 反馈模板（贴这几样就能定位问题）

1. `/pier-config show all` 的完整输出（或 `/pier-config doc` 生成的报告文件）。
2. 对应 `efficiency-logs/*.jsonl` 的相关片段（**日志本身已脱敏**，只有 sha256 与字节数，可放心贴）。
3. 当时的模型 id 与 `PI_HERDR_CACHE_RATIO`（若是 `auto`，附 `ctx.model.cost` 的 `cacheRead`/`cacheWrite`）。
4. 观感一句话：占位符是否影响可读性 / 收据是否够定位失败 / 压缩后续跑是否顺畅。
5. 期望 vs 实际（例："`pip install` 的日志被折叠成占位符后，我看不到最后一行报错"、"压缩后模型忘了第 3 个未完成 todo"）。

> 反馈请附上**复现所用命令与机制开关**；如果是"某类日志不该被折叠/提炼"，附一段脱敏后的样例输出即可。

---

## 7. 当前已知限制（试用期请知悉）

- OBS 的 horizon（剩余请求估计）来自 OCC 的 todo 边界样本；**样本不足时保守回退为 4**（此时更倾向少打包）。
- 打包决策是"**首次按经济学判定 + 之后粘性保持**"，不会每轮重新评估。
- 批量打包（压缩点顺路打包）上限 **20 条 / 10MB**；占位符 memo 上限 256 条（LRU 近似）。
- pi 的 `compaction.*` 只在启动时读取一次；改了 pi 设置需要重启会话。
- `keepRecentTokens` 若在效率配置中显式给出，则以效率配置为准（不继承 pi）。
- OCC 在 todo 边界 abort 在途回合后，transcript 里会落一条 `stopReason:"error"` 的空 assistant（UI 显示红色 `Error: This operation was aborted`，该文案出自 pi 的 `raceWithAbortSignal`）——这是**预期**的中断痕迹，压缩完成后由 continuation 消息自动续跑；同一时刻会话里会写入 `pi-herdr.compaction-inflight` / `pi-herdr.compaction-settled` 两个 custom 标记，master 的 subagent 结算监督靠它们区分"压缩中"与"真完工"（01a0be1f：worker 压缩 52s > 30s 观察窗，曾被假结算并提前唤醒 master）。标记机制要求 **master 与 worker 两端进程都加载新代码**（扩展随进程启动加载，无 HMR）；任何一端仍是旧进程就退化回旧行为，且对已在跑的会话不回溯生效。
- 纯核的变异测试证据：`compact-economics-core.ts` 为全量测试集 77.46%；其余 3 个核心为“单元 + 集成 spec 子集”下的**下界**（`observation-core` 66.82% / `efficiency-config-core` 59.80% / `reducer-core` 52.52%，后者经一轮补测从 48.52% 提升）。完整清单见 RFC §9 与 ADR `Known residuals`。
- EPR 的命令识别（`DIAGNOSTIC_COMMAND`）两侧边界都接受 shell 分隔符：`(npm test)`、`npm test&&echo ok`、`pytest;` 可识别；`makefile`、`coqtop`、`npm run test` 不会误判。

---

## 8. jev 决策层(P0-1/2/3,2026-09-18)

设计全文见 `docs/rfc-jev-integration.md`。与上面三机制同住一个配置平面,
但性质不同:它**不做任何 I/O 语义**,只给三处判断供给模型裁决(2026-09-19 起
P0-1/P0-3 为 **jev 优先、纯代码兜底**;P0-2 本就 jev 优先),
且**逐点 fail-open**——关掉、没 key、超时、429、低置信度,行为都与从前逐字节一致。

| 接入点 | **前置(不开则零调用)** | 触发条件 | jev 问什么 | 回退 |
|---|---|---|---|---|
| EPR 诊断命令门 | **EPR 开启**(`evidencePreservingReducer.enabled`) | 输出达提炼前置门(截断或预览 ≥ minBytes,默认 4KB)的候选 bash 命令(**每个候选都问**;小输出零调用;正则清单降级为兜底) | 命令类型 Choice + 是否诊断输出 Noul,1.5s 预算 | jev 不可用/失败/低置信 → 回退正则清单判定;确信拒绝则不提炼(权威) |
| 结算通知排序 | 无(独立于三机制,只需 jev 可用) | 折叠批量 **>3 条**时(≤3 不调)——需并行子代理结算攒批 | 每条一个相关性 Score + 失败 Noul,一次调用;阈值 0.7(CJK 折扣) | 到达序前 3(现行为) |
| OBS 摘录选窗 | **OBS 开启**(`observationPack.enabled`) | 大输出已打包(**中段候选窗恒在**,不再要求失败信号行——CJK 日志同样覆盖) | 头/尾/首信号窗/最密窗/中段窗 哪个最有信息量 Choice | 头尾对半劈半(现行为) |

> **后台 usage=0?先对这张表。** jev 层自己不产生调用——调用仍由宿主机制与触发条件门住(2026-09-19 翻转后,jev 在 EPR 门/摘录选窗是**优先判断**,失败/不可用才回退纯代码逻辑)。
> 只开 `jev.enabled` 而 EPR/OBS 都关着时,唯一可能触发的是结算排序,而它要求一次
> flush 攒下 **>3 条**结算;普通单代理会话一条都不会发,后台 usage=0 属**预期**而非故障。
> 本地以 `jev.jsonl` 为准(开 `logEnabled`),比后台面板更即时。

**开始试用**:把上面配置示例的 `jev` 段写进 `~/.pi/agent/herdr-pi/config.json`
(用户级)或 `<repo>/.pi-herdr/config.json`(受信工作区,整体覆盖不深合并),
填上 `apiKey`,**并开启想要点亮的宿主机制(EPR / OBS)**,重开 pi 会话即可;
`PIER_JEV_ENABLE=1` 可临时开。最快点亮路径:同时开 EPR,跑任一条输出 ≥4KB 的
bash 命令(2026-09-19 翻转后正则清单内外都会先问 jev),第一次工具结果即产生一条
`epr-diagnostic-gate` 调用。

**看什么**:`/pier-config show efficiency` 会列出 `jev.*` 全部键的生效值与来源;
日志在 `<sessionDir>/herdr-pi/<sessionId>/efficiency-logs/jev.jsonl`
(`questionId`/`latencyMs`/`usage`/`verdict`/`fallback` 原因;`stateHash`/`stateBytes`
代替明文——排查时对不上内容属预期)。

**隐私边界**(2026-09-19 翻转后实情):发给 TypeSafe 的 state 只有——
候选命令的**命令行字符串**(P0-1。翻转前外发的恰是**清单外**命令——正则命中即短路
从不外发;且旧门在尺寸检查之前,`ls` 这类小输出也会发。翻转后改为**清单内外都发**,
但仅限越过提炼前置门的候选,小输出零外发)、结算摘要 + master 当前 in_progress todo
文本(P0-2,D1 决策:直接发送,不设开关)、被打包输出的头/中/尾**摘录窗文本**(P0-3,
翻转前仅含英文失败信号行的输出才外发,现在所有被打包输出都发)。**P0-1/P0-3 出网前
各跑一次本地 `LIKELY_SECRET` 门,凭据形字符串不出现在这两条路径的任何请求里**;
P0-2 按上述 D1 决策无此门。官方声明不用客户数据训练(企业版 ZDR,见 Legal)。
