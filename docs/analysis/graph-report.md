# Graph Report - Context-Prism (2026-11-04)

> 由 `/graphify` 生成：44 个文件（37 代码 + 7 文档）→ 579 nodes / 1 312 edges / 30 communities。
> 保留本文件用于导航，以及**定位"代码与文档不一致"的位置**；它不作为事实来源，
> 每条结论都回到源码与 DSH 运行时复核过。

## Corpus Check
- Corpus is ~19,980 words (44 files: 37 code, 7 docs) - small enough to fit one context, so this graph is for navigation and for proving where the code contradicts the docs, not for coverage.

## Summary
- 579 nodes · 1312 edges · 30 communities (22 shown, 8 thin omitted)
- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS · INFERRED: 127 edges (avg confidence: 0.9)
- Token cost: AST extraction is deterministic and free; the 7 doc files were read by the host agent.

## 健康检断（诚实声明）

| 指标 | 值 | 含义 |
| --- | --- | --- |
| dangling endpoint edges | 63 | 语义抽取引用了 AST 中不存在的符号（多为跨语言 `ref_node_*`） |
| self-loop edges | 1 | 自引用 |
| collapsed undirected edges | 47 | 同一对端点被多条 relation 连接（`calls`/`references`/`uses`），无向图下合并 |
| 社区 cohesion | 0.06 – 0.18 | 普遍偏低 → 模块间语义边稀疏，说明**模块化尚可、但文档-代码相互引用很少** |

处置方式：**不修复悬空边**（它们是抽取质量的正常副产物），只在阅读时记住
"图谱的证据强度低于源码"。

## Community Hubs (Navigation)
- Compression & Token Budgeting (66)
- Cache & Engine Orchestrator (43)
- Plugin Manifest & Client UI (40)
- LLM Providers & Summarizer (33)
- SQLite FTS5 Index (python) (26)
- Extractive Compression (python) (25)
- ContextWindow & Providers (python) (25)
- Ingest Pipeline (python) (23)
- Python Engine Demo (23)
- Changelog & Release History (22)
- BM25 Index (python) (22)
- SQLite Index (js) (20)

> 注意：社区划分把 **JS 与 Python 两套实现分开聚簇**（`Compression & Token Budgeting` vs
> `Extractive Compression (python)`），这在图上是两个社区，在语义上是同一件事——
> 正是 §3.3 指出“双实现已漂移”的图形证据。

## God Nodes (most connected - your core abstractions)
1. `LocalContextEngine` - 56 edges
2. `SourceKind` - 47 edges
3. `Chunk` - 43 edges
4. `SqliteIndex` - 31 edges
5. `LocalContextEngine` (python) - 30 edges
6. `LocalIndex` - 27 edges
7. `SqliteIndex` (python) - 24 edges
8. `LocalIndex` (python) - 19 edges
9. `run_demo()` - 17 edges
10. `estimateTokens()` - 16 edges

读法：`LocalContextEngine` / `SourceKind` / `Chunk` 是真正的核心抽象，改动它们会穿透整个仓库；
`run_demo()` 排进前 10 说明 Python 示例引用面过宽（它本应是个叶子）。

## Surprising Connections (you probably didn't know these)
- `numpy / sentence-transformers / chromadb / lancedb` --semantically_similar_to--> `Local Hash N-gram Embedding`  [INFERRED]
  `python/requirements.txt` → `docs/ARCHITECTURE.md`
- `engine.buildContext()` --semantically_similar_to--> `context_prism_build tool`  [INFERRED]
  `docs/USAGE.md` → `README.md`
- `fastapi / uvicorn (HTTP service skeleton)` --semantically_similar_to--> `HTTP Route GET /context-prism/dashboard`  [INFERRED]
  `python/requirements.txt` → `docs/ARCHITECTURE.md`
- `Preference: local-first, privacy-preserving` --semantically_similar_to--> `Local-first / project-level isolation goal`  [INFERRED]
  `examples/seed_data/user_preferences.md` → `docs/ARCHITECTURE.md`
- `engine.addHistoryJsonl()` --conceptually_related_to--> `Agent Trajectory`  [INFERRED]
  `docs/USAGE.md` → `README.md`

最有价值的一条是第一条：文档与依赖注释同时指向"未来上真向量"，但实现是 hash n-gram——
这就是 §4.1 认为该方向需要先定义**触发条件**的依据。

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Ingest → Retrieve → Prioritize → Compress → Assemble Pipeline** — EXTRACTED 1.00
- **DSH automatic capture / index / inject loop at agent/pre-step** — EXTRACTED 1.00
- **ContextPrism release to DSH Plugin Market** — EXTRACTED 1.00

> 第二条 hyperedge 在 v0.8.0 已过时：接缝从 `agent/pre-step` 改成了 `systemPrompt.context()`。
> 保留原文是为了显示"文档描述的概念簇"与"实现"的偏差。

## Suggested Questions
- **Why does `LocalContextEngine` connect `Python Engine Demo` to `SQLite FTS5 Index (python)`,
  `ContextWindow & Providers (python)`, `BM25 Index (python)`, `engine · retrieval`, `engine · cli`?**
  — 高介数中心性（0.041），跨社区桥节点。
- **Are the 16 inferred relationships involving `LocalContextEngine` actually correct?**
  — 需要人工核验的 INFERRED 边。
- **What connects `local-context-engine-lab`, `DeepSeek Harness (DSH)`, `cordis.patch.yml`
  to the rest of the system?**
  — 13 个弱连接节点，可能是文档缺口。
- **Should `Compression & Token Budgeting` be split?**
  — cohesion 0.08，弱连接。

## 重现方式

```bash
cd Context-Prism
graphify . --no-viz        # 或 graphify . 生成 graph.html
```
