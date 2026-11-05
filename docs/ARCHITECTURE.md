# ContextPrism 架构文档

> 版本：v0.9.0（DSH `0.2.1-rc.5`）  
> 定位：DeepSeek Harness (DSH) 的本地上下文引擎 / 动态 context window 插件  
> 会话隔离与并发的规范契约：[SPEC-SESSION-ISOLATION.md](SPEC-SESSION-ISOLATION.md)

---

## 1. 概述

ContextPrism 的目标是：**在调用任何 LLM API 之前，把本地项目里的无限历史、代码、文件、用户偏好、Agent trajectory 做 retrieval / compression / prioritization，输出一个受 token 预算约束的动态 context window。**

它不是一个独立的记忆数据库，也不是一个简单 RAG 工具，而是 DSH 与任意 LLM 之间的一层“上下文预处理层”。

---

## 2. 核心架构图

```text
┌────────────────────────────────────────────────────────────────────┐
│                         DSH Workspace / Project                     │
│                                                                      │
│  Session Events        Files & Code          User Preferences        │
│  (history/trajectory)  (md/ts/py/json...)   (preference chunks)     │
└───────────┬──────────────────┬───────────────────────┬──────────────┘
            │                  │                       │
            ▼                  ▼                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        ContextPrism Host Plugin                     │
│                                                                      │
│  Prompt Context        Auto Index Files        File Watcher         │
│  (systemPrompt.context) (incremental scan)     (fs.watch)           │
│                                                                      │
│  LocalContextEngine                                                  │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ Ingest → Retrieve → Prioritize → Compress → Assemble        │    │
│  │                                                             │    │
│  │ BM25 / SQLite FTS5 + Local Semantic Embedding               │    │
│  │ Cache / Token precompute / Optional LLM Summarization       │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  Tools: build / ingest / status / report / dashboard / evaluate / summarize
│  HTTP Routes: /context-prism/report (JSON) · /context-prism/dashboard (HTML)
└─────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Any LLM API                                  │
│  DeepSeek / OpenAI / compatible gateways                            │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. 设计目标

| 目标 | 说明 |
| --- | --- |
| 项目级隔离 | 每个 DSH workspace 独立索引，默认 `.lce/index.db` |
| **会话级隔离（v0.9）** | 一个会话的 history / trajectory 只出现在它自己的窗口里；偏好 / 代码 / 文件仍是项目级 |
| **并发安全（v0.9）** | N 个会话共享一个索引并行装配互不干扰；没有任何模块级变量决定“读哪个项目 / 哪个会话” |
| 本地优先 | 不依赖云端存储，不额外消耗生产 API key |
| Provider-agnostic | 只负责“造窗口”，不绑定具体模型 |
| 自动上下文层 | 尽量让模型无感，自动捕获 + 自动注入 |
| 高性能 | SQLite FTS5 + 缓存 + 预计算 token + 增量 ingest |
| 可观测 | status / report / dashboard / evaluate 工具 |

---

## 4. 模块结构

```text
Context-Prism/
├── package.json               # DSH 插件包 + bundle + client 声明
├── cordis.patch.yml           # DSH bundle patch（激活插件）
├── lib/
│   ├── index.js               # Host 插件入口：工具、自动捕获/注入、文件监听、HTTP 路由
│   └── client.js              # DSH Web 客户端：侧边栏内嵌报告面板
├── engine/                    # 核心 JS 引擎（进程内运行）
│   ├── models.js              # Chunk / ContextWindow / SourceKind / isVisibleInScope
│   ├── text_utils.js          # tokenize（CJK bigram）/ sentence split / TF
│   ├── cache.js               # TTL + LRU 缓存
│   ├── index.js               # 纯 JS BM25 索引（含 diagnostics）
│   ├── sqlite_index.js        # Node 内置 SQLite FTS5 索引（含 diagnostics）
│   ├── session_events.js      # 宿主无关的会话事件读取与投影
│   ├── version.js             # 宿主版本兼容性
│   ├── embedding.js           # 本地 hash n-gram embedding
│   ├── retrieval.js           # 混合检索打分（scope 过滤 + over-fetch）
│   ├── prioritization.js      # 优先级排序
│   ├── compression.js         # 压缩 / 截断 / 省略提示
│   ├── summarizer.js          # 可选 LLM 摘要 + extractive fallback
│   ├── ingest.js              # 有界 / 符号链接安全 / .lceignore 的文件导入
│   ├── evaluation.js          # 可信评测器：Recall@K / MRR / nDCG / token efficiency
│   ├── engine.js              # LocalContextEngine 编排器
│   └── providers.js           # DeepSeek / OpenAI payload
├── bench/                     # 提交进仓库的评测夹具（corpus / queries.jsonl / 基线）
├── test/                      # Node 测试（104）
│   ├── engine.test.js
│   ├── engine_fixes.test.js
│   ├── scope.test.js
│   ├── ingest.test.js
│   ├── evaluation.test.js
│   ├── plugin.test.js
│   ├── compat.test.js
│   └── host.test.js
└── python/                    # Python 参考实现（可选）
```

---

## 5. 核心数据流

### 5.1 Ingest

- **Session 自动捕获**
  - 每次 prompt-context 求值时增量读取 `agent.session.events`
  - `user/message`、`assistant/message` 作为 History chunk，`tool/call`、`tool/result` 作为 Trajectory chunk
  - 内容按**块数组**解析（`[{type:"text", text}]`），不是字符串
  - 每个 chunk 都带 `metadata.sessionId` 与 `source: session:<id>`：**它属于那个会话**
  - 捕获游标以 `session_cursor` chunk 持久化在索引中，**重启不重复、不漏**
  - 同一会话的重入调用被合并（`reentered: true`，`added: 0`）；游标取 `max(调用方, 已持久化)`，只单调前进

- **文件自动索引**
  - 默认索引：`.md .txt .py .ts .tsx .js .jsx .json .jsonl .csv .html .css`
  - 默认忽略：`node_modules .git .lce dist build .venv __pycache__ .next coverage .turbo`
  - 使用 `mtime + size` 做增量状态，跳过未变化文件

- **实时文件监听**
  - `fs.watch(projectRoot, { recursive: true })`
  - 文件变化后防抖 `watchDebounceMs`（默认 2000ms）
  - 触发增量重索引

### 5.2 Retrieve

```text
score =
  relevanceWeight * normalize(backend score)
