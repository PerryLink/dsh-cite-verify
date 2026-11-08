# dsh-cite-verify

**Verify that a citation exists — and that its metadata is right.**

*DOI / PMID / arXiv / BibTeX → the provider's own answer, field-by-field checks, a content-addressed snapshot, and a REP evidence record. `not_found` is reported as skipped, never as fabrication.*

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24.9-brightgreen.svg)]()

English · [简体中文](README-zh.md)

---

## What it does

- Resolves `doi` through **Crossref**, `pmid` through **PubMed E-utilities**, `arxiv` through the **arXiv Atom API**.
- Compares the citation as written against the resolved record: **title** (token similarity), **authors** (family names), **year** (±1 = warning), **venue**, **pages**.
- Stores the provider's exact response as an immutable snapshot and registers a **REP v1 evidence item** with those checks.
- `cite_fix` returns a corrected BibTeX entry **as text** — it never edits files.

## What it does not do

- **No title search.** You must supply an identifier (DOI/PMID/arXiv/BibTeX). "Find me a paper that says X" is a different plugin.
- **No retraction monitoring.** v0.1 only reports update notices attached to the resolved record itself (`update-to`); deciding whether a work is retracted needs `dsh-retraction-watch` (W2).
- **No PDF reading.** That is `dsh-doc-anchor`.
- **No scraping.** Only the four allowlisted HTTPS APIs; no CNKI, no Sci-Hub, no paywall bypass.
- **No silent repair.** `cite_fix` reports diffs; applying them is the user's decision.

## Compatibility

| | |
|---|---|
| DeepSeek Harness | **`dsh-v0.2.1-rc.5`** (verified 2026-11-08); peer line `>=0.2.1-0 <0.3.0 \|\| >=0.2.2-0 <0.3.0` |
| Node | `^22.19.0 \|\| >=24.9.0` (tested on `24.22.1`), ESM only |
| Peers | `@perrylink/dsh-research-core ^0.1.0`, `@deepseek-ai/cordis ^4.0.5-alpha.1`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery ^3.18.5-alpha.1` |
| Runtime dependencies | **zero** |

```sh
dsh plugin --profile <name> add @perrylink/dsh-research-core dsh-cite-verify
dsh --profile <name> --dump-config | grep dsh-cite-verify
dsh plugin --profile <name> remove dsh-cite-verify
```

When `ctx.researchEvidence` is mounted the evidence goes there; otherwise the plugin uses its own core store under `root`.

## Tools

### `cite_verify`

| Parameter | Type | Notes |
|---|---|---|
| `doi` / `pmid` / `arxiv` | string | at least one identifier (or `bibtex`) |
| `bibtex` | string | entry supplies the identifier **and** the expected fields |
| `title`, `authors`, `year`, `venue`, `pages` | | fields as cited, compared against the record |
| `fresh` | boolean | bypass the response cache |

Returns `{ ok, status, notFound, resolved, checks[], evidenceId, recordPath?, warnings[] }`.

`status` is derived from the checks: any `fail` → `fail`, any `warn` → `warn`, any `pass` → `ok`, nothing checked → `unchecked`.

### `cite_batch`

`{ citations: string[], fresh? }` where each item is `doi:10...`, `pmid:123`, `arxiv:2401.00001`, an `@article{...}` entry, or a bare identifier detected by shape. Bounded concurrency, per-item failures, duplicate detection.

### `cite_fix`

Same inputs as `cite_verify`. Returns `{ ok, bibtex, diffs[], status, evidenceId?, warnings[] }`. **Text only — never writes to disk.**

### Error codes

`INVALID_INPUT` · `INVALID_BIBTEX` · `UNSUPPORTED_IDENTIFIER` · `STORE_ERROR` · `BATCH_TOO_LARGE`

Network failures never become citation failures: they appear as `skipped` checks (`network_error`, `rate_limited`, `unavailable` for timeouts) and leave the evidence `unchecked`.

## Check semantics

| Check | pass | fail / warn | skipped |
|---|---|---|---|
| `doi-exists` | Crossref returned the DOI | — | `not_found` when Crossref has no such DOI |
| `other` (PMID/arXiv existence) | provider returned the record | — | `not_found` |
| `metadata-match` (title) | similarity ≥ `titleThreshold` | `fail` below threshold | — |
| `metadata-match` (authors) | all cited family names present | `warn` ≥50 %, else `fail` | — |
| `metadata-match` (year) | exact | `warn` ±1, `fail` otherwise | — |
| `metadata-match` (venue) | similarity ≥ 0.6 | `warn` | — |
| `metadata-match` (pages) | normalized equality | `warn` | — |
| `version-match` | two identifiers agree on the title | `warn` on disagreement | — |
| `retraction` | — | `warn` when the record carries an update notice | — |

`not_found` **must** be recorded as `skipped` (enforced by the REP core store and schema). It is not evidence of fabrication and not evidence of cleanliness.

## Network bounds

- **Allowlist**: `api.crossref.org`, `api.openalex.org`, `eutils.ncbi.nlm.nih.gov`, `export.arxiv.org` (HTTPS only, no credentials, no custom port).
- **Redirects**: followed manually, every hop re-validated; a redirect to a non-allowlisted host is a hard `blocked_host` failure.
- **Time and rate**: per-request timeout, per-host minimum interval, one bounded retry on 429/503 (`Retry-After` respected up to 5 s).
- **Cache**: provider responses cached under `<root>/cache` for `cacheTtlMs` (7 days default); `fresh` bypasses. A cache write failure is a cache miss, never a failure.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` mounts nothing |
| `root` | `.cite-verify` | store + cache root |
| `userAgent` | `dsh-cite-verify/0.1.0 (…)` | sent to every provider |
| `mailto` | — | PubMed `tool`/`email` parameters |
| `timeoutMs` | `15000` | per-request deadline |
| `minIntervalMs` | `150` | per-host minimum interval |
| `retries` | `1` | retries on 429/503 |
| `maxRedirects` | `3` | redirect budget (each hop re-validated) |
| `cacheTtlMs` | `604800000` | cache lifetime (`0` disables) |
| `titleThreshold` | `0.85` | title similarity for a pass |
| `batchConcurrency` | `3` | parallel lookups |
| `maxBatch` | `50` | items per `cite_batch` |

