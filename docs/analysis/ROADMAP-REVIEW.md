# ContextPrism 深度评估：可优化点与 §13 后续方向合理性

> 评估对象：v0.7.0 → 本次 v0.8.0（DSH 0.2.1-rc.5 兼容）
> 评估方法：graphify 知识图谱 + 逐 API 核对 DSH 0.2.1-rc.5 运行时 + 在真实 Cordis 环境加载插件
> 结论先行见 §1；每条论断都标注了证据来源，**没有证据支撑的判断不写进结论**。

---

## 1. 结论摘要

| 判断 | 结论 |
| --- | --- |
| 项目定位 | ✅ **合理且稀缺**：DSH 生态里真正做"每步动态上下文窗口"的插件很少，且它是唯一自带 A/B 评测与可观测面板的 |
| 工程成熟度 | ⚠️ **v0.7.0 实际不可用**：默认配置下自动注入**从未生效**（见 §2.1），文档描述的 6 个工具里只有"能注册"是成立的 |
| §13 路线方向 | ⚠️ **方向对，但排序错**：4 条里 2 条（向量库、真嵌入）在**投入产出上目前是负收益**，1 条（内嵌 UI）成本被低估，1 条（离线评测集）被低估价值 |
| 头号风险 | 🔴 **定位漂移**：DSH 自己已有 compaction、`systemPrompt.context()`、`dsh-session-query`（SQLite 全文检索）、`dsh-experimental-session-search`。继续往"通用 RAG 引擎"方向加能力，是在和宿主内建能力正面竞争 |

**一句话**：ContextPrism 应该收敛成 **"项目级、跨会话、可审计的检索层"**，而不是 **"另一套记忆数据库"**。

---

## 2. 本次已修复的缺陷（v0.8.0）

### 2.1 🔴 自动注入在默认配置下是空操作（P0）

**现象**：默认 `backend: "auto"` + `defaultIndex: ".lce/index.db"` 首次运行会创建**空的新 SQLite 库**。而注入逻辑是：

```js
// v0.7.0 lib/index.js
const window = engine.buildContext({ ... });   // 空索引 → totalTokens = 0
if (window.text) { ...注入... }                 // 空串 → 静默跳过
```

文件索引走 `ensureProjectFilesIndexed`，但 `agent/pre-step` 里**从不调用 `engine.save()` / `load()`**，也没有任何"新库 → 扫描"的引导。结果是：**模型永远看不到任何自动上下文，而日志里一个字都没有**。

**修复**：索引为空时明确计入 `diagnostics.skippedEmpty`，`context_prism_status` 现在直接回报 `Injection: prompt-context - N injected, M skipped`。空状态从"静默"变成"可观测"。

> 这一条是本次最重要的发现：README 声称的核心卖点（模型无感自动注入）在默认安装下根本不发生。

### 2.2 🔴 读消息事件的方式与宿主数据结构不符（P0）

v0.7.0 假设 `event.data.message.content` 是字符串：

```js
const message = event.data?.message;
if (typeof message.content === "string") return message.content;
```

DSH 0.2.1 的 `user/message` 事件**直接携带 message 本身**（`event.data` 就是 message），且 `content` 是**块数组** `[{type:"text",text}]`。于是所有消息事件都被抽成 `""` 并被跳过——**会话历史捕获率 0%**。

**修复**：`engine/session_events.js` 用 `blocksToText()` 统一处理字符串 / 块数组 / 单块对象，并按事件类型分别取 `data` 或 `data.message`。

### 2.3 🟠 用错了宿主的注入接缝（P1）

v0.7.0 在 `agent/pre-step` 里**自己往 messages 尾部追加一条 user 消息**。DSH 0.2.1 的循环本来就拥有这条链路：

- `preStep` 在 waterfall 之后调用 `runtimeContext.project(...)`，由**宿主**生成带 `source.kind` 归因的快照消息；
- 第三方再追加一条，会变成**两条无归因上下文消息**，既不能去重也不会被 `CLEARED` 语义替换；
- 失败路径被 `catch { console.error }` 吞掉，宿主侧不可见。

