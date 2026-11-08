/**
 * Metadata providers: Crossref (DOI), PubMed E-utilities (PMID) and arXiv
 * (Atom API).
 *
 * Each provider returns either a normalized record plus the exact response
 * bytes (so the evidence snapshot is the provider's own answer) or an explicit
 * `not_found`. Transport failures are thrown as {@link CiteNetworkError}.
 *
 * @module dsh-cite-verify/providers
 */

import { CiteNetworkError, type HttpClient } from './http.ts'

/** A normalized bibliographic record. */
export interface CitationRecord {
  readonly provider: 'crossref' | 'pubmed' | 'arxiv'
  readonly identifiers: {
    readonly doi?: string
    readonly pmid?: string
    readonly arxiv?: string
  }
  readonly title?: string
  readonly authors: readonly string[]
  readonly year?: number
  readonly venue?: string
  readonly volume?: string
  readonly issue?: string
  readonly pages?: string
  readonly publisher?: string
  readonly type?: string
  /** Update notices attached to this record (retraction, correction, …). */
  readonly updates?: readonly { readonly type: string; readonly doi?: string; readonly title?: string }[]
}

/** The result of one provider lookup. */
export type ProviderOutcome =
  | {
      readonly kind: 'found'
      readonly record: CitationRecord
      readonly body: string
      readonly mediaType: 'application/json' | 'application/xml'
      readonly url: string
    }
  | { readonly kind: 'not_found'; readonly url: string }

/** Decode the five XML entities publishers actually use. */
export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_whole, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/gu, (_whole, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/gu, '&')
}

/** Read the first regex group, trimmed, if present. */
function first(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text)
  return match?.[1]?.trim()
}

/** Join a Crossref author into `Family, Given`. */
function crossrefAuthor(author: Record<string, unknown>): string | undefined {
  const family = typeof author['family'] === 'string' ? author['family'] : undefined
  const given = typeof author['given'] === 'string' ? author['given'] : undefined
  if (family !== undefined && given !== undefined) return `${family}, ${given}`
  if (family !== undefined) return family
  return typeof author['name'] === 'string' ? author['name'] : undefined
}

/**
 * Parse a Crossref `works/{doi}` response.
 * @param body - the JSON body.
 * @param doi - the DOI that was requested.
 * @returns the normalized record.
 * @throws Error when the body is not a Crossref work.
 */
export function parseCrossref(body: string, doi: string): CitationRecord {
  const parsed = JSON.parse(body) as { message?: Record<string, unknown> }
  const message = parsed.message
  if (message === undefined) throw new Error('Crossref response has no message')
  const titles = message['title']
  const authors = Array.isArray(message['author']) ? (message['author'] as Record<string, unknown>[]) : []
  const issued = message['issued'] as { 'date-parts'?: number[][] } | undefined
  const updateTo = Array.isArray(message['update-to']) ? (message['update-to'] as Record<string, unknown>[]) : []
  const container = message['container-title']
  return {
    provider: 'crossref',
    identifiers: { doi: typeof message['DOI'] === 'string' ? message['DOI'] : doi },
    ...(Array.isArray(titles) && typeof titles[0] === 'string' ? { title: titles[0] } : {}),
    authors: authors.map(crossrefAuthor).filter((name): name is string => name !== undefined),
    ...(issued?.['date-parts']?.[0]?.[0] === undefined ? {} : { year: issued['date-parts'][0]![0] }),
    ...(Array.isArray(container) && typeof container[0] === 'string' ? { venue: container[0] } : {}),
    ...(typeof message['volume'] === 'string' ? { volume: message['volume'] } : {}),
    ...(typeof message['issue'] === 'string' ? { issue: message['issue'] } : {}),
    ...(typeof message['page'] === 'string' ? { pages: message['page'] } : {}),
    ...(typeof message['publisher'] === 'string' ? { publisher: message['publisher'] } : {}),
    ...(typeof message['type'] === 'string' ? { type: message['type'] } : {}),
    ...(updateTo.length === 0
      ? {}
      : {
          updates: updateTo.map(update => ({
            type: typeof update['type'] === 'string' ? update['type'] : 'unknown',
            ...(typeof update['DOI'] === 'string' ? { doi: update['DOI'] } : {}),
            ...(typeof update['label'] === 'string' ? { title: update['label'] } : {}),
          })),
        }),
  }
}

/**
 * Parse a PubMed esummary response.
 * @param body - the JSON body.
 * @param pmid - the requested PMID.
 * @returns the normalized record.
 */
export function parsePubmed(body: string, pmid: string): CitationRecord {
  const parsed = JSON.parse(body) as { result?: Record<string, unknown> }
  const entry = parsed.result?.[pmid]
  if (entry === undefined || typeof entry !== 'object') throw new Error(`PubMed response has no record for ${pmid}`)
  const item = entry as Record<string, unknown>
  const authors = Array.isArray(item['authors']) ? (item['authors'] as Record<string, unknown>[]) : []
  const articleIds = Array.isArray(item['articleids']) ? (item['articleids'] as Record<string, unknown>[]) : []
  const doi = articleIds.find(identifier => identifier['idtype'] === 'doi' && typeof identifier['value'] === 'string')
  const pubdate = typeof item['pubdate'] === 'string' ? item['pubdate'] : ''
  const yearMatch = /\d{4}/u.exec(pubdate)
  return {
    provider: 'pubmed',
    identifiers: {
      pmid,
      ...(typeof doi?.['value'] === 'string' ? { doi: doi['value'] } : {}),
    },
    ...(typeof item['title'] === 'string' ? { title: item['title'].replace(/<[^>]+>/gu, '').replace(/\.$/u, '') } : {}),
    authors: authors
      .map(author => (typeof author['name'] === 'string' ? author['name'].replace(/\s+/gu, ' ').trim() : undefined))
      .filter((name): name is string => name !== undefined),
    ...(yearMatch === null ? {} : { year: Number(yearMatch[0]) }),
    ...(typeof item['fulljournalname'] === 'string'
      ? { venue: item['fulljournalname'] }
      : typeof item['source'] === 'string'
        ? { venue: item['source'] }
        : {}),
    ...(typeof item['volume'] === 'string' ? { volume: item['volume'] } : {}),
    ...(typeof item['issue'] === 'string' ? { issue: item['issue'] } : {}),
    ...(typeof item['pages'] === 'string' ? { pages: item['pages'] } : {}),
  }
}