Invalid values fail loud at mount.

## Security boundaries

- Documents are not read; only JSON/XML metadata from four allowlisted hosts.
- Response bodies become immutable snapshots; the evidence records the **URL** and the provider, never credentials.
- Redirect and allowlist checks prevent SSRF through an allowed host.
- No telemetry, no tokens, no uploads of user data (the query goes to the public metadata API, as it must).

## Known limitations (v0.1)

- **Retraction status is not queried.** Only the resolved record's own `update-to` notices are surfaced, with a warning. True monitoring is `dsh-retraction-watch`.
- **Crossref-only metadata for DOIs.** OpenAlex is allowlisted but not yet used as a second opinion.
- **Author comparison is family-name based.** Name particles and transliterations can differ; a mismatch is a warning, not proof of a wrong citation.
- **BibTeX parsing is a subset** (no macro expansion, nested braces preserved verbatim).
- **Cache can be stale** up to `cacheTtlMs`; use `fresh` when it matters.

## Evaluation

- **46 tests across 6 files**: HTTP bounds (allowlist, redirect re-validation, retries, timeout mapping), BibTeX, comparison, verification (found / not-found / timeout / PMID / arXiv / BibTeX / update notice / two-source cross-check / cache / fresh), runtime (REP record validity, persistence, batch locality, duplicates, fix diffs), tool surface, package contract.
- **No precision/recall number is published yet.** The plan of record requires `dsh-research-bench` (100 labelled citations) for that; until it runs, this README claims no accuracy. The next milestone fills this section with precision / recall / false-positive rate and the exact command.
- Every provider interaction in the test suite is scripted — CI never depends on the network.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run verify:package
```

## License

Apache-2.0. No third-party runtime code.
