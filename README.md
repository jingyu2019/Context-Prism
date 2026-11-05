# ContextPrism

**ContextPrism** 是一个面向 DeepSeek Harness (DSH) 的本地上下文引擎 / 动态 context window 插件。

> **当前版本 v0.9.0，已对齐 DSH `0.2.1-rc.5`。**
> v0.9 的三件事：**会话级隔离**（会话 A 的历史不会出现在会话 B 的窗口里）、
> **并发安全**（N 个会话共享一个 workspace 索引互不干扰）、以及**可信评测器**
> （三条路由 + 41 条标注查询 + “不注入”基线）。
> v0.7.0 的自动注入在默认配置下**从未生效**（空索引 → 空窗口 → 静默丢弃），
> 详见 [CHANGELOG](CHANGELOG.md#080---2026-11-04) 与 [深度评估](docs/analysis/ROADMAP-REVIEW.md)。

完整架构文档见：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
可优化点与后续方向评估见：[docs/analysis/ROADMAP-REVIEW.md](docs/analysis/ROADMAP-REVIEW.md)
会话隔离与并发的规范契约见：[docs/SPEC-SESSION-ISOLATION.md](docs/SPEC-SESSION-ISOLATION.md)

它会在调用任何 LLM 之前，对以下本地数据做 **retrieval / compression / prioritization**：

- 无限历史（会话 / 对话）
- 代码
- 文件
- 用户偏好
- Agent trajectory

然后输出一个受 token 预算约束的 **动态 context window**，可适配任意 LLM（DeepSeek / OpenAI / 其他兼容接口）。

## 特性

- **会话级隔离（v0.9）**
  - `history` / `trajectory` chunk 归属于**捕获它的那个会话**；窗口只检索调用方会话自己的历史
  - 两个会话共享同一个 `.lce/index.db` 也**互相看不见**对方的历史（`test/scope.test.js` + `test/plugin.test.js`）
  - `preference` / `code` / `file` 仍是项目级：换会话不丢偏好、不丢代码
  - 会话身份只在**调用参数**里传递（`buildContext({ scope })`），从不进入引擎缓存键或引擎映射
- **并发安全（v0.9）**
  - 每个请求/每一步自带 scope，N 个会话 `Promise.all` 并发装配互不干扰
  - 捕获有**实例级 in-flight guard**：同一会话重入被合并（`reentered: true`），不同会话从不互相阻塞
  - 捕获游标取 `max(调用方, 已持久化)`，只单调前进，重启不重复、不漏
  - 模块级只有索引句柄（按 index 路径）、按会话的计数簿记（有上限）与聚合计数器；
    **没有任何模块级变量决定一个请求读哪个项目 / 哪个会话**
- **DSH workspace / 项目级别**
  - 通过 `ctx.workspaceRegistry` 自动定位当前 DSH workspace
  - 每个项目独立存储：`.lce/index.db`
- **进程内 JS 实现**
  - 纯 JS BM25 + Node 内置 SQLite FTS5
  - 不依赖 Python / WSL
  - **CJK bigram 分词（v0.9）**：中文按重叠 bigram 建索引，短查询能命中长句子（两个后端一致）
- **检索 / 压缩 / 优先级**
  - 混合检索：BM25 + 本地语义向量（hash n-gram embedding）+ 时间衰减 + 来源权重 + 用户优先级
  - 压缩：完整保留高优先级片段，超预算时 extractive compression / 可选 LLM 摘要 + 截断
  - 动态组装：`User Preferences → History → Trajectory → Code → Files`
  - 检索 / 压缩缓存**真正生效**（v0.9 前键是数组，按引用比较，从未命中）；键里含 scope
- **上限明确的 ingest（v0.9）**
  - `maxFileBytes` 1 MiB、`maxTotalBytes` 32 MiB、`maxFiles` 20000
  - `.lceignore`；符号链接默认跳过（`followSymlinks: false`），并回报 `sizeSkipped` / `symlinkSkipped`
- **LLM 摘要（可选）**
  - 配置 `llmSummarization: true` 后，压缩阶段会尝试用 DeepSeek 生成摘要
  - 未配置 API key 时自动回退到本地 extractive 压缩
- **可观测 / 可信评测（v0.9）**
  - `context_prism_report`：结构化 JSON 报告（按 kind / 按 scope 计数、逐会话状态、注入计数、宿主兼容性、检索诊断），**不返回任何 chunk 内容**
  - `context_prism_evaluate`：委派 `engine/evaluation.js`，同时报告 `no-injection`（基线）/ `bm25-only` / `hybrid` 三条路由的 Recall@K、MRR、nDCG@10、token efficiency
  - 评测集随仓库提交（`bench/`，41 条标注查询 × 41 个 block），CI 内即可重跑
- **DeepSeek / OpenAI 兼容**
  - 直接生成 `deepseek-chat` / `deepseek-reasoner` / OpenAI 兼容 payload
- **可视化**
  - DSH Web 侧边栏按钮打开**内嵌面板**（v0.9 起不再新开页面），渲染 `context_prism_report` 的同一份数据
  - `GET /context-prism/report` 返回 JSON；`GET /context-prism/dashboard` 用同一份 Report 渲染可选 HTML
- **自动捕获 + 自动注入（DSH 0.2.1 接缝）**
  - 通过 `ctx.systemPrompt.context()` 注册每步上下文贡献，由宿主负责投影为带来源归因的消息
    （宿主没有该服务时自动回落到 `agent/pre-step` 追加消息）
  - 自动把当前会话历史、assistant 消息、tool call / tool result 写入项目索引，
    **捕获游标持久化在索引里**，重启不重复、不漏
  - 自动增量索引项目文件（默认 60s 内最多扫描一次）
  - 实时文件监听（`fs.watch` + 防抖重索引）
  - 注入状态可观测：`context_prism_report` / `context_prism_status` 回报注入次数、空跳过次数、重入合并次数、最近错误

## 目录

```text
Context-Prism/
├── package.json            # DSH 插件包
├── lib/
│   ├── index.js            # DSH 插件入口：工具、自动捕获/注入、文件监听、HTTP 路由
│   └── client.js           # DSH Web 客户端：侧边栏内嵌报告面板
├── engine/                 # JS 版 ContextPrism 核心
│   ├── models.js           # Chunk / ContextWindow / SourceKind / isVisibleInScope
│   ├── text_utils.js       # tokenize（含 CJK bigram）/ sentence split / TF
│   ├── cache.js
│   ├── index.js            # 纯 JS BM25 索引
│   ├── sqlite_index.js     # Node 内置 SQLite FTS5 索引
│   ├── session_events.js   # 宿主无关的会话事件读取
│   ├── version.js          # 宿主版本兼容性
│   ├── retrieval.js        # 混合检索打分 + scope 过滤
│   ├── prioritization.js
│   ├── compression.js
│   ├── ingest.js           # 有界、符号链接安全、.lceignore 感知的 ingest
│   ├── evaluation.js       # 可信评测器（Recall@K / MRR / nDCG / token efficiency）
│   ├── engine.js           # LocalContextEngine 编排器
│   └── providers.js
├── bench/                  # 提交进仓库的评测夹具（corpus + queries.jsonl + 基线）
├── test/                   # Node 测试（104）
│   ├── engine.test.js
│   ├── engine_fixes.test.js
│   ├── scope.test.js
│   ├── ingest.test.js
│   ├── evaluation.test.js
│   ├── plugin.test.js
│   ├── compat.test.js
│   └── host.test.js
└── python/                 # Python 参考实现（可选）
```

## 安装到 DSH

```bash
# 从 GitHub 安装（需要仓库公开后）
dsh plugin --profile web add github:LFM097384/Context-Prism

# 或在 profile 的 cordis.patch.yml 中激活
```

```yaml
- insert:
    - id: context-prism
      name: 'context-prism-dsh-plugin'
      config:
        backend: 'auto'
        defaultIndex: '.lce/index.db'
        autoInject: true
        autoIndexFiles: true
        autoMaxTokens: 4000
        autoReservedTokens: 800
        autoIndexIntervalMs: 60000
        fileWatch: true
        watchDebounceMs: 2000
        llmSummarization: false
        summarizationModel: 'deepseek-chat'
        summaryMaxTokens: 200
```

## 工具

| Tool | 作用 |
| --- | --- |
| `context_prism_build` | 在调用 LLM 前构建动态 context window（默认按调用方会话隔离） |
| `context_prism_ingest` | 把文件/目录/history/trajectory 灌入本地索引 |
| `context_prism_status` | 索引状态 + **宿主版本兼容性** + 注入模式与计数（人读格式） |
| `context_prism_report` | 同上，但返回**结构化 JSON**（面板与自动化读这一份） |
| `context_prism_dashboard` | 用同一份 Report 渲染可选 HTML 到 `.lce/dashboard.html` |
| `context_prism_evaluate` | 可信检索评测：`no-injection` / `bm25-only` / `hybrid` 三路由对比 |
| `context_prism_summarize` | 用 LLM 或本地 extractive 方式总结文本 |

## HTTP 路由

| 路由 | 返回 |
| --- | --- |
| `GET /context-prism/report?project=<绝对路径>` | `application/json` 的结构化 Report（永不返回 HTML） |
| `GET /context-prism/dashboard?project=<绝对路径>` | 由同一份 Report 渲染的 HTML |
| 未知/非法 `project` | `400` + `{"error":{"code":"BAD_PROJECT",...}}` |

项目解析顺序：`?project=` → `defaultProjectRoot` 配置 → `process.cwd()`，
每条请求各自解析（v0.9 删除了模块级 `lastProjectRoot`，一个宿主可以正确服务两个项目根）。

## 评测基线（诚实版）

`bench/` 随仓库提交，`context_prism_evaluate` 不带参数时直接跑它（k=10，41 条查询）：

| 路由 | Recall@10 | MRR | nDCG@10 | Token efficiency | 注入 token |
| --- | --- | --- | --- | --- | --- |
| `no-injection`（基线） | 0.000 | 0.000 | 0.000 | n/a | 0 |
| `bm25-only` | 0.976 | **0.785** | **0.833** | 35.24 | 64 275 |
| `hybrid` | 0.976 | 0.758 | 0.812 | 35.24 | 64 275 |

**结论：在本夹具上 hybrid 没有赢过 bm25-only**（MRR 0.758 < 0.785，nDCG 0.812 < 0.833）。
这与 `embedding.js` 的实现一致：它对 token 做 FNV 哈希到 256 维，捕获的是字面重叠而不是语义，
和 BM25 高度相关，`semanticWeight` 等于给同一个信号再加一次权。
现在这件事**可以被度量**了——这正是评测器存在的意义，详见
[ROADMAP-REVIEW §2.9](docs/analysis/ROADMAP-REVIEW.md)。

## 测试

```bash
npm install
npm test          # 104 tests
```

测试分层：

| 文件 | 覆盖 |
| --- | --- |
| `test/engine.test.js` | 引擎基础（分词、BM25、FTS5、压缩、payload）— 冻结的向后兼容门 |
| `test/engine_fixes.test.js` | 历史修复回归 — 冻结的向后兼容门 |
| `test/scope.test.js` | 会话作用域：可见性谓词、两个后端隔离、over-fetch、缓存键、scope 分离，以及并发（多会话并行装配、捕获重入合并、游标单调） |
| `test/ingest.test.js` | 有界 ingest：大小/数量上限、`.lceignore`、符号链接与环 |
| `test/evaluation.test.js` | 评测器：指标、路由隔离、夹具确定性、只读性 |
| `test/plugin.test.js` | 工具注册、ingest/build、会话隔离、结构化 report、三路由评测 |
| `test/compat.test.js` | **rc.5 契约**：prompt-context 接缝、块内容解析、参数 DSL、client 面板 |
| `test/host.test.js` | 在**真实 Cordis 应用**中挂载、可选服务降级、disposer 契约、两个项目根 |

CI 在 Node **22 与 24** 上跑（24 是 DSH 0.2.1 自带运行时）。

## Python 参考实现

```bash
cd python
python -m unittest discover -s tests -v
```
