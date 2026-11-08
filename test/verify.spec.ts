/**
 * Citation verification against scripted provider responses. No network.
 * @module test/verify.spec
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ResponseCache } from '../src/cache.ts'
import { CiteNetworkError } from '../src/http.ts'
import { CiteInputError, verifyCitation, type CitationInput, type VerifyDeps } from '../src/verify.ts'
import { fixture, scriptedClient, type Route } from './helpers.ts'

const AT = new Date('2026-04-01T12:00:00.000Z')
let cacheRoot: string

beforeEach(async () => {
  cacheRoot = await mkdtemp(path.join(tmpdir(), 'cite-verify-cache-'))
})

afterEach(async () => {
  if (cacheRoot.startsWith(tmpdir())) await rm(cacheRoot, { recursive: true, force: true })
})

/** Build deps over a route table. */
async function deps(routes: Route[], options: { fail?: Error; fresh?: boolean; now?: Date } = {}): Promise<VerifyDeps & { calls: string[] }> {
  const scripted = scriptedClient(routes, options.fail === undefined ? {} : { fail: options.fail })
  const cache = new ResponseCache(cacheRoot, 7 * 24 * 60 * 60 * 1000, () => (options.now ?? AT).getTime())
  return {
    client: scripted.client,
    cache,
    titleThreshold: 0.85,
    mailto: undefined,
    now: () => options.now ?? AT,
    ...(options.fresh === true ? { fresh: true } : {}),
    calls: scripted.calls,
  }
}

/** Crossref routes for the happy path. */
async function crossrefRoutes(): Promise<Route[]> {
  return [
    { match: 'api.crossref.org/works/10.1000/xyz', body: await fixture('crossref-work.json') },
    { match: 'api.crossref.org/works/10.1000/missing', status: 404, body: '' },
    { match: 'api.crossref.org/works/10.1000/retraction', body: await fixture('crossref-retracted.json') },
    { match: 'eutils.ncbi.nlm.nih.gov', body: await fixture('pubmed-summary.json') },
    { match: 'export.arxiv.org', body: await fixture('arxiv-entry.xml') },
  ]
}

/** The happy-path citation. */
const CITATION: CitationInput = {
  doi: '10.1000/xyz',
  title: 'A study of things',
  authors: ['Doe, Jane', 'Roe, Richard'],
  year: 2020,
  venue: 'Journal of Tests',
}

