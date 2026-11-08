# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-08

First release: citation existence and metadata verification.

### Added

- `cite_verify`: DOI (Crossref), PMID (PubMed E-utilities) and arXiv (Atom API)
  resolution with field-by-field metadata checks (title/author/year/venue/pages),
  two-source title cross-check, record-level update-notice surfacing, and a REP
  v1 evidence item holding the exact provider response.
- `cite_batch`: bounded-concurrency reference-list verification with per-item
  failure isolation and duplicate detection.
- `cite_fix`: corrected BibTeX **as text** with an explicit field diff list;
  never writes to disk and preserves unknown fields and the citation key.
- Bounded HTTP client: HTTPS-only exact-host allowlist, manual redirect
  re-validation, per-request timeout, per-host minimum interval, one retry on
  429/503, SSRF-resistant hop checks.
- Response cache with TTL and a `fresh` bypass.
- `not_found` is always a `skipped` check and leaves the evidence `unchecked`.
- 46 tests across HTTP bounds, BibTeX, comparison, verification, runtime and
  tool surface; every provider interaction is scripted (CI is offline).

### Known limitations

- Retraction status is not queried (record-level update notices only).
- OpenAlex is allowlisted but not yet used as a second opinion.
- No precision/recall published yet — pending `dsh-research-bench`.
