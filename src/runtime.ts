/**
 * The verification runtime: wires the bounded client, the cache, the providers
 * and the REP store into the three tools.
 *
 * Evidence is a content-addressed snapshot of the provider's own response, so a
 * later reviewer can re-read exactly what Crossref/PubMed/arXiv said instead of
 * trusting this plugin's summary.
 *
 * @module dsh-cite-verify/runtime
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  EvidenceStore,
  RepStoreError,
  stableId,
  validateRep,
  type AddEvidenceInput,
  type Anchor,
  type CaptureInput,
  type CheckResult,
  type Evidence,
  type HashRef,
  type ResearchRecord,
  type Snapshot,
} from '@perrylink/dsh-research-core'
import { ResponseCache } from './cache.ts'
import type { ResolvedConfig } from './config.ts'
import { createHttpClient, type HttpClient } from './http.ts'
import { parseBibtexEntry } from './bibtex.ts'
import {
  CiteInputError,
  correctedBibtex,
  verifyCitation,
  type CitationInput,
  type ResolvedSummary,
  type VerificationOutcome,
} from './verify.ts'
import { VERSION } from './version.ts'

/** Stable runtime error codes (tool failures). */
export type CiteVerifyErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_BIBTEX'
  | 'UNSUPPORTED_IDENTIFIER'
  | 'STORE_ERROR'
  | 'BATCH_TOO_LARGE'

/** A typed failure with a stable code. */
export class CiteVerifyError extends Error {
  /** The stable code. */
  readonly code: CiteVerifyErrorCode

  constructor(code: CiteVerifyErrorCode, message: string) {
    super(message)
    this.name = 'CiteVerifyError'
    this.code = code
  }
}

/** The subset of the REP service this plugin needs. */
export interface EvidencePort {
  capture(input: CaptureInput): Promise<{ snapshot: Snapshot }>
  addEvidence(input: AddEvidenceInput): Promise<{ evidence: Evidence }>
  getEvidence(evidenceId: string): Promise<Evidence | undefined>
  getSnapshot(snapshotId: HashRef): Promise<{ snapshot: Snapshot; bytes: Uint8Array } | undefined>
  buildRecord(options?: { evidenceIds?: readonly string[] }): Promise<Omit<ResearchRecord, 'manifest'>>
}

/** One verified citation returned to the model. */
export interface CiteVerifyResult {
  readonly ok: true
  readonly status: VerificationOutcome['status']
  readonly notFound: boolean
  readonly resolved?: ResolvedSummary
  readonly checks: readonly CheckResult[]
  readonly evidenceId?: string
  readonly recordPath?: string
  readonly warnings: readonly string[]
}

/** One item of a batch result. */
export interface CiteBatchItem {
  readonly index: number
  readonly input: string
  readonly ok: boolean
  readonly status?: VerificationOutcome['status']
  readonly evidenceId?: string
  readonly error?: { readonly code: string; readonly message: string }
}

/** The batch result. */
export interface CiteBatchResult {
  readonly ok: true
  readonly count: number
  readonly items: readonly CiteBatchItem[]
  readonly warnings: readonly string[]
}

/** The `cite_fix` result. */
export interface CiteFixResult {
  readonly ok: true
  readonly bibtex: string
  readonly diffs: readonly { readonly field: string; readonly before?: string; readonly after?: string }[]
  readonly status: VerificationOutcome['status']
  readonly evidenceId?: string
  readonly warnings: readonly string[]
}

/** Options for {@link CiteVerifyRuntime}. */
export interface CiteVerifyRuntimeOptions {
  readonly config: ResolvedConfig
  /** The mounted REP service, when any. */
  readonly service?: EvidencePort
  /** Injected HTTP client (tests). */
  readonly client?: HttpClient
  /** Injected cache (tests). */
  readonly cache?: ResponseCache
  readonly now?: () => Date
}

/** Extract the canonical duplicate key of one citation. */
function citationKey(input: CitationInput): string {
  if (input.doi !== undefined) return `doi:${input.doi.toLowerCase()}`
  if (input.pmid !== undefined) return `pmid:${input.pmid}`
  if (input.arxiv !== undefined) return `arxiv:${input.arxiv.toLowerCase()}`
  if (input.bibtex !== undefined) return `bibtex:${input.bibtex.slice(0, 64)}`
  return 'unknown'
}

