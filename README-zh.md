# dsh-cite-verify

**核验一条引用确实存在 —— 并核验它的元数据是否正确。**

*DOI / PMID / arXiv / BibTeX → 数据源自己的回答、逐字段核对、内容寻址的快照，以及一条 REP 证据记录。`not_found` 只作为 skipped 报告，绝不当作造假。*

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24.9-brightgreen.svg)]()

[English](README.md) · 简体中文

---

## 它做什么

- 通过 **Crossref** 解析 `doi`，通过 **PubMed E-utilities** 解析 `pmid`，通过 **arXiv Atom API** 解析 `arxiv`。
- 把引用里的写法与解析出的记录逐项比对：**标题**（词元相似度）、**作者**（姓氏）、**年份**（±1 记警告）、**期刊/会议**、**页码**。
- 把数据源返回的原始响应存成不可变快照，并注册一条携带这些检查结果的 **REP v1 证据**。
- `cite_fix` 以**文本**形式返回修正后的 BibTeX 条目 —— 它从不改动文件。
- `cite_export` 把解析出的记录格式化为 **GB/T 7714（顺序编码制）、APA 7、IEEE、Vancouver、BibTeX、RIS 或 CSL-JSON** —— 缺字段只报告，不臆造。

## 它不做什么

- **不做标题检索。** 必须提供标识符（DOI/PMID/arXiv/BibTeX）。“帮我找一篇说了 X 的论文”是另一个插件的事。
- **不做撤稿监测。** v0.1 只报告解析出的记录本身附带的更新通知（`update-to`）；判断一项工作是否已被撤稿需要 `dsh-retraction-watch`（W2）。
- **不读 PDF。** 那是 `dsh-doc-anchor` 的事。
- **不抓站。** 只调用四个白名单内的 HTTPS API；不碰 CNKI，不碰 Sci-Hub，也不绕过付费墙。
- **不做静默修复。** `cite_fix` 只报告差异；是否采纳由用户决定。
- **不做完整样式引擎，也不改大小写。** 七种内置格式；需要其它样式时导出 CSL-JSON 交给外部 `citeproc`。标题保持原样。

## 兼容性

| | |
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

挂载了 `ctx.researchEvidence` 时，证据写入该存储；否则插件使用 `root` 下自己的 core 存储。

## 工具

### `cite_verify`

| 参数 | 类型 | 说明 |
|---|---|---|
| `doi` / `pmid` / `arxiv` | string | 至少给出一个标识符（或者给出 `bibtex`） |
| `bibtex` | string | 条目同时提供标识符**和**期望字段 |
| `title`、`authors`、`year`、`venue`、`pages` | | 引用中的写法，用于与记录比对 |
| `fresh` | boolean | 绕过响应缓存 |

返回 `{ ok, status, notFound, lookupError, resolved, checks[], evidenceId, recordPath?, warnings[] }`。

只有当没有任何数据源返回记录、至少有一个数据源明确返回 404、且没有任何查询失败时，`notFound` 才为 `true`。当网络故障、超时、5xx 或无法解析的响应导致某项检查无法完成时，`lookupError` 为 `true` —— 这时的结论是 `unchecked`，绝不能读作“没有找到记录”。如果其中一个标识符查询失败而另一个解析成功，记录仍会返回，同时标记 `lookupError: true`。

`status` 由各项检查推导而来：出现任意 `fail` → `fail`，出现任意 `warn` → `warn`，出现任意 `pass` → `ok`，什么都没检查 → `unchecked`。

### `cite_batch`

`{ citations: string[], fresh? }`，其中每一项可以是 `doi:10...`、`pmid:123`、`arxiv:2401.00001`、一个 `@article{...}` 条目，或按形状识别的裸标识符。并发有界，逐项隔离失败，并进行重复检测。

每个条目都带有 `status`、`lookupError?`、`duplicate?` 与 `evidenceId?`。重复出现的标识符会被标记为 `duplicate: true`；如果它此前已经失败，就仍保持 `fail`（重复项绝不会降低最差状态），否则会被提升为 `warn`。批次的 `warnings[]` 会统计重复项的数量。