**修复**：改用 `ctx.systemPrompt.context()`（`dsh-system-prompt` 的 runtime-context 原语，`dsh-time-context` 用的同一个接缝），并把 `systemPrompt` 放进 `optionalInject`——宿主没有该服务时自动回落到 pre-step 老路径，**降级而不消失**。

### 2.4 🟠 检索用的是"数组位置"而不是词频统计（P1）

```js
// v0.7.0 engine/retrieval.js
function bm25RankScore(chunk, rankedChunks) {
  const rank = rankedChunks.indexOf(chunk);
  return Math.max(0, 1 - rank / rankedChunks.length);   // 第 1 名恒为 1.0，与内容无关
}
```

真正的 BM25 分数在 `LocalIndex.search()` 里算完就被丢掉了。后果：

- `relevanceWeight` 实际控制的是"名次"，不是"相关度"；
- 两个后端量纲完全不同（内存 BM25 为正、FTS5 `rank` 是**量级 1e-6 的负数**），`A/B 评测`里"语义 vs 纯 BM25"的差异被淹没在常数项里；
- `context_prism_evaluate` 的结论因此**不可信**。

**修复**：新增 `searchWithScores()`，两个索引各自回报原生分数；`normalizeHitScore()` 对 BM25 用 `s/(s+1)`、对 FTS5 rank 用 `1-1/(1+|r|·1e6)`，把两种量纲各自单调映射到 0..1。

### 2.5 🟠 压缩预算没有计入分隔符开销（P2）

`compressItems` 判定 `used + tokens <= budget`，但 `ContextSection` 渲染时每条记录还带 `\n\n` 与头部。v0.7.0 有测试 `used <= 80` 通过——因为它**没算渲染后的真实开销**。表现为：预算 4000 的窗口实际塞 4010+。

**修复**：`PACKING_SEPARATOR_TOKENS = 2`，pack 时显式计入；新测试按**渲染后**的 token 数断言。

### 2.6 🟡 生命周期泄漏（P2）

`engines` / `watchers` / `watchTimers` 是模块级 Map，`fs.watch` 句柄与 SQLite 连接在插件重载后**不释放**；`ctx.effect` 只清理注册过的东西。**修复**：`disposeAll()` 挂到 `ctx.effect`，重载即释放 watcher / timer / 索引句柄。

### 2.7 🟡 版本约束与真实宿主不匹配（P1）

`peerDependencies` 写的是 `^0.1.0-rc.6`，而目标宿主是 `0.2.1-rc.5`——`^0.1.0` 在 semver 里**不覆盖 0.2.x**，安装器会判定不满足。

**修复**：钉到 `0.2.1-rc.5`（与 `dsh-time-context` 等一等公民包口径一致），新增 `engine/version.js` 与 `status` 里的 host 兼容性报告。CI 矩阵从 `node 22` 扩到 `22 + 24`（24 是宿主自带运行时）。

### 2.8 修复后的验证

- **44 个测试**（新增 27 个）在 **Node 26 与宿主自带 Node 24.21.0 上全绿**；
- 插件在**真实 Cordis 应用**中挂载成功，注册 6 个工具 + 1 个 prompt context（`test/host.test.js`）；
- `defineTool` 的 schema 在 rc.5 的 DSL 下编译通过（新增负例测试确保 DSL 违规会抛错）。

---

## 3. 可优化点（按投入产出排序）

### 3.1 P0 —— 正确性/可信度

| # | 问题 | 证据 | 建议 |
| --- | --- | --- | --- |
| A | **A/B 评测不可信**：`hit()` 用 `JSON.stringify(chunk).includes(expected)` 判命中，任何包含该子串的 chunk 都算命中，且默认查询集写死在代码里 | `lib/index.js` 旧 `context_prism_evaluate` | 改为**召回集级**评测：对每个 query 标注 gold chunk id，计算 Recall@K / MRR / nDCG；查询集外置到 `bench/` |
| B | **无跨会话记忆**：`session:<id>` chunk 只在下一次注入时命中，DSH 换会话即失效 | `captureSessionEvents` 的 source 命名 | 见 §4.5：**这是本项目最该做的一件事** |
| C | **偏好永远满分**：`PREFERENCE` 用 `score = 10.0 - i*0.001` 强制置顶，与查询无关 | `engine.buildContext` | 偏好应**分层**：全局偏好常驻，项目偏好走检索 |
| D | **ingest 无规模边界**：`addDirectoryIncremental` 全量 `readdirSync` + 每文件 `readFileSync`，无并发上限、无超大文件跳过 | `engine.engine.js` | 加 `maxFileBytes`、并发 limit、`.lceignore` |
| E | **`walk()` 无符号链接防护**，`fs.watch(recursive)` 会把 `node_modules` 里的变更也唤醒 | `engine/ingest.js` / `lib/index.js` | 递归时跟踪 `realpath`，watch 前先剪枝 |