/**
 * Parse one batch token.
 *
 * Accepted forms: `doi:10...`, `pmid:123`, `arxiv:2401.00001`, `@article{...}`
 * or a bare identifier (DOI, PMID or arXiv id, detected by shape).
 * @param token - one citation string.
 * @returns the citation input.
 */
export function parseCitationToken(token: string): CitationInput {
  const trimmed = token.trim()
  if (trimmed === '') throw new CiteVerifyError('INVALID_INPUT', 'empty citation')
  if (trimmed.startsWith('@')) return { bibtex: trimmed }
  const prefixed = /^(doi|pmid|arxiv)\s*:\s*(.+)$/iu.exec(trimmed)
  if (prefixed !== null) {
    const kind = prefixed[1]!.toLowerCase()
    const value = prefixed[2]!.trim()
    if (kind === 'doi') return { doi: value }
    if (kind === 'pmid') return { pmid: value }
    return { arxiv: value }
  }
  if (/^10\.\d{4,9}\//u.test(trimmed)) return { doi: trimmed }
  if (/^\d{1,9}$/u.test(trimmed)) return { pmid: trimmed }
  if (/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d{1,3})?$/u.test(trimmed)) return { arxiv: trimmed }
  throw new CiteVerifyError('UNSUPPORTED_IDENTIFIER', `cannot tell what identifier this is: ${trimmed}`)
}

/** Build field anchors over a provider response snapshot. */
export function buildFieldAnchors(resolved: ResolvedSummary, snapshotId: HashRef): Anchor[] {
  const anchors: Anchor[] = []
  const add = (field: string, quote?: string): void => {
    anchors.push({ snapshotId, kind: 'record', value: `field:${field}`, ...(quote === undefined ? {} : { quote }) })
  }
  if (resolved.doi !== undefined) add('DOI', resolved.doi)
  if (resolved.title !== undefined) add('title', resolved.title)
  if (resolved.authors[0] !== undefined) add('author', resolved.authors[0])
  if (resolved.year !== undefined) add('issued')
  if (resolved.venue !== undefined) add('container-title', resolved.venue)
  if (anchors.length === 0) add('message')
  return anchors
}

/** Fallback BibTeX key from a resolved record. */
function fallbackKey(resolved: ResolvedSummary): string {
  const family = resolved.authors[0]?.split(',')[0]?.trim() ?? 'citation'
  const slug = family.toLowerCase().replace(/[^a-z0-9]+/gu, '') || 'citation'
  return `${slug}${resolved.year ?? ''}`
}

/** The verification runtime. */
export class CiteVerifyRuntime {
  readonly config: ResolvedConfig

  readonly #service: EvidencePort | undefined
  readonly #client: HttpClient
  readonly #cache: ResponseCache
  readonly #now: () => Date
  #store: EvidenceStore | undefined

  constructor(options: CiteVerifyRuntimeOptions) {
    this.config = options.config
    this.#service = options.service
    this.#now = options.now ?? (() => new Date())
    this.#client =
      options.client ??
      createHttpClient({
        timeoutMs: options.config.timeoutMs,
        minIntervalMs: options.config.minIntervalMs,
        retries: options.config.retries,
        maxRedirects: options.config.maxRedirects,
        userAgent: options.config.userAgent,
        now: () => this.#now().getTime(),
      })
    this.#cache = options.cache ?? new ResponseCache(path.join(options.config.root, 'cache'), options.config.cacheTtlMs, () => this.#now().getTime())
  }

  /** Current ISO timestamp. */
  iso(): string {
    return this.#now().toISOString()
  }

