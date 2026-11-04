# ContextPrism 架构文档

> 版本：v0.8.0（DSH `0.2.1-rc.5`）  
> 定位：DeepSeek Harness (DSH) 的本地上下文引擎 / 动态 context window 插件

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
│  Tools: build / ingest / status / dashboard / evaluate / summarize  │
│  HTTP Route: /context-prism/dashboard                               │
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
| 本地优先 | 不依赖云端存储，不额外消耗生产 API key |
| Provider-agnostic | 只负责“造窗口”，不绑定具体模型 |
| 自动上下文层 | 尽量让模型无感，自动捕获 + 自动注入 |
| 高性能 | SQLite FTS5 + 缓存 + 预计算 token + 增量 ingest |
| 可观测 | status / dashboard / evaluate 工具 |

---

## 4. 模块结构

```text
Context-Prism/
├── package.json               # DSH 插件包 + bundle + client 声明
├── cordis.patch.yml           # DSH bundle patch（激活插件）
├── lib/
│   ├── index.js               # Host 插件入口：工具、自动捕获/注入、文件监听、HTTP 路由
│   └── client.js              # DSH Web 客户端：侧边栏 ContextPrism 按钮
├── engine/                    # 核心 JS 引擎（进程内运行）
│   ├── models.js              # Chunk / ContextWindow / SourceKind
│   ├── text_utils.js          # tokenize / sentence split / TF
│   ├── cache.js               # TTL + LRU 缓存
│   ├── index.js               # 纯 JS BM25 索引
│   ├── sqlite_index.js        # Node 内置 SQLite FTS5 索引
│   ├── session_events.js      # 宿主无关的会话事件读取与投影
│   ├── version.js             # 宿主版本兼容性
│   ├── embedding.js           # 本地 hash n-gram embedding
│   ├── retrieval.js           # 混合检索打分
│   ├── prioritization.js      # 优先级排序
│   ├── compression.js         # 压缩 / 截断 / 省略提示
│   ├── summarizer.js          # 可选 LLM 摘要 + extractive fallback
│   ├── ingest.js              # 文件 / history / trajectory 导入
│   ├── engine.js              # LocalContextEngine 编排器
│   └── providers.js           # DeepSeek / OpenAI payload
├── test/                      # Node 测试（44）
│   ├── engine.test.js
│   ├── engine_fixes.test.js
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
  - 捕获游标以 `session_cursor` chunk 持久化在索引中，**重启不重复、不漏**

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
- 语义：`engine/embedding.js` 的 hash n-gram embedding + cosine（**字面级相似，非语义理解**）
- 来源权重：`preference > trajectory > history > code > file`

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
- `window.report()`：JSON 可观测报告

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
5. `buildContext()` 生成窗口 → 渲染为带来源说明的贡献文本

宿主缺少 `systemPrompt` 服务时，插件自动回落到 pre-step 追加消息路径，并计为
`Injection: pre-step-fallback`。

### 6.2 模型工具

| Tool | 作用 |
| --- | --- |
| `context_prism_build` | 手动构建动态 context window |
| `context_prism_ingest` | 手动灌入文件 / history / trajectory |
| `context_prism_status` | 索引状态 + 宿主版本兼容性 + 注入模式与计数 |
| `context_prism_dashboard` | 生成独立 HTML dashboard |
| `context_prism_evaluate` | A/B 检索评估 |
| `context_prism_summarize` | LLM / extractive 总结文本 |

### 6.3 HTTP 路由

- 路由：`GET /context-prism/dashboard`
- 返回当前项目的实时 HTML dashboard
- DSH Web 侧边栏底部按钮直接打开该路由
- ⚠️ 已知问题：路由用模块级 `lastProjectRoot` 猜当前项目，多 workspace 并发时会渲染错项目（见评估 §4.2）

### 6.4 Client 插件

- `lib/client.js` 使用 DSH `__ModuleLoader__` 加载，只在 factory 闭包内产生副作用
- 注册 `sidebar.footer.action` 插槽
- `require` 只能解析 `dsh.client.inject` 声明的种子（本插件只声明 `react`）
- 点击按钮打开 `/context-prism/dashboard`

---

## 7. 存储设计

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| 主索引 | `<workspace>/.lce/index.db` | SQLite FTS5 |
| 备用索引 | `<workspace>/.lce/index.json` | 纯 JS BM25 |
| 增量状态 | `<workspace>/.lce/index.db.state.json` | mtime + size |
| 会话游标 | `<workspace>/.lce/index.db` | `session_cursor` kind，永不检索 |
| Dashboard | `<workspace>/.lce/dashboard.html` | 独立 HTML 面板 |
| 运行时缓存 | 内存 | TTL + LRU |

---

## 8. 配置参考

```yaml
context-prism:
  backend: "auto"              # auto | sqlite | json
  defaultIndex: ".lce/index.db"
  cacheSize: 128
  cacheTtl: 60

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
- 检索 / 压缩结果缓存：TTL + LRU，索引 revision 变化自动失效
- 预计算 token：ingest 时算好，热路径不重复估算
- 增量 ingest：mtime + size 跳过未变文件
- 文件监听防抖：避免频繁全量扫描
- 本地语义 embedding：固定维度 hash，无外部模型调用

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
- A/B 检索评估

当前：`44 tests / 44 pass`（Node 24.21.0 与 Node 26 双运行时验证）

---

## 12. 发布状态

- GitHub：https://github.com/LFM097384/Context-Prism
- DSH 市场 PR：#1772（等待仓库年龄满 1 天后通过 gate）
- 当前版本：v0.8.0（DSH `0.2.1-rc.5`）

---

## 14. 后续方向

> 完整评估（含证据、投入产出排序、建议路线图）见
> [docs/analysis/ROADMAP-REVIEW.md](analysis/ROADMAP-REVIEW.md)。
> 本节只保留结论摘要，避免两处文档再次漂移。

| 原方向 | 结论 | 理由摘要 |
| --- | --- | --- |
| 真正的向量数据库 / 本地 transformer embedding | ⚠️ 降级为 P2，先抽象 `EmbeddingProvider` | 原生依赖会破坏"无 Python/WSL、本地优先"的卖点；且现有评测器不可信，**尚无证据证明字面检索失败** |
| DSH 内嵌面板 | ✅ P1，但不止是 UI | 现路由依赖模块级 `lastProjectRoot`，多 workspace 并发会渲染错项目，需一并修掉 |
| 更多 provider adapter | ⛔ 不做 | DSH 已有 `LlmAdapter` 与 `dsh-llm-*`；插件只负责"造窗口"，`toDeepSeekPayload()` 在宿主内用不到 |
| 基于真实问答数据的离线评测集 | 🔥 提到 P0，且要做成"可信评测器" | 现有命中判定是 `JSON.stringify().includes()` 子串匹配 + 写死的 3 条查询，结论不可用；需 Recall@K / MRR / nDCG 与**不注入基线** |
| 自动记忆 consolidation / 分层记忆 | 🔥 P0，最具差异化 | 宿主的 compaction 只管单会话，session-query 只管检索；**跨会话的项目级稳定记忆无人覆盖** |