### 3.2 P1 —— 检索质量

1. **hash n-gram "embedding" 名不副实**：`engine/embedding.js` 是对 token 做 FNV 哈希到 256 维再归一化。它**不携带语义**，只捕获字面重叠——
   与 BM25 高度相关，`semanticWeight` 只是给同一信号加权两次。**这是 §13 第一条要重新评估的原因**（见 §4.1）。
2. **`sqlite_index` 的 `search()` 有 LIKE 全表兜底**：FTS 语法错误时退化为 `%query%` 全表扫描，在 5 万 chunk 级会严重卡顿，且**静默**。
3. **`tokenize()` 把整个 CJK 串当一个 token**（`[\u4e00-\u9fff]+`），中文检索只能整串匹配 → 需要 bigram 切分。
4. **`topK=40` 后再由 `prioritize()` 重排**，等于两套打分器叠加；`kindBase * 0.1` 这类常数缺乏依据。

### 3.3 P2 —— 工程

- `engine/` 与 `python/` **双实现已漂移**：Python 端有 `.docx` 脱壳读取、无 embedding / summarizer；JS 端反之。要么删 Python，要么明确它是"参考实现 + 测试床"（`pyproject` 里已写 lab，但 README 仍当产品讲）。
- `panel` 是**独立 HTML 页**，非 DSH 内嵌面板；数据每次请求全量 `allChunks()` 再切片。
- `graphify-out/` 之类生成物应进 `.gitignore`（本次已加）。

---

## 4. §13 后续方向逐条评估

### 4.1 「真正的向量数据库 / 本地 transformer embedding」— ⚠️ **建议降级**

**判断：方向可信，但当前是负收益，应推迟到有失败证据时再做。**

理由：
- 插件跑在 **DSH 宿主进程内**。引入 `onnxruntime-node` / `sentence-transformers` 意味着：几十 MB 原生依赖、宿主启动变慢、跨平台（macOS arm64/x64、Windows、Linux）预编译包维护——**这直接违背了项目自己写下的"不依赖 Python / WSL、本地优先"卖点**（`docs/ARCHITECTURE.md` §3）。
- 收益尚未被证明：目前**没有任何证据**说明字面检索在你的真实场景里失败。§3.1-A 指出 `evaluate` 的命中判定本身就不可信，**在修好评测之前谈换 embedding 是没有依据的**。
- 正确的中间步：先把 `embedding.js` 抽象为 `EmbeddingProvider` 接口（默认 hash，另提供可选的 `ctx.llm` / 远端 embedding 适配器），**让用户按 workspace 选**，而不是把模型塞进宿主。

**触发条件（先定门槛，再投入）**：在 ≥200 条带标注的 query 上，当前方案 Recall@10 < 0.6 时，才启动真向量方案。

### 4.2 「DSH 内嵌面板」— ✅ **方向对，但要做的不只是 UI**

**判断：合理性高，成本被低估。** 现在的 `/context-prism/dashboard` 是**独立标签页 + 全量表格**，且路由用模块级 `lastProjectRoot` 猜当前项目——多 workspace 并发时**会渲染错项目的索引**。

建议：
1. 复用 `ctx.clientModules` 的 client bundle 机制，注册真正的**右侧栏面板**（`sidebar.right` 之类插槽），而非 `window.open`；
2. 面板数据走**结构化查询**（`context_prism_report`）而不是整页 HTML；
3. 顺手修：路由应以 `session.header.cwd` / 显式参数决定项目，**不能依赖全局可变状态**。

### 4.3 「更多 provider adapter（Anthropic / Gemini / Ollama）」— ⛔ **建议砍掉**

**判断：与宿主定位冲突，且已经被宿主覆盖。**

