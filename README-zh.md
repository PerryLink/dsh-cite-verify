# dsh-cite-verify

**核验一条引用是否存在，以及它的元数据对不对。**

*DOI / PMID / arXiv / BibTeX → 数据源自己的回答、逐字段检查、内容寻址快照、REP 证据记录。`not_found` 只报 skipped，绝不等于造假。*

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24.9-brightgreen.svg)]()

[English](README.md) · 简体中文

---

## 它做什么

- `doi` → **Crossref**；`pmid` → **PubMed E-utilities**；`arxiv` → **arXiv Atom API**。
- 把「引用里写的样子」与查到的记录逐项比对：**标题**（词元相似度）、**作者**（姓氏集合）、**年份**（±1 记警告）、**期刊/会议**、**页码**。
- 把数据源的**原始响应**存成不可变快照，并注册一条带这些检查的 **REP v1 证据**。
- `cite_fix` 以**文本**形式返回修正后的 BibTeX —— 从不改动文件。

## 它不做什么

- **不做标题检索**：必须给标识符（DOI/PMID/arXiv/BibTeX）。“帮我找支持 X 的论文”是另一个插件。
- **不做撤稿监测**：v0.1 只报告查出记录自带的 `update-to` 通知；判定某工作是否被撤稿交给 `dsh-retraction-watch`（W2）。
- **不读 PDF**：那是 `dsh-doc-anchor`。
- **不爬站**：只访问四个白名单 HTTPS API；不碰 CNKI、不碰 Sci-Hub、不绕付费墙。
- **不静默修复**：`cite_fix` 只给差异，采纳与否由用户决定。

## 兼容性

