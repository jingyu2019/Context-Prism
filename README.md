# ContextPrism

**ContextPrism** 是一个面向 DeepSeek Harness (DSH) 的本地上下文引擎 / 动态 context window 插件。

> **当前版本 v0.8.0，已对齐 DSH `0.2.1-rc.5`。**
> v0.7.0 的自动注入在默认配置下**从未生效**（空索引 → 空窗口 → 静默丢弃），
> 详见 [CHANGELOG](CHANGELOG.md#080---2026-11-04) 与 [深度评估](docs/analysis/ROADMAP-REVIEW.md)。

完整架构文档见：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
可优化点与后续方向评估见：[docs/analysis/ROADMAP-REVIEW.md](docs/analysis/ROADMAP-REVIEW.md)

它会在调用任何 LLM 之前，对以下本地数据做 **retrieval / compression / prioritization**：

- 无限历史（会话 / 对话）
- 代码
- 文件
- 用户偏好
- Agent trajectory

然后输出一个受 token 预算约束的 **动态 context window**，可适配任意 LLM（DeepSeek / OpenAI / 其他兼容接口）。

## 特性

- **DSH workspace / 项目级别**
  - 通过 `ctx.workspaceRegistry` 自动定位当前 DSH workspace
  - 每个项目独立存储：`.lce/index.db`
- **进程内 JS 实现**
  - 纯 JS BM25 + Node 内置 SQLite FTS5
  - 不依赖 Python / WSL
- **检索 / 压缩 / 优先级**
  - 混合检索：BM25 + 本地语义向量（hash n-gram embedding）+ 时间衰减 + 来源权重 + 用户优先级
  - 压缩：完整保留高优先级片段，超预算时 extractive compression / 可选 LLM 摘要 + 截断
  - 动态组装：`User Preferences → History → Trajectory → Code → Files`
- **LLM 摘要（可选）**
  - 配置 `llmSummarization: true` 后，压缩阶段会尝试用 DeepSeek 生成摘要
  - 未配置 API key 时自动回退到本地 extractive 压缩
- **DeepSeek / OpenAI 兼容**
  - 直接生成 `deepseek-chat` / `deepseek-reasoner` / OpenAI 兼容 payload
- **可视化**
  - `context_prism_dashboard` 生成独立 HTML 面板
  - DSH Web 侧边栏底部新增 ContextPrism 按钮，点击打开 `/context-prism/dashboard` 实时面板
- **缓存与增量**
  - 检索 / 压缩结果 TTL+LRU 缓存
  - 文件增量 ingest，按 mtime + size 跳过未变更内容
- **自动捕获 + 自动注入（DSH 0.2.1 接缝）**
  - 通过 `ctx.systemPrompt.context()` 注册每步上下文贡献，由宿主负责投影为带来源归因的消息
    （宿主没有该服务时自动回落到 `agent/pre-step` 追加消息）
  - 自动把当前会话历史、assistant 消息、tool call / tool result 写入项目索引，
    **捕获游标持久化在索引里**，重启不重复、不漏
  - 自动增量索引项目文件（默认 60s 内最多扫描一次）
  - 实时文件监听（`fs.watch` + 防抖重索引）
  - 注入状态可观测：`context_prism_status` 回报注入次数、空跳过次数、最近错误

## 目录

```text
Context-Prism/
├── package.json            # DSH 插件包
├── lib/index.js            # DSH 插件入口
├── engine/                 # JS 版 ContextPrism 核心
│   ├── models.js
│   ├── text_utils.js
│   ├── cache.js
│   ├── index.js
│   ├── sqlite_index.js
│   ├── session_events.js   # 宿主无关的会话事件读取
│   ├── version.js          # 宿主版本兼容性
│   ├── retrieval.js
│   ├── prioritization.js
│   ├── compression.js
│   ├── ingest.js
│   ├── engine.js
│   └── providers.js
├── test/                   # Node 测试（44）
│   ├── engine.test.js
│   ├── engine_fixes.test.js
│   ├── plugin.test.js
│   ├── compat.test.js
│   └── host.test.js
└── python/                 # Python 参考实现（可选）
    ├── local_context_engine/
    ├── tests/
    └── pyproject.toml
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
| `context_prism_build` | 在调用 LLM 前构建动态 context window |
| `context_prism_ingest` | 把文件/目录/history/trajectory 灌入本地索引 |
| `context_prism_status` | 索引状态 + **宿主版本兼容性** + 注入模式与计数 |
| `context_prism_dashboard` | 生成并保存独立的 HTML 可视化面板到 `.lce/dashboard.html` |
| `context_prism_evaluate` | 运行 A/B 检索评估（语义+BM25 vs BM25-only） |
| `context_prism_summarize` | 用 LLM 或本地 extractive 方式总结文本 |

## 测试

```bash
npm install
npm test          # 44 tests
```

测试分层：

| 文件 | 覆盖 |
| --- | --- |
| `test/engine.test.js` | 引擎基础（分词、BM25、FTS5、压缩、payload） |
| `test/engine_fixes.test.js` | 本次修复的回归（游标不泄漏、真实 BM25 分数、压缩预算含分隔符） |
| `test/plugin.test.js` | 工具注册、ingest/build、workspace 扫描、dashboard、A/B 评估 |
| `test/compat.test.js` | **rc.5 契约**：prompt-context 接缝、块内容解析、参数 DSL、client bundle 种子 |
| `test/host.test.js` | 在**真实 Cordis 应用**中挂载、可选服务降级、disposer 契约 |

CI 在 Node **22 与 24** 上跑（24 是 DSH 0.2.1 自带运行时）。

## Python 参考实现

```bash
cd python
python -m unittest discover -s tests -v
```