/**
 * Parse an arXiv Atom entry.
 * @param body - the Atom XML.
 * @param arxivId - the requested arXiv id.
 * @returns the normalized record.
 * @throws Error when the feed carries no entry.
 */
export function parseArxiv(body: string, arxivId: string): CitationRecord {
  const entries = [...body.matchAll(/<entry>([\s\S]*?)<\/entry>/gu)]
  const entry = entries.find(candidate => !/Error/iu.test(candidate[1]!.slice(0, 200)))
  if (entry === undefined) throw new Error(`arXiv response has no entry for ${arxivId}`)
  const xml = entry[1]!
  const authorNames = [...xml.matchAll(/<author>\s*<name>([^<]+)<\/name>/gu)].map(match => decodeXmlEntities(match[1]!.trim()))
  const published = first(xml, /<published>([^<]+)<\/published>/u)
  const yearMatch = published === undefined ? null : /\d{4}/u.exec(published)
  const doi = first(xml, /<arxiv:doi[^>]*>([^<]+)<\/arxiv:doi>/u)
  const journalRef = first(xml, /<arxiv:journal_ref[^>]*>([^<]+)<\/arxiv:journal_ref>/u)
  return {
    provider: 'arxiv',
    identifiers: { arxiv: arxivId, ...(doi === undefined ? {} : { doi: decodeXmlEntities(doi) }) },
    ...(first(xml, /<title>([\s\S]*?)<\/title>/u) === undefined
      ? {}
      : { title: decodeXmlEntities(first(xml, /<title>([\s\S]*?)<\/title>/u)!).replace(/\s+/gu, ' ').trim() }),
    authors: authorNames,
    ...(yearMatch === null ? {} : { year: Number(yearMatch[0]) }),
    ...(journalRef === undefined ? {} : { venue: decodeXmlEntities(journalRef) }),
    type: 'preprint',
  }
}

/**
 * Look up a DOI through Crossref.
 * @param client - the bounded HTTP client.
 * @param doi - a validated DOI.
 * @returns the provider outcome.
 */
export async function lookupDoi(client: HttpClient, doi: string): Promise<ProviderOutcome> {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi).replace(/%2F/gu, '/')}`
  const response = await client.get(url, { accept: 'application/json' })
  if (response.status === 404) return { kind: 'not_found', url }
  if (response.status >= 400) {
    throw new CiteNetworkError('http_error', `Crossref returned HTTP ${response.status} for ${doi}`, response.status)
  }
  return { kind: 'found', record: parseCrossref(response.body, doi), body: response.body, mediaType: 'application/json', url: response.url }
}

/**
 * Look up a PMID through PubMed E-utilities.
 * @param client - the bounded HTTP client.
 * @param pmid - a validated PMID.
 * @param mailto - optional contact address.
 * @returns the provider outcome.
 */
export async function lookupPmid(client: HttpClient, pmid: string, mailto?: string): Promise<ProviderOutcome> {
  const query = new URLSearchParams({ db: 'pubmed', id: pmid, retmode: 'json' })
  if (mailto !== undefined) {
    query.set('tool', 'dsh-cite-verify')
    query.set('email', mailto)
  }
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${query.toString()}`
  const response = await client.get(url, { accept: 'application/json' })
  if (response.status === 404) return { kind: 'not_found', url }
  if (response.status >= 400) {
    throw new CiteNetworkError('http_error', `PubMed returned HTTP ${response.status} for PMID ${pmid}`, response.status)
  }
  const parsed = JSON.parse(response.body) as { result?: Record<string, unknown>; error?: string }
  const entry = parsed.result?.[pmid]
  if (entry === undefined || (typeof entry === 'object' && 'error' in (entry as Record<string, unknown>))) {
    return { kind: 'not_found', url }
  }
  return { kind: 'found', record: parsePubmed(response.body, pmid), body: response.body, mediaType: 'application/json', url: response.url }
}

/**
 * Look up an arXiv id through the Atom API.
 * @param client - the bounded HTTP client.
 * @param arxivId - a validated arXiv id.
 * @returns the provider outcome.
 */
export async function lookupArxiv(client: HttpClient, arxivId: string): Promise<ProviderOutcome> {
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}&max_results=1`
  const response = await client.get(url, { accept: 'application/atom+xml' })
  if (response.status === 404) return { kind: 'not_found', url }
  if (response.status >= 400) {
    throw new CiteNetworkError('http_error', `arXiv returned HTTP ${response.status} for ${arxivId}`, response.status)
  }
  try {
    return { kind: 'found', record: parseArxiv(response.body, arxivId), body: response.body, mediaType: 'application/xml', url: response.url }
  } catch {
    return { kind: 'not_found', url }
  }
}