| 项 | 值 |
|---|---|
| DeepSeek Harness | **`dsh-v0.2.1-rc.5`**（2026-11-08 实测）；peer 区间 `>=0.2.1-0 <0.3.0 \|\| >=0.2.2-0 <0.3.0` |
| Node | `^22.19.0 \|\| >=24.9.0`（实测 `24.22.1`），仅 ESM |
| Peer | `@perrylink/dsh-research-core ^0.1.0`、`@deepseek-ai/cordis ^4.0.5-alpha.1`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery ^3.18.5-alpha.1` |
| 运行时依赖 | **零** |

```sh
dsh plugin --profile <name> add @perrylink/dsh-research-core dsh-cite-verify
dsh --profile <name> --dump-config | grep dsh-cite-verify
dsh plugin --profile <name> remove dsh-cite-verify
```

挂载了 `ctx.researchEvidence` 就写该存储，否则在 `root` 下自建 core store。

## 工具

### `cite_verify`

| 参数 | 类型 | 说明 |
|---|---|---|
| `doi` / `pmid` / `arxiv` | string | 至少一个标识符（或给 `bibtex`） |
| `bibtex` | string | 条目同时提供标识符**和**期望字段 |
| `title`、`authors`、`year`、`venue`、`pages` | | 引用里写的样子，用于逐字段比对 |
| `fresh` | boolean | 绕过响应缓存 |

返回 `{ ok, status, notFound, resolved, checks[], evidenceId, recordPath?, warnings[] }`。

`status` 由检查推导：有 `fail` → `fail`，有 `warn` → `warn`，有 `pass` → `ok`，什么都没查 → `unchecked`。

### `cite_batch`

`{ citations: string[], fresh? }`，每项为 `doi:10...`、`pmid:123`、`arxiv:2401.00001`、`@article{...}` 或按形状识别的裸标识符。有界并发、逐项失败隔离、重复检测。

### `cite_fix`

输入同 `cite_verify`，返回 `{ ok, bibtex, diffs[], status, evidenceId?, warnings[] }`。**只给文本，绝不写盘。**

### 错误码

`INVALID_INPUT` · `INVALID_BIBTEX` · `UNSUPPORTED_IDENTIFIER` · `STORE_ERROR` · `BATCH_TOO_LARGE`

网络失败**不会**变成“引用错误”：它表现为 `skipped` 检查（`network_error`、`rate_limited`、超时记 `unavailable`），证据保持 `unchecked`。

## 检查语义

| 检查 | pass | fail / warn | skipped |
|---|---|---|---|
| `doi-exists` | Crossref 返回该 DOI | — | Crossref 查无此 DOI 时 `not_found` |
| `other`（PMID/arXiv 存在性） | 数据源返回记录 | — | `not_found` |
| `metadata-match`（标题） | 相似度 ≥ `titleThreshold` | 低于阈值 `fail` | — |
| `metadata-match`（作者） | 引用姓氏全部命中 | ≥50% 记 `warn`，否则 `fail` | — |
| `metadata-match`（年份） | 完全一致 | ±1 记 `warn`，否则 `fail` | — |
| `metadata-match`（期刊） | 相似度 ≥ 0.6 | `warn` | — |
| `metadata-match`（页码） | 规范化后相等 | `warn` | — |
| `version-match` | 两个标识符标题一致 | 不一致 `warn` | — |
| `retraction` | — | 记录自带更新通知时 `warn` | — |

`not_found` **必须**记为 `skipped`（由 REP core store 与 schema 双重强制）。它既不是造假的证据，也不是干净的证据。

## 网络边界

- **白名单**：`api.crossref.org`、`api.openalex.org`、`eutils.ncbi.nlm.nih.gov`、`export.arxiv.org`（仅 HTTPS、无凭据、无自定义端口）。
- **重定向**：手动逐跳跟随，每跳重新校验；跳转到白名单外直接 `blocked_host` 失败。
- **时间与频率**：单请求超时、按 host 最小间隔、429/503 有界重试（`Retry-After` 最多等 5 s）。
- **缓存**：数据源响应缓存在 `<root>/cache`，TTL 默认 7 天；`fresh` 绕过。缓存写失败只是未命中，不算失败。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 不挂载 |
| `root` | `.cite-verify` | 存储 + 缓存根 |
| `userAgent` | `dsh-cite-verify/0.1.0 (…)` | 每个请求的 UA |
| `mailto` | — | PubMed `tool`/`email` 参数 |
| `timeoutMs` | `15000` | 单请求超时 |
| `minIntervalMs` | `150` | 同 host 最小间隔 |
| `retries` | `1` | 429/503 重试次数 |
| `maxRedirects` | `3` | 重定向预算（逐跳校验） |
| `cacheTtlMs` | `604800000` | 缓存寿命（`0` 关闭） |
| `titleThreshold` | `0.85` | 标题相似度阈值 |
| `batchConcurrency` | `3` | 批量并发 |
| `maxBatch` | `50` | 单批上限 |

非法值在挂载期响亮失败。

## 安全边界

- 不读文档，只取四个白名单 host 的 JSON/XML 元数据。
- 响应体成为不可变快照；证据只记录 **URL** 与数据源，从不记录凭据。
- 白名单 + 逐跳重定向校验阻断“经白名单 host 打内网”的 SSRF。
- 无遥测、无令牌、不上传用户数据（查询本身发给公开元数据 API，这是功能必需）。

## 已知限制（v0.1）

- **不查询撤稿状态**：只提示记录自带的 `update-to`，真正的监测是 `dsh-retraction-watch`。
- **DOI 只用 Crossref**：OpenAlex 已进白名单但尚未用作第二意见。
- **作者按姓氏比对**：姓名助词、音译差异会误报，这类不一致是警告而非“引用错误”的证据。
- **BibTeX 解析是子集**（不展开宏，嵌套花括号原样保留）。
- **缓存可能最多陈旧一个 TTL**；关键场景用 `fresh`。

## 评测

### 基准 —— `dsh-research-bench` citations v0.1.0（100 条）

命令（bench 与本仓并列检出，或设 `BENCH_DIR`）：

```sh
pnpm run bench:citations
```

结果（可复现；数据冻结；所有数据源调用都由用例自带 fixture 回答，不联网）：

| 指标 | 值 |
|---|---:|
| 存在性 precision | **1.00** |
| 存在性 recall | **1.00** |
| 字段 precision | **0.9559** |
| 字段 recall | **1.00** |
| 字段 F1 | **0.9774** |
| 更新通知 precision | **1.00** |
| 更新通知 recall | **1.00** |
| 干净样本误报率 | **0.10** |
| 整案完全一致率 | **0.97** |

3 个误报全部是**期刊缩写**（`J. Synth. Tests` vs `Journal of Synthetic Tests`）：期刊比较是 0.6 阈值的词元重叠，不展开期刊缩写。这是已知限制，如实报告。变音/转写差异（`Müller`/`Muller`、`Østergård`/`Ostergard`）与省略副标题已不再误报。

逐案预测： [`bench/results-citations.json`](bench/results-citations.json)。

**范围警告**：数据集是合成的、干净的。存在性 1.0 说明检查逻辑能把冻结 fixture 映射成正确 verdict，**不代表**真实世界准确率 —— 真实场景里主导因素是数据源漂移、音译与元数据歧义。`dsh-research-bench` 是测试集，不用于调参。

### 单元/集成测试

- **53 个测试 / 6 个文件**：HTTP 边界（白名单、重定向复验、重试、超时映射）、BibTeX（花括号与圆括号条目）、比较（含变音/副标题、PubMed 姓+缩写）、核验（命中/查无/超时/PMID/arXiv/BibTeX/更新通知/双源交叉/缓存/fresh）、运行时（REP 记录合法、持久化、重复核验不产生证据冲突、批量失败隔离、重复、修复差异）、工具面、包契约。
- 测试里所有数据源交互都是脚本化的 —— CI 不依赖外网。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run verify:package
```

## 许可

Apache-2.0。运行时零第三方代码。