  /** The evidence port (mounted service, else a local core store). */
  port(): EvidencePort {
    if (this.#service !== undefined) return this.#service
    this.#store ??= new EvidenceStore(path.join(this.config.root, 'store'))
    return this.#store
  }

  /** Store the provider response and register the evidence item. */
  async #storeEvidence(outcome: VerificationOutcome, resolved: ResolvedSummary, input: CitationInput): Promise<{ evidenceId: string; recordPath?: string }> {
    const snapshot = outcome.snapshot
    if (snapshot === undefined) return { evidenceId: '' }
    const kind = resolved.doi !== undefined ? ('doi' as const) : resolved.pmid !== undefined ? ('pmid' as const) : ('arxiv' as const)
    const sourceRef = {
      kind,
      id: resolved.doi ?? resolved.pmid ?? resolved.arxiv ?? input.doi ?? input.pmid ?? input.arxiv ?? 'citation',
      url: snapshot.url,
      retrievedAt: this.iso(),
      metadata: {
        ...(resolved.title === undefined ? {} : { title: resolved.title }),
        ...(resolved.authors.length === 0 ? {} : { authors: [...resolved.authors] }),
        ...(resolved.year === undefined ? {} : { year: resolved.year }),
        ...(resolved.venue === undefined ? {} : { containerTitle: resolved.venue }),
        ...(resolved.pages === undefined ? {} : { pages: resolved.pages }),
      },
    }
    const port = this.port()
    let evidence: Evidence
    try {
      const captured = await port.capture({
        bytes: snapshot.body,
        mediaType: snapshot.mediaType,
        sourceRef,
        capturedAt: this.iso(),
      })
      // Re-verifying the same answer must dedupe, not conflict: the evidence
      // records the immutable snapshot's capture time and the checks themselves
      // are part of its identity, so a different expectation is different
      // evidence instead of an EVIDENCE_CONFLICT.
      const evidenceSourceRef = {
        ...sourceRef,
        retrievedAt: captured.snapshot.capturedAt,
      }
      evidence = (
        await port.addEvidence({
          evidenceId: stableId('ev', [
            'cite-verify',
            sourceRef.kind,
            sourceRef.id,
            captured.snapshot.snapshotId,
            outcome.status,
            ...outcome.checks.map(item => item.checkId),
          ]),
          title: resolved.title ?? `${snapshot.provider} record for ${sourceRef.id}`,
          sourceRef: evidenceSourceRef,
          snapshotIds: [captured.snapshot.snapshotId],
          anchors: buildFieldAnchors(resolved, captured.snapshot.snapshotId),
          provenance: {
            plugin: 'dsh-cite-verify',
            version: VERSION,
            method: `lookup:${snapshot.provider}`,
            retrievedAt: captured.snapshot.capturedAt,
          },
          checks: [...outcome.checks],
          notes: `status=${outcome.status}; ${outcome.checks.length} check(s)`,
        })
      ).evidence
    } catch (error) {
      if (error instanceof RepStoreError) throw new CiteVerifyError('STORE_ERROR', error.message)
      throw error
    }

    try {
      const record = await port.buildRecord({ evidenceIds: [evidence.evidenceId] })
      if (!validateRep(record).ok) {
        throw new CiteVerifyError('STORE_ERROR', 'refusing to write an invalid REP record')
      }
      const directory = path.join(this.config.root, 'records')
      await mkdir(directory, { recursive: true })
      const file = path.join(directory, `${evidence.evidenceId}.rep.json`)
      await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      return { evidenceId: evidence.evidenceId, recordPath: file }
    } catch (error) {
      if (error instanceof CiteVerifyError) throw error
      throw new CiteVerifyError('STORE_ERROR', `could not write the REP record: ${(error as Error).message}`)
    }
  }

  /**
   * Verify one citation end to end.
   * @param input - identifiers / BibTeX / expected fields.
   * @param options - `fresh` bypasses the cache.
   * @returns the result (evidence registered when a record was found).
   */
  async verify(input: CitationInput, options: { fresh?: boolean } = {}): Promise<CiteVerifyResult> {
    let outcome: VerificationOutcome
    try {
      outcome = await verifyCitation(input, {
        client: this.#client,
        cache: this.#cache,
        titleThreshold: this.config.titleThreshold,
        mailto: this.config.mailto,
        now: this.#now,
        ...(options.fresh === true ? { fresh: true } : {}),
      })
    } catch (error) {
      if (error instanceof CiteInputError) throw new CiteVerifyError(error.code, error.message)
      throw error
    }
    const base = {
      ok: true as const,
      status: outcome.status,
      notFound: outcome.notFound,
      checks: outcome.checks,
      warnings: outcome.warnings,
      ...(outcome.resolved === undefined ? {} : { resolved: outcome.resolved }),
    }
    if (outcome.resolved === undefined) return base
    const stored = await this.#storeEvidence(outcome, outcome.resolved, input)
    return {
      ...base,
      ...(stored.evidenceId === '' ? {} : { evidenceId: stored.evidenceId }),
      ...(stored.recordPath === undefined ? {} : { recordPath: stored.recordPath }),
    }
  }

