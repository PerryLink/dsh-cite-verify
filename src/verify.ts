/**
 * Citation verification.
 *
 * Resolve identifier → provider record → field checks. The checks are the
 * product: each one names the field, the cited value, the resolved value and a
 * stable verdict. `not_found` is a `skipped` check and leaves the evidence
 * `unchecked` — never "clean", never "fabricated".
 *
 * @module dsh-cite-verify/verify
 */

import { stableId } from '@perrylink/dsh-research-core'
import type { CheckResult, CheckStatus } from '@perrylink/dsh-research-core'
import { authorsOf, parseBibtexEntry, type BibEntry } from './bibtex.ts'
import type { ResponseCache } from './cache.ts'
import { CiteNetworkError, type HttpClient } from './http.ts'
import { compareAuthors, compareTitle, compareVenue, compareYear, normalizeText, similarity } from './match.ts'
import {
  lookupArxiv,
  lookupDoi,
  lookupPmid,
  parseArxiv,
  parseCrossref,
  parsePubmed,
  type CitationRecord,
  type ProviderOutcome,
} from './providers.ts'

/** Stable input failure codes. */
export type CiteInputErrorCode = 'INVALID_INPUT' | 'INVALID_BIBTEX' | 'UNSUPPORTED_IDENTIFIER'

/** A caller mistake (not a verification verdict). */
export class CiteInputError extends Error {
  /** The stable code. */
  readonly code: CiteInputErrorCode

  constructor(code: CiteInputErrorCode, message: string) {
    super(message)
    this.name = 'CiteInputError'
    this.code = code
  }
}

/** What the caller wants verified. */
export interface CitationInput {
  readonly doi?: string
  readonly pmid?: string
  readonly arxiv?: string
  readonly bibtex?: string
  readonly title?: string
  readonly authors?: readonly string[]
  readonly year?: number
  readonly venue?: string
  readonly pages?: string
}

/** A normalized citation after BibTeX expansion. */
export interface NormalizedCitation {
  readonly identifiers: { readonly doi?: string; readonly pmid?: string; readonly arxiv?: string }
  readonly expected: {
    readonly title?: string
    readonly authors: readonly string[]
    readonly year?: number
    readonly venue?: string
    readonly pages?: string
  }
  /** The parsed BibTeX entry, when the input carried one. */
  readonly bibtex?: BibEntry
}

/** Everything verification needs from the outside world. */
export interface VerifyDeps {
  readonly client: HttpClient
  readonly cache: ResponseCache
  readonly titleThreshold: number
  readonly mailto: string | undefined
  readonly now: () => Date
  /** Bypass the response cache. */
  readonly fresh?: boolean
}

/** A provider response ready to become an evidence snapshot. */
export interface VerificationSnapshot {
  readonly provider: string
  readonly body: string
  readonly mediaType: 'application/json' | 'application/xml'
  readonly url: string
}

/** The resolved record summary returned to the model. */
export interface ResolvedSummary {
  readonly provider: string
  readonly doi?: string
  readonly pmid?: string
  readonly arxiv?: string
  readonly title?: string
  readonly authors: readonly string[]
  readonly year?: number
  readonly venue?: string
  readonly pages?: string
  readonly type?: string
}

/** The result of verifying one citation. */
export interface VerificationOutcome {
  readonly checks: readonly CheckResult[]
  readonly status: 'ok' | 'warn' | 'fail' | 'unchecked'
  readonly resolved?: ResolvedSummary
  readonly snapshot?: VerificationSnapshot
  readonly warnings: readonly string[]
  /** True when no provider returned a record. */
  readonly notFound: boolean
  /** The normalized citation (identifiers + expected fields). */
  readonly normalized: NormalizedCitation
}

const DOI_PATTERN = /^10\.\d{4,9}\/[^\s?#]+$/u
const PMID_PATTERN = /^\d{1,9}$/u
const ARXIV_PATTERN = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d{1,3})?$/u

/** Trim a possibly-empty string. */
function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Validate and normalize a DOI.
 * @param doi - the raw DOI.
 * @returns the DOI without a `https://doi.org/` prefix.
 * @throws CiteInputError when the shape is invalid.
 */
