# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `notFound` is now true only for a definitive provider 404 with no failed
  lookup; network/timeout/5xx/parse failures set a new `lookupError` flag and
  the tool render says "lookup failed" instead of "no record found".
- Batch duplicates are marked with `duplicate: true` and no longer downgrade a
  metadata `fail` to `warn`; non-failing duplicates are raised to `warn`.
- Re-verifying the same provider answer no longer fails with `STORE_ERROR`:
  evidence identity is the immutable snapshot plus the checks, and its
  timestamps come from the snapshot, so an unchanged answer dedupes while a
  different cited expectation produces distinct evidence.
- PubMed `Family Initials` authors compare correctly against Crossref
  `Family, Given` authors (`Doe J` ≡ `Doe, Jane`) instead of being reported as
  a mismatch.
- BibTeX entries written with parentheses (`@article(key, ...)`) terminate at
  the matching `)` and no longer swallow the following entry.
- Benchmark results are published (see README) rather than listed as pending.

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
- 56 tests across HTTP bounds, BibTeX, comparison, verification, runtime and
  tool surface; every provider interaction is scripted (CI is offline).

### Known limitations

- Retraction status is not queried (record-level update notices only).
- OpenAlex is allowlisted but not yet used as a second opinion.
- Benchmark adapter and frozen-fixture results are published in the README;
  the dataset is synthetic and is not a real-world accuracy claim.