  /**
   * Verify many citations with bounded concurrency and duplicate detection.
   * @param citations - identifier strings or BibTeX entries.
   * @param options - `fresh` bypasses the cache.
   * @returns per-item results.
   */
  async batch(citations: readonly string[], options: { fresh?: boolean } = {}): Promise<CiteBatchResult> {
    if (citations.length === 0) throw new CiteVerifyError('INVALID_INPUT', 'citations must not be empty')
    if (citations.length > this.config.maxBatch) {
      throw new CiteVerifyError('BATCH_TOO_LARGE', `${citations.length} citations exceed the batch cap of ${this.config.maxBatch}`)
    }
    const seen = new Map<string, number>()
    const items: CiteBatchItem[] = []
    for (let index = 0; index < citations.length; index += 1) {
      items.push({ index, input: citations[index]!, ok: false })
    }
    // A bad token fails only its own item: one broken citation never fails the batch.
    const parsed: Array<{ index: number; input: CitationInput }> = []
    for (const [index, token] of citations.entries()) {
      try {
        parsed.push({ index, input: parseCitationToken(token) })
      } catch (error) {
        const code = error instanceof CiteVerifyError ? error.code : 'INVALID_INPUT'
        items[index] = { index, input: token, ok: false, error: { code, message: (error as Error).message } }
      }
    }
    for (let start = 0; start < parsed.length; start += this.config.batchConcurrency) {
      const chunk = parsed.slice(start, start + this.config.batchConcurrency)
      const results = await Promise.all(
        chunk.map(async ({ index, input }) => {
          try {
            const result = await this.verify(input, options)
            return { index, result }
          } catch (error) {
            if (error instanceof CiteVerifyError || error instanceof CiteInputError) {
              return { index, result: { ok: false as const, code: error.code, message: error.message } }
            }
            return { index, result: { ok: false as const, code: 'INVALID_INPUT', message: (error as Error).message } }
          }
        }),
      )
      for (const { index, result } of results) {
        if (result.ok) {
          const item: CiteBatchItem = {
            index,
            input: citations[index]!,
            ok: true,
            status: result.status,
            ...(result.evidenceId === undefined ? {} : { evidenceId: result.evidenceId }),
          }
          items[index] = item
        } else {
          items[index] = {
            index,
            input: citations[index]!,
            ok: false,
            error: { code: result.code, message: result.message },
          }
        }
      }
    }
    for (const { index, input } of parsed) {
      const key = citationKey(input)
      const first = seen.get(key)
      if (first === undefined) {
        seen.set(key, index)
        continue
      }
      const item = items[index]!
      if (item.ok) items[index] = { ...item, status: 'warn' }
    }
    const warnings: string[] = []
    const duplicates = parsed.length - seen.size
    if (duplicates > 0) warnings.push(`${duplicates} duplicate citation(s) were repeated in the batch`)
    return { ok: true, count: items.length, items, warnings }
  }

  /**
   * Produce a corrected BibTeX entry (never writes to a file).
   * @param input - the citation.
   * @param options - `fresh` bypasses the cache.
   * @returns the corrected BibTeX, the field diffs and the verification status.
   */
  async fix(input: CitationInput, options: { fresh?: boolean } = {}): Promise<CiteFixResult> {
    const result = await this.verify(input, options)
    if (result.resolved === undefined) {
      return { ok: true, bibtex: '', diffs: [], status: result.status, warnings: [...result.warnings, 'no record was resolved, so nothing could be corrected'] }
    }
    const corrected = correctedBibtex(input.bibtex === undefined ? undefined : parseBibtexEntry(input.bibtex), result.resolved, fallbackKey(result.resolved))
    return {
      ok: true,
      bibtex: corrected.bibtex,
      diffs: corrected.diffs,
      status: result.status,
      ...(result.evidenceId === undefined ? {} : { evidenceId: result.evidenceId }),
      warnings: result.warnings,
    }
  }
}