### `cite_fix`

输入与 `cite_verify` 相同。返回 `{ ok, bibtex, diffs[], status, evidenceId?, warnings[] }`。**只输出文本 —— 从不写盘。**

### `cite_export`

标识符输入与 `cite_verify` 相同，另有 `style` 以及可选的 `volume`、`issue`、`publisher`、`url`、`language`（`zh` 用“等”，否则用 et al.）与 `index`（IEEE 序号）。也可以直接传 `record` 对象做离线格式化。

| `style` | 格式 |
|---|---|
| `gbt7714-numeric`（默认） | 作者. 题名[J]. 刊名, 年, 卷(期): 页. DOI. |
| `apa` | Author, A. A., & Author, B. B. (Year). Title. *Journal, Volume*(Issue), pages. https://doi.org/… |
| `ieee` | [n] A. A. Author, "Title," *Journal*, vol. V, no. I, pp. P, Year. |
| `vancouver` | Author AB. Title. Journal. Year;Volume(Issue):Pages. |
| `bibtex` | `@article{key, …}`，key 确定性生成 |
| `ris` | `TY  - JOUR` … `ER  -` |
| `csl-json` | 交给外部处理器的 CSL-JSON |

返回 `{ ok, style, entry, missing[], evidenceId?, warnings[] }`。`missing` 列出记录中缺失的字段；带标识符时仍走与 `cite_verify` 相同的 provider 查询与 REP 证据路径。

### 错误码

`INVALID_INPUT` · `INVALID_BIBTEX` · `UNSUPPORTED_IDENTIFIER` · `STORE_ERROR` · `BATCH_TOO_LARGE`

网络失败永远不会变成引用失败：它们表现为 `skipped` 检查（`network_error`、`rate_limited`，超时则为 `unavailable`），置 `lookupError: true`，并让证据保持 `unchecked`、`notFound: false`。

## 检查语义

| 检查 | pass | fail / warn | skipped |
|---|---|---|---|
| `doi-exists` | Crossref 返回了该 DOI | — | Crossref 查无此 DOI 时记 `not_found` |
| `other`（PMID/arXiv 存在性） | 数据源返回了记录 | — | `not_found` |
| `metadata-match`（标题） | 相似度 ≥ `titleThreshold` | 低于阈值记 `fail` | — |
| `metadata-match`（作者） | 引用的姓氏全部出现 | ≥50% 记 `warn`，否则记 `fail` | — |
| `metadata-match`（年份） | 完全一致 | ±1 记 `warn`，否则记 `fail` | — |
| `metadata-match`（期刊/会议） | 相似度 ≥ 0.6 | 记 `warn` | — |
| `metadata-match`（页码） | 规范化后相等 | 记 `warn` | — |
| `version-match` | 两个标识符的标题一致 | 不一致时记 `warn` | — |
| `retraction` | — | 记录带有更新通知时记 `warn` | — |

`not_found` **必须**记为 `skipped`（由 REP core 存储与 schema 强制）。它既不是造假的证据，也不是清白的证据。

## 网络边界

- **白名单**：`api.crossref.org`、`api.openalex.org`、`eutils.ncbi.nlm.nih.gov`、`export.arxiv.org`（仅限 HTTPS，不带凭据，不使用自定义端口）。
- **重定向**：手动逐跳跟随，每一跳都重新校验；重定向到白名单之外的 host 属于 `blocked_host` 硬失败。
- **时间与频率**：每个请求都有超时，每个 host 都有最小间隔；429/503 时进行一次有界重试（`Retry-After` 最多遵守 5 秒）。
- **缓存**：数据源响应缓存在 `<root>/cache` 下，保留 `cacheTtlMs`（默认 7 天）；`fresh` 会绕过缓存。缓存写入失败只算一次未命中，绝不算失败。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时不挂载任何内容 |
| `root` | `.cite-verify` | 存储与缓存的根目录 |
| `userAgent` | `dsh-cite-verify/0.1.0 (…)` | 发送给每个数据源的 User-Agent |
| `mailto` | — | PubMed 的 `tool`/`email` 参数 |
| `timeoutMs` | `15000` | 单请求时限 |
| `minIntervalMs` | `150` | 同一 host 的最小间隔 |
| `retries` | `1` | 429/503 的重试次数 |
| `maxRedirects` | `3` | 重定向预算（每一跳都重新校验） |
| `cacheTtlMs` | `604800000` | 缓存存活时间（`0` 表示关闭） |
| `titleThreshold` | `0.85` | 标题相似度的通过阈值 |
| `batchConcurrency` | `3` | 并行查询数 |
| `maxBatch` | `50` | 单次 `cite_batch` 的条目上限 |