export function normalizeDoi(doi: string): string {
  const stripped = doi.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '')
  if (!DOI_PATTERN.test(stripped)) throw new CiteInputError('INVALID_INPUT', `not a DOI: ${doi}`)
  return stripped
}

/**
 * Validate a PMID.
 * @param pmid - the raw PMID.
 * @returns the digits.
 */
export function normalizePmid(pmid: string): string {
  const stripped = pmid.trim()
  if (!PMID_PATTERN.test(stripped)) throw new CiteInputError('INVALID_INPUT', `not a PMID: ${pmid}`)
  return stripped
}

/**
 * Validate an arXiv id.
 * @param arxiv - the raw id.
 * @returns the id, optionally with a version suffix.
 */
export function normalizeArxiv(arxiv: string): string {
  const stripped = arxiv.trim().replace(/^arxiv:/iu, '').replace(/^https?:\/\/arxiv\.org\/abs\//iu, '')
  if (!ARXIV_PATTERN.test(stripped)) throw new CiteInputError('INVALID_INPUT', `not an arXiv id: ${arxiv}`)
  return stripped
}

/**
 * Expand BibTeX into identifiers and expected metadata.
 * @param bibtex - the BibTeX text.
 * @param input - the explicit fields (they win over BibTeX values).
 * @returns the normalized citation.
 */
export function normalizeCitation(input: CitationInput): NormalizedCitation {
  let entry: BibEntry | undefined
  if (input.bibtex !== undefined) {
    entry = parseBibtexEntry(input.bibtex)
    if (entry === undefined) throw new CiteInputError('INVALID_BIBTEX', 'the bibtex text contains no entry')
  }
  const fields = entry?.fields ?? {}
  const doi = clean(input.doi) ?? clean(fields['doi'])
  const pmid = clean(input.pmid) ?? clean(fields['pmid'])
  const arxiv =
    clean(input.arxiv) ??
    (fields['archiveprefix']?.toLowerCase() === 'arxiv' || fields['eprint'] !== undefined ? clean(fields['eprint']) : undefined)
  const identifiers = {
    ...(doi === undefined ? {} : { doi: normalizeDoi(doi) }),
    ...(pmid === undefined ? {} : { pmid: normalizePmid(pmid) }),
    ...(arxiv === undefined ? {} : { arxiv: normalizeArxiv(arxiv) }),
  }
  if (Object.keys(identifiers).length === 0) {
    throw new CiteInputError(
      'INVALID_INPUT',
      'need at least one identifier (doi, pmid, arxiv or a bibtex entry); title search is out of scope in v0.1',
    )
  }
  const authors = input.authors !== undefined && input.authors.length > 0 ? input.authors : entry === undefined ? [] : authorsOf(fields['author'] ?? '')
  const yearField = entry === undefined ? undefined : /\d{4}/u.exec(fields['year'] ?? fields['date'] ?? '')
  const title = clean(input.title) ?? clean(fields['title'])
  const venue = clean(input.venue) ?? clean(fields['journal']) ?? clean(fields['booktitle'])
  const pages = clean(input.pages) ?? clean(fields['pages'])
  const year = input.year ?? (yearField === null || yearField === undefined ? undefined : Number(yearField[0]))
  return {
    identifiers,
    expected: {
      ...(title === undefined ? {} : { title }),
      authors,
      ...(year === undefined ? {} : { year }),
      ...(venue === undefined ? {} : { venue }),
      ...(pages === undefined ? {} : { pages }),
    },
    ...(entry === undefined ? {} : { bibtex: entry }),
  }
}

/** Build one check. */
function check(
  subject: string,
  kind: CheckResult['check'],
  status: CheckStatus,
  detail: string,
  options: {
    code?: CheckResult['code']
    severity?: CheckResult['severity']
    expected?: unknown
    actual?: unknown
    locator?: CheckResult['locator']
    /** Machine-readable field key encoded into checkId (`chk-<key>-<hash>`). */
    key?: string
  } = {},
): CheckResult {
  const digest = stableId('chk', [subject, kind, options.expected ?? '', status]).slice(-6)
  return {
    checkId: `chk-${options.key ?? kind}-${digest}`,
    check: kind,
    status,
    detail,
    ...(options.code === undefined ? {} : { code: options.code }),
    severity: options.severity ?? (status === 'fail' ? 'error' : status === 'warn' ? 'warning' : 'info'),
    ...(options.expected === undefined ? {} : { expected: options.expected }),
    ...(options.actual === undefined ? {} : { actual: options.actual }),
    ...(options.locator === undefined ? {} : { locator: options.locator }),
  }
}

/** Derive the evidence status from checks (the core rule, local copy). */
function statusOf(checks: readonly CheckResult[]): VerificationOutcome['status'] {
  if (checks.some(item => item.status === 'fail')) return 'fail'
  if (checks.some(item => item.status === 'warn')) return 'warn'
  if (checks.some(item => item.status === 'pass')) return 'ok'
  return 'unchecked'
}

/** Fetch one provider response (cache aware). */
async function fetchOutcome(
  lookup: { provider: string; identifier: string; url: string; parse: (body: string) => CitationRecord; mediaType: 'application/json' | 'application/xml'; run: () => Promise<ProviderOutcome> },
  deps: VerifyDeps,
): Promise<ProviderOutcome> {
  const key = `${lookup.provider}:${lookup.identifier}`
  if (deps.fresh !== true) {
    const cached = await deps.cache.get(key)
    if (cached !== undefined) {
      if (cached.status === 404) return { kind: 'not_found', url: cached.url }
      return { kind: 'found', record: lookup.parse(cached.body), body: cached.body, mediaType: lookup.mediaType, url: cached.url }
    }
  }
  const outcome = await lookup.run()
  await deps.cache.put(key, {
    provider: lookup.provider,
    at: deps.now().getTime(),
    url: outcome.kind === 'found' ? outcome.url : outcome.url,
    status: outcome.kind === 'found' ? 200 : 404,
    body: outcome.kind === 'found' ? outcome.body : '',
    contentType: outcome.kind === 'found' ? outcome.mediaType : '',
  })
  return outcome
}

/** Convert one provider record into the returned summary. */
function summaryOf(record: CitationRecord): ResolvedSummary {
  return {
    provider: record.provider,
    ...record.identifiers,
    ...(record.title === undefined ? {} : { title: record.title }),
    authors: record.authors,
    ...(record.year === undefined ? {} : { year: record.year }),
    ...(record.venue === undefined ? {} : { venue: record.venue }),
    ...(record.pages === undefined ? {} : { pages: record.pages }),
    ...(record.type === undefined ? {} : { type: record.type }),
  }
}

/** Map a transport/parse failure to a skipped check. */
function failureCheck(subject: string, kind: CheckResult['check'], error: unknown): CheckResult {
  if (error instanceof CiteNetworkError) {
    const code = error.code === 'timeout' ? 'unavailable' : error.status === 429 ? 'rate_limited' : 'network_error'
    return check(subject, kind, 'skipped', `${error.message}; the citation could not be checked (this is not a verdict about the work)`, {
      code,
      severity: 'warning',
    })
  }
  return check(subject, kind, 'skipped', `lookup failed: ${(error as Error).message}`, { code: 'parse_failed', severity: 'warning' })
}

/**
 * Verify one citation.
 * @param input - identifiers and/or BibTeX plus optional expected fields.
 * @param deps - client, cache, thresholds and clock.
 * @returns the checks, status and the snapshot to store as evidence.
 * @throws CiteInputError on invalid input.
 */
export async function verifyCitation(input: CitationInput, deps: VerifyDeps): Promise<VerificationOutcome> {
  const citation = normalizeCitation(input)
  const checks: CheckResult[] = []
  const warnings: string[] = []
  const { identifiers, expected } = citation
  const subject = identifiers.doi ?? identifiers.pmid ?? identifiers.arxiv!
  const lookups: Array<{
    provider: string
    identifier: string
    kind: CheckResult['check']
    run: () => Promise<ProviderOutcome>
    parse: (body: string) => CitationRecord
    mediaType: 'application/json' | 'application/xml'
  }> = []
  if (identifiers.doi !== undefined) {
    const doi = identifiers.doi
    lookups.push({
      provider: 'crossref',
      identifier: doi,
      kind: 'doi-exists',
      run: () => lookupDoi(deps.client, doi),
      parse: body => parseCrossref(body, doi),
      mediaType: 'application/json',
    })
  }
  if (identifiers.pmid !== undefined) {
    const pmid = identifiers.pmid
    lookups.push({
      provider: 'pubmed',
      identifier: pmid,
      kind: 'other',
      run: () => lookupPmid(deps.client, pmid, deps.mailto),
      parse: body => parsePubmed(body, pmid),
      mediaType: 'application/json',
    })
  }
  if (identifiers.arxiv !== undefined) {
    const arxiv = identifiers.arxiv
    lookups.push({
      provider: 'arxiv',
      identifier: arxiv,
      kind: 'other',
      run: () => lookupArxiv(deps.client, arxiv),
      parse: body => parseArxiv(body, arxiv),
      mediaType: 'application/xml',
    })
  }
  if (lookups.length > 2) {
    warnings.push('more than two identifiers were given; only the first two were resolved')
    lookups.length = 2
  }

  let primary: CitationRecord | undefined
  let snapshot: VerificationSnapshot | undefined
  const records: CitationRecord[] = []
  for (const lookup of lookups) {
    let outcome: ProviderOutcome
    try {
      outcome = await fetchOutcome({ ...lookup, url: '' }, deps)
    } catch (error) {
      checks.push(failureCheck(subject, lookup.kind, error))
      continue
    }
    if (outcome.kind === 'not_found') {
      checks.push(
        check(
          subject,
          lookup.kind,
          'skipped',
          `${lookup.provider} returned no record for ${lookup.identifier}; not_found is not evidence of fabrication and not evidence of cleanliness`,
          { code: 'not_found', expected: { provider: lookup.provider, identifier: lookup.identifier }, key: lookup.provider },
        ),
      )
      continue
    }
    records.push(outcome.record)
    if (primary === undefined) {
      primary = outcome.record
      snapshot = { provider: outcome.record.provider, body: outcome.body, mediaType: outcome.mediaType, url: outcome.url }
    }
    checks.push(
      check(
        subject,
        lookup.kind,
        'pass',
        `${lookup.provider} resolved ${lookup.identifier}` +
          (outcome.record.identifiers.doi === undefined ? '' : ` (DOI ${outcome.record.identifiers.doi})`),
        { expected: { provider: lookup.provider, identifier: lookup.identifier }, actual: { doi: outcome.record.identifiers.doi }, key: lookup.provider },
      ),
    )
  }

  if (primary === undefined) {
    return { checks, status: 'unchecked', warnings, notFound: true, normalized: citation }
  }

  const resolved = summaryOf(primary)
  if (expected.title !== undefined && primary.title !== undefined) {
    const comparison = compareTitle(expected.title, primary.title, deps.titleThreshold)
    checks.push(
      check(
        subject,
        'metadata-match',
        comparison.matched ? 'pass' : 'fail',
        comparison.matched
          ? `title matches (similarity ${comparison.similarity})`
          : `title differs (similarity ${comparison.similarity}); cited "${expected.title}" but the record says "${primary.title}"`,
        { expected: expected.title, actual: primary.title, key: 'title' },
      ),
    )
  }
  if (expected.authors.length > 0 && primary.authors.length > 0) {
    const comparison = compareAuthors(expected.authors, primary.authors)
    const status: CheckStatus = comparison.missing.length === 0 ? 'pass' : comparison.ratio >= 0.5 ? 'warn' : 'fail'
    checks.push(
      check(
        subject,
        'metadata-match',
        status,
        status === 'pass'
          ? `authors match (${comparison.matched.join(', ')})`
          : `author mismatch: missing ${comparison.missing.join(', ') || '(none)'}; record has ${primary.authors.join('; ')}`,
        { expected: expected.authors, actual: primary.authors, key: 'authors' },
      ),
    )
  }
  if (expected.year !== undefined && primary.year !== undefined) {
    const comparison = compareYear(expected.year, primary.year)
    const status: CheckStatus = comparison === 'match' ? 'pass' : comparison === 'near' ? 'warn' : 'fail'
    checks.push(
      check(subject, 'metadata-match', status, `year: cited ${expected.year}, record ${primary.year} (${comparison})`, {
        expected: expected.year,
        actual: primary.year,
        key: 'year',
      }),
    )
  }
  if (expected.venue !== undefined && primary.venue !== undefined) {
    const comparison = compareVenue(expected.venue, primary.venue)
    checks.push(
      check(
        subject,
        'metadata-match',
        comparison.matched ? 'pass' : 'warn',
        comparison.matched
          ? `venue matches (similarity ${comparison.similarity})`
          : `venue differs (similarity ${comparison.similarity}): cited "${expected.venue}", record "${primary.venue}"`,
        { expected: expected.venue, actual: primary.venue, key: 'venue' },
      ),
    )
  }
  if (expected.pages !== undefined && primary.pages !== undefined) {
    const same = normalizeText(expected.pages) === normalizeText(primary.pages)
    checks.push(
      check(subject, 'metadata-match', same ? 'pass' : 'warn', `pages: cited ${expected.pages}, record ${primary.pages}`, {
        expected: expected.pages,
        actual: primary.pages,
        key: 'pages',
      }),
    )
  }
  if (records.length > 1) {
    const first = records[0]!
    const second = records[1]!
    if (first.title !== undefined && second.title !== undefined) {
      const value = similarity(first.title, second.title)
      checks.push(
        check(subject, 'version-match', value >= deps.titleThreshold ? 'pass' : 'warn', `two sources agree on the title (similarity ${value.toFixed(4)})`, {
          expected: { provider: first.provider, title: first.title },
          actual: { provider: second.provider, title: second.title },
          key: 'version',
        }),
      )
    }
  }
  if (primary.updates !== undefined && primary.updates.length > 0) {
    checks.push(
      check(
        subject,
        'retraction',
        'warn',
        `this record carries update notices (${primary.updates.map(update => update.type).join(', ')}); whether the cited work itself is retracted needs dsh-retraction-watch (v0.1 does not query retraction status)`,
        { actual: primary.updates, key: 'retraction' },
      ),
    )
  } else {
    warnings.push('retraction status is not checked in v0.1 (record-level update notices only); use dsh-retraction-watch for monitoring')
  }

  const status = statusOf(checks)
  return {
    checks,
    status,
    resolved,
    ...(snapshot === undefined ? {} : { snapshot }),
    warnings,
    notFound: false,
    normalized: citation,
  }
}

/**
 * Build a corrected BibTeX entry from a resolved record, preserving the key and
 * unknown fields of the input entry.
 * @param original - the input entry (may be undefined).
 * @param resolved - the resolved record.
 * @param fallbackKey - key to use when the input had none.
 * @returns the BibTeX text.
 */
export function correctedBibtex(
  original: BibEntry | undefined,
  resolved: ResolvedSummary,
  fallbackKey: string,
): { bibtex: string; diffs: Array<{ field: string; before?: string; after?: string }> } {
  const diffs: Array<{ field: string; before?: string; after?: string }> = []
  const fields: Record<string, string> = { ...(original?.fields ?? {}) }
  const set = (name: string, value: string | undefined): void => {
    if (value === undefined) return
    const before = fields[name]
    if (before !== value) diffs.push({ field: name, before: before ?? '', after: value })
    fields[name] = value
  }
  set('title', resolved.title)
  if (resolved.authors.length > 0) set('author', resolved.authors.join(' and '))
  if (resolved.year !== undefined) set('year', String(resolved.year))
  set('journal', resolved.venue)
  set('pages', resolved.pages)
  if (resolved.doi !== undefined) set('doi', resolved.doi)
  if (resolved.arxiv !== undefined) set('eprint', resolved.arxiv)
  const type = original?.type ?? (resolved.type === 'book' ? 'book' : 'article')
  const key = original?.key ?? fallbackKey
  const lines = [`@${type}{${key},`]
  for (const [name, value] of Object.entries(fields)) lines.push(`  ${name} = {${value}},`)
  lines.push('}')
  return { bibtex: lines.join('\n'), diffs }
}