describe('verifyCitation', () => {
  it('verifies a DOI with matching metadata', async () => {
    const outcome = await verifyCitation(CITATION, await deps(await crossrefRoutes()))
    expect(outcome.status).toBe('ok')
    expect(outcome.notFound).toBe(false)
    expect(outcome.resolved?.provider).toBe('crossref')
    expect(outcome.resolved?.doi).toBe('10.1000/xyz')
    expect(outcome.checks.find(check => check.check === 'doi-exists')?.status).toBe('pass')
    expect(outcome.checks.filter(check => check.check === 'metadata-match').every(check => check.status === 'pass')).toBe(true)
    expect(outcome.snapshot?.provider).toBe('crossref')
    expect(outcome.snapshot?.body).toContain('"DOI"')
  })

  it('fails a title that does not match the record', async () => {
    const outcome = await verifyCitation({ ...CITATION, title: 'A completely different title' }, await deps(await crossrefRoutes()))
    expect(outcome.status).toBe('fail')
    const titleCheck = outcome.checks.find(check => check.check === 'metadata-match' && check.status === 'fail')
    expect(titleCheck?.detail).toContain('title differs')
    expect(titleCheck?.expected).toBe('A completely different title')
  })

  it('warns on a one-year difference and a venue mismatch', async () => {
    const outcome = await verifyCitation({ ...CITATION, year: 2021, venue: 'Proceedings of Elsewhere' }, await deps(await crossrefRoutes()))
    expect(outcome.status).toBe('warn')
  })

  it('reports not_found as skipped and leaves the evidence unchecked', async () => {
    const outcome = await verifyCitation({ doi: '10.1000/missing' }, await deps(await crossrefRoutes()))
    expect(outcome.notFound).toBe(true)
    expect(outcome.status).toBe('unchecked')
    const check = outcome.checks.find(item => item.check === 'doi-exists')
    expect(check?.status).toBe('skipped')
    expect(check?.code).toBe('not_found')
    expect(check?.detail).toContain('not evidence of fabrication')
    expect(outcome.snapshot).toBeUndefined()
  })

  it('reports a timeout as skipped, never as a verdict', async () => {
    const outcome = await verifyCitation({ doi: '10.1000/xyz' }, await deps([], { fail: new CiteNetworkError('timeout', 'timed out') }))
    expect(outcome.status).toBe('unchecked')
    expect(outcome.checks[0]?.status).toBe('skipped')
    expect(outcome.checks[0]?.code).toBe('unavailable')
  })

  it('resolves a PMID through PubMed and keeps the DOI it carries', async () => {
    const outcome = await verifyCitation({ pmid: '12345' }, await deps(await crossrefRoutes()))
    expect(outcome.status).toBe('ok')
    expect(outcome.resolved?.provider).toBe('pubmed')
    expect(outcome.resolved?.doi).toBe('10.1000/xyz')
    expect(outcome.checks.some(check => check.check === 'other' && check.status === 'pass')).toBe(true)
  })

  it('resolves an arXiv id and labels the record as a preprint', async () => {
    const outcome = await verifyCitation({ arxiv: '2401.00001' }, await deps(await crossrefRoutes()))
    expect(outcome.resolved?.provider).toBe('arxiv')
    expect(outcome.resolved?.type).toBe('preprint')
    expect(outcome.resolved?.title).toBe('A study of things')
  })

  it('seeds expectations from BibTeX', async () => {
    const bibtex = '@article{doe2020, title={A study of things}, author={Doe, Jane and Roe, Richard}, year={2020}, journal={Journal of Tests}, doi={10.1000/xyz}}'
    const outcome = await verifyCitation({ bibtex }, await deps(await crossrefRoutes()))
    expect(outcome.status).toBe('ok')
    expect(outcome.normalized.identifiers.doi).toBe('10.1000/xyz')
    expect(outcome.normalized.expected.authors).toEqual(['Doe, Jane', 'Roe, Richard'])
  })

  it('flags an update notice on the record without claiming the cited work is retracted', async () => {
    const outcome = await verifyCitation({ doi: '10.1000/retraction' }, await deps(await crossrefRoutes()))
    const check = outcome.checks.find(item => item.check === 'retraction')
    expect(check?.status).toBe('warn')
    expect(check?.detail).toContain('dsh-retraction-watch')
    expect(outcome.status).toBe('warn')
  })

  it('cross-checks two identifiers on the title', async () => {
    const outcome = await verifyCitation({ doi: '10.1000/xyz', pmid: '12345' }, await deps(await crossrefRoutes()))
    const version = outcome.checks.find(check => check.check === 'version-match')
    expect(version?.status).toBe('pass')
  })

  it('rejects invalid identifiers and missing identifiers', async () => {
    await expect(verifyCitation({ doi: 'not-a-doi' }, await deps([]))).rejects.toBeInstanceOf(CiteInputError)
    await expect(verifyCitation({}, await deps([]))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(verifyCitation({ bibtex: 'no entry here' }, await deps([]))).rejects.toMatchObject({ code: 'INVALID_BIBTEX' })
  })

  it('caches provider responses and lets fresh bypass the cache', async () => {
    const first = await deps(await crossrefRoutes())
    await verifyCitation({ doi: '10.1000/xyz' }, first)
    expect(first.calls).toHaveLength(1)

    const second = await deps(await crossrefRoutes())
    await verifyCitation({ doi: '10.1000/xyz' }, second)
    expect(second.calls).toHaveLength(0)

    const fresh = await deps(await crossrefRoutes(), { fresh: true })
    await verifyCitation({ doi: '10.1000/xyz' }, fresh)
    expect(fresh.calls).toHaveLength(1)
  })
})