非法取值会在挂载时直接报错。

## 安全边界

- 不读取文档；只读取四个白名单 host 提供的 JSON/XML 元数据。
- 响应体成为不可变快照；证据记录的是 **URL** 与数据源，从不记录凭据。
- 重定向与白名单校验可以防止借白名单 host 实施 SSRF。
- 没有遥测，没有令牌，也不上传用户数据（查询本身会发往公开的元数据 API，这是功能所必需）。

## 已知限制（v0.1）

- **不查询撤稿状态。** 只呈现解析出的记录自身携带的 `update-to` 通知，并附一条警告。真正的监测由 `dsh-retraction-watch` 负责。
- **DOI 的元数据只来自 Crossref。** OpenAlex 已进入白名单，但尚未用作第二意见。
- **作者比对基于姓氏。** 姓名助词与转写方式可能不同；不一致只是一条警告，并不能证明引用写错了。
- **BibTeX 解析只覆盖一个子集**（不展开宏，嵌套花括号原样保留）。
- **缓存可能最多陈旧 `cacheTtlMs` 这么久**；在意时请使用 `fresh`。

## 评测

### 基准评测 —— `dsh-research-bench` citations v0.1.0（100 条用例）

命令（需要把 bench 检出放在本仓旁边，或设置 `BENCH_DIR`）：

```sh
pnpm run bench:citations
```

结果（可复现；数据集已冻结；每次数据源调用都由用例自带的 fixture 回答 —— 不联网）：

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

三个误报全部是**期刊缩写**（`J. Synth. Tests` 与 `Journal of Synthetic Tests`），而这些引用在其他方面都是正确的：期刊比较采用 0.6 阈值的词元重叠，不展开期刊缩写。这是一个已知限制，我们选择如实报告而不是隐藏。变音符号/转写差异（`Müller`/`Muller`、`Østergård`/`Ostergard`）以及省略副标题的情况已不再产生误报。

逐案原始预测：[`bench/results-citations.json`](bench/results-citations.json)。

**范围警告**：数据集是合成的、干净的。存在性得分 1.0 只说明这套检查逻辑能把冻结的 fixture 映射为正确的判定；它**并不**预示真实世界的准确率 —— 在真实场景中，数据源漂移、转写差异与元数据歧义才是主导因素。`dsh-research-bench` 是测试集，不用于调参。

### 单元测试与集成测试

- **56 个测试，分布在 6 个文件**：HTTP 边界（白名单、重定向复验、重试、超时映射）、BibTeX（花括号与圆括号条目）、比较（含变音符号/副标题，以及 PubMed 姓氏+缩写）、核验（找到 / 查无 / 超时 / PMID / arXiv / BibTeX / 更新通知 / 双源交叉核对 / 缓存 / fresh，以及 `notFound` 与 `lookupError` 的区分，包含 404 与超时混合的情形）、运行时（REP 记录合法性、持久化、不产生证据冲突的重复核验、批量处理中的逐项隔离、重复项（含保留 fail 状态）、修复差异）、工具接口（含“查无”与“查询失败”两种渲染）、包契约。
- 测试套件中的每一次数据源交互都是脚本化的 —— CI 从不依赖网络。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run verify:package
```

## 许可

Apache-2.0。运行时不含任何第三方代码。