+ semanticWeight  * cosine(queryEmbedding, chunkEmbedding)
+ recencyWeight   * exp(-age / halfLife)
+ sourceWeight    * sourceBoost
+ priorityWeight  * priority/10
```

- **相关度**来自后端**原生分数**：`LocalIndex` 的 BM25，或 FTS5 的 `rank`；
  `normalizeHitScore()` 把两种量纲各自单调映射到 0..1（BM25 为正、FTS5 rank 是量级 1e-6 的负数）
- **可见性先于打分**：候选集先过 `isVisibleInScope(chunk, scope)`，再计算分数；
  过滤只有一个入口（`retrieve()`），所以“别的会话的历史”不可能通过任何打分路径混进窗口。
  有界 over-fetch（4× topK，最多 +200）保证会话自己的历史不会因为全局排名靠后而消失
- 语义：`engine/embedding.js` 的 hash n-gram embedding + cosine（**字面级相似，非语义理解**）
- 来源权重：`preference > trajectory > history > code > file`
- 同分时按 `chunk.id` 升序，保证同一输入永远得到同一排序（确定性）

### 5.3 Prioritize

- 用户偏好永远优先
- 再按检索分、来源基础分、时间衰减、长度惩罚综合排序
- 支持 chunk 级 `priority` 字段

### 5.4 Compress

- 高优先级 chunk 完整保留
- 超预算 chunk：
  1. extractive sentence compression
  2. 可选 LLM 摘要（`llmSummarization: true`）
  3. 最后截断
- 打包时显式计入条目分隔符开销（`PACKING_SEPARATOR_TOKENS`），保证渲染后不超预算
- 被省略内容生成 `Omitted Memory` 提示

### 5.5 Assemble

最终 ContextWindow 按 section 组装：

```text
User Preferences → Relevant History → Agent Trajectory → Relevant Code → Relevant Files → Omitted Memory
```

输出形式：

- `window.text`：纯文本
- `window.asMessages()`：OpenAI 风格 messages
- `toDeepSeekPayload()`：DeepSeek API payload（独立使用时）
- `window.report()`：JSON 可观测报告（含 `scope`：产生这个窗口的会话，`null` 表示整库）
- `window.scope`：本次装配实际使用的 scope

### 5.6 会话隔离与并发契约（v0.9）

规范条文见 [SPEC-SESSION-ISOLATION.md](SPEC-SESSION-ISOLATION.md)，这里是实现要点。

**归属规则**（`engine/models.js`，唯一实现 `isVisibleInScope()`）：

| kind | 归属 | 谁能看到 |
| --- | --- | --- |
| `history` / `trajectory` | 捕获它的会话（`metadata.sessionId`，回退 `source: session:<id>`） | 只有该会话 |
| `preference` / `code` / `file` | 项目 | 所有会话 |
| `session_cursor` | 控制记录 | 谁都不检索 |
| 无主的 `history`/`trajectory`（导入的 JSONL 语料） | 项目 | 所有会话（v0.9 明确如此，不假装隔离） |

**scope 怎么传**：

```js
const scope = sessionIdOf(context?.agent?.session);         // prompt-context provider
engine.buildContext({ ..., scope });                         // 只在这一处传
```

`buildContext` / `buildContextAsync` 的 `scope` 选项与 `retrievalConfig.scope` 只能有一个来源，
两者不一致会抛 `TypeError`（宁可失败也不猜）。

**模块级允许存在什么**（`lib/index.js`）：

| 状态 | 键 | 说明 |
| --- | --- | --- |
| `engines` | `${backend}:${index}` | 引擎是**索引句柄**，不是会话句柄；session id 永不进 key |
| `sessionState` | `sessionId` | 每会话簿记（最近注入时间/token），上限 512，最旧优先淘汰，`disposeAll()` 清空 |
| `fileScanTimes` / `watchers` / `watchTimers` | 项目根 | 文件扫描节流与监听 |
| `diagnostics` | — | 聚合计数器；只被观测，**不参与任何路由决策** |

**禁止**：任何模块级可变变量决定一个请求读哪个项目或哪个会话。v0.8 的
`resolveProjectRoot()` 会写、dashboard 路由会读，多 workspace 并发时必然渲染错项目（D5）；
v0.9 删除了它，`resolveProjectRoot()` 变成纯函数，路由按请求解析（§6.3）。

**并发行为**：N 个会话的装配可以真正并行（`Promise.all`）。每个调用自带 scope，
缓存键含 `s:JSON.stringify(scope)`，所以 A 的检索结果永远不会被 B 命中；
捕获的 in-flight guard 是**实例级 Map**，不同会话互不阻塞，同一会话的并发重入被合并。

### 5.7 可信评测（`engine/evaluation.js`）

评测的**命中**由 gold chunk id 决定，不再由子串决定：

- 夹具：`bench/corpus/**`（41 个 block，id 形如 `bench:retrieval.md#0`）+ `bench/queries.jsonl`
  （41 条标注查询）。两者都进仓库，`loadBenchFixture()` 负责分配 id，所以换目录不会失效。
- 指标：`Recall@K`、`MRR`、`nDCG@10`、`tokenEfficiency`（注入 token / 命中 token）。
- 三条路由各自独立：`no-injection`（对照，不注入任何内容）、`bm25-only`、`hybrid`。
  每条路由**自己的引擎实例 + 每查询 `clearCaches()`**，所以 `hybrid` 的结果绝不会被
  `bm25-only` 复用（缓存键里也含 `useSemantic` / `semanticWeight`）。
- 只读：不改索引、不发网络请求、不调用 LLM/summarizer。

实测基线（k=10，同一夹具）：

| 路由 | Recall@10 | MRR | nDCG@10 | TE | 注入 token |
| --- | --- | --- | --- | --- | --- |
| `no-injection` | 0.000 | 0.000 | 0.000 | n/a | 0 |
| `bm25-only` | 0.976 | 0.785 | 0.833 | 35.24 | 64 275 |
| `hybrid` | 0.976 | 0.758 | 0.812 | 35.24 | 64 275 |

**hybrid 在这套夹具上没有赢过 bm25-only。** 这不是评测器坏了，而是评测器第一次能说话：
hash n-gram “embedding” 捕获的是字面重叠，与 BM25 高度相关，`semanticWeight` 等于给同一
信号再加一次权。结论与后续决定见 [ROADMAP-REVIEW §2.9](analysis/ROADMAP-REVIEW.md)。

---

## 6. DSH 集成

### 6.1 自动注入（v0.8.0 已改为宿主接缝）

v0.7.0 在 `agent/pre-step` 里自行 `messages.push()` 一条 user 消息。该做法与 DSH 0.2.1 的
运行时上下文投影**冲突**：宿主会在 waterfall 之后由 `runtimeContext.project()` 生成带
`source.kind` 归因的快照消息，第三方再追加一条会得到两条无归因上下文，既不能去重也不会
被 `CLEARED` 语义替换；且失败被本地 `catch` 吞掉，宿主侧不可见。

v0.8.0 改为注册一个 **prompt context provider**：

```js
const systemPrompt = ctx.get("systemPrompt");   // optionalInject
systemPrompt.context({
  name: "context-prism",
  order: 118,                                    // 在沙箱/审批策略之后、harness source 之前
  text: async ({ agent }) => buildInjectionText(...),
});
```

每步装配时，`text(context)` 被重新求值，返回的字符串作为一条归因到 `context-prism` 的
runtime-context 贡献交给宿主渲染。收益：

1. **归因**：模型能看到这段上下文的来源，而不是一条伪装成用户发言的消息；
2. **可替换**：宿主的 `CLEARED` 快照语义会在内容消失时正确清理，不会留下陈旧记忆；
3. **可观测**：provider 抛错会冒泡到宿主，同时被记录进 `diagnostics.lastError`。

注入流程：

1. `agent.session.header.cwd` → workspace root（`ctx.workspaceRegistry`）
2. 从索引读取该会话的**捕获游标**，`captureSessionEvents()` 增量入库（幂等，重启不重不漏）
3. 按节流窗口增量索引项目文件
4. 索引为空 → 计入 `skippedEmpty` 并返回空串（**不再静默**）
5. `buildContext({ scope: sessionIdOf(session) })` 生成窗口 → 渲染为带来源说明的贡献文本
   （v0.9：窗口只含**这个会话**自己的历史，同 workspace 的其他会话不可见）

宿主缺少 `systemPrompt` 服务时，插件自动回落到 pre-step 追加消息路径，并计为
`Injection: pre-step-fallback`。

### 6.2 模型工具

| Tool | 作用 |
| --- | --- |
| `context_prism_build` | 手动构建动态 context window（默认按调用方会话隔离） |
| `context_prism_ingest` | 手动灌入文件 / history / trajectory |
| `context_prism_status` | 索引状态 + 宿主版本兼容性 + 注入模式与计数（人读格式，内部由同一份 Report 支撑） |
| `context_prism_report` | 同一份状态的结构化 JSON（面板与自动化读它；不返回任何 chunk 内容） |
| `context_prism_dashboard` | 用同一份 Report 渲染可选 HTML 到 `.lce/dashboard.html` |
| `context_prism_evaluate` | 可信检索评测：`no-injection` / `bm25-only` / `hybrid` 三路由对比 |
| `context_prism_summarize` | LLM / extractive 总结文本 |

`context_prism_report` 的 Report（`schemaVersion: 1`）字段：

```text
project {root, source}          source = query | config | cwd
index   {path, backend, revision, chunks}
counts  {total, byKind{六种全给, 缺省 0}, byScope{sessionScoped, projectScoped, unowned}}
sessions[] {sessionId, history, trajectory, cursor, lastChunkAt, lastInjectedAt, lastWindowTokens}
injection {mode, injections, skippedEmpty, reentries, last, lastError}
host    {version, target, supported, reason}
diagnostics.search {ftsErrorCount, likeFallbackCount, likeFallbackRows, lastFallbackAt, searchTextMigration}
```

两条可校验的不变量：`sum(byKind) === total`；`sessionScoped + projectScoped === total`
（`unowned` 是 `projectScoped` 的子集：无主的 history 对所有会话可见）。

### 6.3 HTTP 路由

| 路由 | 返回 |
| --- | --- |
| `GET /context-prism/report?project=<绝对路径>` | `application/json` 的 Report（**永不返回 HTML**，错误也是 JSON） |
| `GET /context-prism/dashboard?project=<绝对路径>` | 由**同一份 Report** 渲染的 HTML（没有第二条数据路径） |
| 非法 `project` | `400 {"error":{"code":"BAD_PROJECT","message":…}}` |

项目解析顺序（每条请求各自解析，互不可见）：

1. `?project=` —— 必须是绝对路径且是目录，否则 `400 BAD_PROJECT`
2. `defaultProjectRoot` 配置（绝对路径）
3. `process.cwd()`

响应里的 `project.source` 告诉调用方实际命中了哪一条。v0.9 删除了 v0.8 的模块级
“上一个项目”全局：一个宿主现在可以正确地同时服务两个项目根（`test/host.test.js`）。

### 6.4 Client 插件

- `lib/client.js` 使用 DSH `__ModuleLoader__` 加载，只在 factory 闭包内产生副作用
- 注册 `sidebar.footer.action` 插槽
- `require` 只能解析 `dsh.client.inject` 声明的种子（本插件只声明 `react`）
- 点击按钮**在 shell 内**渲染报告面板（抽屉式 overlay）：拉取 `/context-prism/report`
  并渲染 `counts` / `sessions` / `injection` / `host` / `diagnostics.search`
- 不使用 `window.open`（v0.8 会新开一个标签页），不注入 HTML：所有值都以文本节点渲染
- 失败可见：非 2xx 或抛错时面板显示一行含状态码的错误，而不是空白

---

## 7. 存储设计

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| 主索引 | `<workspace>/.lce/index.db` | SQLite FTS5 |
| 备用索引 | `<workspace>/.lce/index.json` | 纯 JS BM25 |
| 增量状态 | `<workspace>/.lce/index.db.state.json` | mtime + size |
| 会话游标 | `<workspace>/.lce/index.db` | `session_cursor` kind，永不检索 |
| Dashboard | `<workspace>/.lce/dashboard.html` | 可选 HTML 面板（由 Report 渲染） |
| 运行时缓存 | 内存 | TTL + LRU，键含 scope（v0.9 起真正命中） |
| 每会话簿记 | 内存 | `sessionState`，上限 512，随插件卸载清空 |

---

## 8. 配置参考

```yaml
context-prism:
  backend: "auto"              # auto | sqlite | json
  defaultIndex: ".lce/index.db"
  cacheSize: 128
  cacheTtl: 60

  defaultProjectRoot: ""       # 可选：HTTP 路由在后备项目根（绝对路径），空=未设置

  autoInject: true             # 注册 prompt context
  promptContext: true          # 宿主无 systemPrompt 时自动回落到 pre-step
  autoIndexFiles: true         # 自动增量索引项目文件
  autoMaxTokens: 4000
  autoReservedTokens: 800
  autoIndexIntervalMs: 60000
  sessionCaptureLimit: 400     # 单步最多捕获的事件数

  fileWatch: true
  watchDebounceMs: 2000

  llmSummarization: false
  summarizationModel: "deepseek-chat"
  summaryMaxTokens: 200

  hostVersion: "0.2.1-rc.5"    # 兼容性报告用的目标版本
```

---

## 9. 性能设计

- SQLite FTS5 全文检索：O(log N) 级别
- 检索 / 压缩结果缓存：TTL + LRU，键 = `rev + scope + query + config` 指纹
  （v0.9 前键是数组、按引用比较，从未命中；现在真的命中，且会话之间不会串）
- 预计算 token：ingest 时算好，热路径不重复估算
- 增量 ingest：mtime + size 跳过未变文件；单文件 1 MiB / 单批次 32 MiB / 20000 个文件上限
- 文件监听防抖：避免频繁全量扫描
- 本地语义 embedding：固定维度 hash，无外部模型调用
- scope 过滤在打分前完成，over-fetch 有界（4× topK，最多 +200）

---

## 10. DeepSeek 兼容

- `toDeepSeekPayload(window, { model: "deepseek-chat" })`
- `deepseek-reasoner` 自动省略 `temperature`
- `callDeepSeek()` 使用标准库 `fetch` 发送请求
- 未配置 `DEEPSEEK_API_KEY` 时不会自动调用外部 API

---

## 11. 测试策略

```bash
cd Context-Prism
npm install
npm test
```

覆盖：

- Token 估算（中英文）
- BM25 / SQLite FTS5 检索
- 压缩预算
- 语义 embedding
- LLM summarizer fallback
- 端到端 context 构建
- DSH 工具注册与执行
- workspace 级默认索引
- 自动捕获 + 自动注入（prompt-context 接缝）
- 宿主版本兼容性报告
- 真实 Cordis 应用内挂载
- HTML dashboard 生成
- **会话隔离**：可见性谓词、两个后端、over-fetch、scope 分离、两个会话共享一个索引
- **并发**：多会话并行装配、捕获重入合并、游标单调、不同会话互不阻塞
- **有界 ingest**：大小/数量上限、`.lceignore`、符号链接与环
- **CJK bigram 分词**（两个后端一致）
- **可信评测**：指标、路由隔离、夹具确定性、只读性
- **结构化报告**：字段完整性、计数不变量、不泄漏 chunk 内容
- **路由**：一个宿主服务两个项目根、非法 `project` 返回 JSON 400

当前：`104 tests / 104 pass`（Node 24.21.0 与 Node 26 双运行时验证）

---

## 12. 发布状态

- GitHub：https://github.com/LFM097384/Context-Prism
- DSH 市场 PR：#1772（等待仓库年龄满 1 天后通过 gate）
- 当前版本：v0.9.0（DSH `0.2.1-rc.5`）

---

## 14. 后续方向

> 完整评估（含证据、投入产出排序、建议路线图）见
> [docs/analysis/ROADMAP-REVIEW.md](analysis/ROADMAP-REVIEW.md)。
> 本节只保留结论摘要，避免两处文档再次漂移。

| 原方向 | 结论 | 理由摘要 |
| --- | --- | --- |
| 真正的向量数据库 / 本地 transformer embedding | ⚠️ 仍是 P2，但问题现在**可判定** | v0.9 的可信评测第一次给出了数字：hybrid 在 41 条标注查询上**没有**赢过 bm25-only（MRR 0.758 vs 0.785，nDCG 0.812 vs 0.833），说明当前 hash “语义”信号确实不计贡献。是否上真向量仍取决于 `EmbeddingProvider` 抽象与更大标注集，而不是凭感觉 |
| DSH 内嵌面板 | ✅ **v0.9 已交付** | 面板改为 shell 内的结构化报告渲染；路由按请求解析项目，模块级“上一个项目”全局已删除（D5） |
| 更多 provider adapter | ⛔ 不做 | DSH 已有 `LlmAdapter` 与 `dsh-llm-*`；插件只负责“造窗口”，`toDeepSeekPayload()` 在宿主内用不到 |
| 基于真实问答数据的离线评测集 | ✅ **v0.9 已交付** | `bench/`（41 查询 × 41 block）+ `engine/evaluation.js`，Recall@K / MRR / nDCG / token efficiency，含**不注入基线**与三路由隔离 |
| 自动记忆 consolidation / 分层记忆 | ❌ **未做**（v0.9 不是它） | v0.9 做的是**会话隔离**：捕获的 `history` 只属于捕获它的会话，**没有**变成跨会话共享的项目记忆。宿主的 compaction 只管单会话，跨会话 consolidation 仍无人覆盖，且仍是最大差异化点 |