- DSH 已有 `dsh-llm-deepseek` / `dsh-llm-pi-ai` / 可插拔 `LlmAdapter`。
- ContextPrism 的职责是"**造窗口**"，`toDeepSeekPayload()` 这类构造函数在**宿主内部**其实用不到——宿主自己组 payload，插件只贡献 context。
- 维护成本高（每家 SDK 变更、reasoning 字段差异），收益为零。

建议：把 `providers.js` 明确标注为"**独立使用（非插件）时的便利函数**"，不再新增 adapter。

### 4.4 「基于真实问答数据的离线评测集」— 🔥 **建议提到 P0，但改造目标**

**判断：方向完全正确，而且是整个路线里唯一能把项目从"感觉有用"变成"可证明有用"的一步——但不要只做"评测集"，要做"可信的评测器"。**

现状问题（§3.1-A）：命中判定是子串匹配，指标是 hit-rate，查询集写死 3 条。
建议做成：
1. `bench/queries.jsonl`：`{query, gold_chunk_ids[], session_id}`，从**真实会话**里抽；
2. 指标：Recall@K / MRR / nDCG@10，外加 **token 效率**（注入 token / 命中 token）；
3. 同时评测**三种路由**：纯 BM25、当前 hybrid、以及"**不注入**"基线——**没有基线的评测毫无意义**。
4. 进 CI，作为回归门禁。

### 4.5 「自动记忆 consolidation / 分层记忆」— ✅ **方向对，但优先级应排第一**

**判断：这是与 §4.2 并列、甚至更优的差异化点**，理由：
- DSH 的 `dsh-compaction*` 解决的是**单会话内**的上下文压缩；
- `dsh-session-query` / `dsh-experimental-session-search` 解决的是**检索历史会话**；
- **但"跨会话、按项目累积、带优先级的稳定记忆"没人做**——而这恰好是 ContextPrism 的 `SourceKind` 抽象天然支持的。

建议的 consolidation 设计（低成本、无新依赖）：
- 会话结束后，把 `history` chunk 用**现有 extractive 压缩**归并成 `memory` 类型的 chunk（可复用 `compressChunkToFit`）；
- 记忆条目带 `(project, topic, first_seen, last_seen, hit_count)`，按命中次数**递归提升 priority**；
- 冲突处理：同 topic 新记忆覆盖旧的，旧条目降级为 `history` 而不是删除（可审计）。

---

## 5. 建议的路线图（重排后）

```
P0（本季度）
  1. 完成 §2 全部修复                       ✅ 已随 v0.8.0 交付
  2. 可信评测器（§4.4）+ "不注入"基线        ← 没有这个，后面所有决策都是猜
  3. 跨会话记忆 consolidation（§4.5）         ← 唯一无人竞争的差异化点

P1
  4. CJK bigram 分词 + 去掉 LIKE 静默兜底
  5. 内嵌右栏面板（§4.2），同时修掉路由的全局状态
  6. ingest 规模边界（maxFileBytes / 并发 / .lceignore）

P2（有条件）
  7. EmbeddingProvider 抽象（默认仍 hash）；仅当 §4.4 的基线不达标才上真向量
  8. 删除 Python 双实现，或降级为明确标注的 `lab/`

不做
  ✗ 继续扩 provider adapter（已被宿主覆盖，见 §4.3）
  ✗ 把 transformer 运行时打进宿主进程
```

---

## 6. 评估本身的局限（诚实声明）

1. **graphify 的图有 63 条悬空边 / 1 条自环**（`docs/analysis/graph-report.md` 的健康检查已标注），社区划分的 cohesion 普遍偏低（0.06–0.18），说明**模块间耦合弱、语义边稀疏**——因此我用图谱做"导航与交叉验证"，**不把它当作事实来源**；§2 的每条缺陷都直接回到源码与运行时核对。
2. 本次**没有**在真实 DSH 会话里跑端到端注入（需要重启 GUI 宿主），验证边界止于"真实 Cordis 应用内挂载 + 真实 `defineTool`/`createUserMessage` 契约"。**首次真机验证应作为 v0.8.0 的发布门槛。**
3. Python 端只跑了现有 13 个 unittest（全绿），未做等价性对拍——这正是 §3.3 建议合并双实现的原因。
