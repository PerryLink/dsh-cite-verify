/**
 * Runtime integration: real core store, real REP records, scripted providers.
 * @module test/runtime.spec
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { validateRep } from '@perrylink/dsh-research-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { CiteVerifyRuntime } from '../src/runtime.ts'
import type { HttpClient } from '../src/http.ts'
import { fixture, scriptedClient, type Route } from './helpers.ts'

const AT = new Date('2026-04-01T12:00:00.000Z')
let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cite-verify-runtime-'))
})

afterEach(async () => {
  if (root.startsWith(tmpdir())) await rm(root, { recursive: true, force: true })
})

/** Build the runtime over scripted routes. */
async function runtime(routes?: Route[], options: { client?: HttpClient } = {}): Promise<{ rt: CiteVerifyRuntime; calls: string[] }> {
  const resolved = routes ?? [
    { match: 'api.crossref.org/works/10.1000/xyz', body: await fixture('crossref-work.json') },
    { match: 'api.crossref.org/works/10.1000/missing', status: 404, body: '' },
    { match: 'eutils.ncbi.nlm.nih.gov', body: await fixture('pubmed-summary.json') },
  ]
  const scripted = scriptedClient(resolved)
  const rt = new CiteVerifyRuntime({
    config: resolveConfig({ root }),
    client: options.client ?? scripted.client,
    now: () => AT,
  })
  return { rt, calls: scripted.calls }
}

describe('verify', () => {
  it('registers evidence + a valid REP record for a resolved citation', async () => {
    const { rt } = await runtime()
    const result = await rt.verify({ doi: '10.1000/xyz', title: 'A study of things' })
    expect(result.ok).toBe(true)
    expect(result.status).toBe('ok')
    expect(result.evidenceId).toMatch(/^ev-/u)
    const record = JSON.parse(await readFile(result.recordPath!, 'utf8')) as unknown
    const validation = validateRep(record)
    expect(validation.ok, JSON.stringify(validation.issues)).toBe(true)
    const evidence = await rt.port().getEvidence(result.evidenceId!)
    expect(evidence?.snapshotIds).toHaveLength(1)
    expect(evidence?.checks?.length).toBeGreaterThan(0)
    expect(evidence?.sourceRef.kind).toBe('doi')
    expect(evidence?.sourceRef.id).toBe('10.1000/xyz')
  })

  it('does not write evidence when nothing was found', async () => {
    const { rt } = await runtime()
    const result = await rt.verify({ doi: '10.1000/missing' })
    expect(result.notFound).toBe(true)
    expect(result.evidenceId).toBeUndefined()
    expect(result.recordPath).toBeUndefined()
  })

  it('persists across runtime instances', async () => {
    const first = await runtime()
    const result = await first.rt.verify({ doi: '10.1000/xyz' })
    const second = await runtime()
    const evidence = await second.rt.port().getEvidence(result.evidenceId!)
    expect(evidence).toBeDefined()
  })

  it('re-verifies the same answer without an evidence conflict', async () => {
    const first = await runtime()
    const initial = await first.rt.verify({ doi: '10.1000/xyz' })
    // A later clock must not make the same immutable snapshot look like edited
    // evidence; the identity is the snapshot plus the checks, not "now".
    const later = new CiteVerifyRuntime({
      config: resolveConfig({ root }),
      client: scriptedClient([
        { match: 'api.crossref.org/works/10.1000/xyz', body: await fixture('crossref-work.json') },
      ]).client,
      now: () => new Date('2026-04-02T12:00:00.000Z'),
    })
    const again = await later.verify({ doi: '10.1000/xyz' }, { fresh: true })
    expect(again.status).toBe(initial.status)
    expect(again.evidenceId).toBe(initial.evidenceId)
    await expect(later.verify({ doi: '10.1000/xyz', title: 'A different expectation' }, { fresh: true })).resolves.toMatchObject({
      ok: true,
    })
  })
})

describe('batch', () => {
  it('verifies each citation and keeps per-item failures local', async () => {
    const { rt } = await runtime()
    const result = await rt.batch(['doi:10.1000/xyz', 'doi:10.1000/missing', 'pmid:12345', 'not-an-identifier'])
    expect(result.count).toBe(4)
    expect(result.items[0]?.ok).toBe(true)
    expect(result.items[0]?.status).toBe('ok')
    expect(result.items[1]?.ok).toBe(true)
    expect(result.items[1]?.status).toBe('unchecked')
    expect(result.items[2]?.ok).toBe(true)
    expect(result.items[3]?.ok).toBe(false)
    expect(result.items[3]?.error?.code).toBe('UNSUPPORTED_IDENTIFIER')
  })

  it('flags duplicate citations in the same batch', async () => {
    const { rt } = await runtime()
    const result = await rt.batch(['doi:10.1000/xyz', '10.1000/xyz'])
    expect(result.items[1]?.status).toBe('warn')
    expect(result.items[1]?.duplicate).toBe(true)
    expect(result.items[0]?.duplicate).toBeUndefined()
    expect(result.warnings.join(' ')).toContain('duplicate')
  })

  it('never downgrades a duplicate fail to warn', async () => {
    const { rt } = await runtime()
    vi.spyOn(rt, 'verify').mockResolvedValue({
      ok: true,
      status: 'fail',
      notFound: false,
      lookupError: false,
      checks: [],
      warnings: [],
    })
    const result = await rt.batch(['doi:10.1000/xyz', '10.1000/xyz'])
    expect(result.items[0]?.status).toBe('fail')
    expect(result.items[1]?.status).toBe('fail')
    expect(result.items[1]?.duplicate).toBe(true)
  })

  it('enforces the batch cap', async () => {
    const rt = new CiteVerifyRuntime({ config: resolveConfig({ root, maxBatch: 2 }), client: scriptedClient([]).client, now: () => AT })
    await expect(rt.batch(['doi:10.1000/xyz', 'doi:10.1000/xyz', 'doi:10.1000/xyz'])).rejects.toMatchObject({ code: 'BATCH_TOO_LARGE' })
  })
})

describe('fix', () => {
  it('produces corrected BibTeX and reports every changed field', async () => {
    const { rt } = await runtime()
    const bibtex = '@article{doe2020, title={A Study of Thingz}, year={2019}, doi={10.1000/xyz}, note={keep me}}'
    const result = await rt.fix({ bibtex })
    expect(result.status).not.toBe('unchecked')
    expect(result.bibtex).toContain('@article{doe2020,')
    expect(result.bibtex).toContain('note = {keep me}')
    const titleDiff = result.diffs.find(diff => diff.field === 'title')
    expect(titleDiff?.before).toBe('A Study of Thingz')
    expect(titleDiff?.after).toBe('A study of things')
    const yearDiff = result.diffs.find(diff => diff.field === 'year')
    expect(yearDiff?.after).toBe('2020')
  })

  it('returns empty BibTeX when nothing resolves', async () => {
    const { rt } = await runtime()
    const result = await rt.fix({ doi: '10.1000/missing' })
    expect(result.bibtex).toBe('')
    expect(result.status).toBe('unchecked')
  })
})
