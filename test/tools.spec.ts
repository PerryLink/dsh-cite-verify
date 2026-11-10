/**
 * Tool surface: names, parameter schemas, canonical values, renderers.
 * @module test/tools.spec
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { CiteNetworkError } from '../src/http.ts'
import { CiteVerifyRuntime } from '../src/runtime.ts'
import { makeCiteBatchTool } from '../src/tools/cite-batch.ts'
import type { CiteBatchValue } from '../src/tools/cite-batch.ts'
import { makeCiteExportTool } from '../src/tools/cite-export.ts'
import type { CiteExportFailure, CiteExportValue } from '../src/tools/cite-export.ts'
import { makeCiteFixTool } from '../src/tools/cite-fix.ts'
import type { CiteFixValue } from '../src/tools/cite-fix.ts'
import { makeCiteVerifyTool } from '../src/tools/cite-verify.ts'
import type { CiteVerifyFailure, CiteVerifyValue } from '../src/tools/cite-verify.ts'
import { fixture, scriptedClient } from './helpers.ts'

const AT = new Date('2026-04-01T12:00:00.000Z')
let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cite-verify-tools-'))
})

afterEach(async () => {
  if (root.startsWith(tmpdir())) await rm(root, { recursive: true, force: true })
})

/** Build a runtime with the Crossref/PubMed fixtures. */
async function runtime(): Promise<CiteVerifyRuntime> {
  const scripted = scriptedClient([
    { match: 'api.crossref.org/works/10.1000/xyz', body: await fixture('crossref-work.json') },
    { match: 'api.crossref.org/works/10.1000/missing', status: 404, body: '' },
    { match: 'eutils.ncbi.nlm.nih.gov', body: await fixture('pubmed-summary.json') },
  ])
  return new CiteVerifyRuntime({ config: resolveConfig({ root }), client: scripted.client, now: () => AT })
}

const EXEC = {} as never

describe('tool interfaces', () => {
  it('declares names, parameter schemas and canonical output schemas', async () => {
    const rt = await runtime()
    for (const [tool, name] of [
      [makeCiteVerifyTool(rt), 'cite_verify'],
      [makeCiteBatchTool(rt), 'cite_batch'],
      [makeCiteFixTool(rt), 'cite_fix'],
      [makeCiteExportTool(rt), 'cite_export'],
    ] as const) {
      expect(tool.name).toBe(name)
      expect(Object.keys(tool.parameters).length).toBeGreaterThan(0)
      expect(tool.output.schema).toBeDefined()
      expect(typeof tool.output.render).toBe('function')
    }
  })

  it('cite_verify returns checks and a readable render', async () => {
    const tool = makeCiteVerifyTool(await runtime())
    const value = (await tool.execute({ doi: '10.1000/xyz', title: 'A study of things' }, EXEC)) as CiteVerifyValue | CiteVerifyFailure
    expect(value.ok).toBe(true)
    if (!value.ok) throw new Error('expected success')
    expect(value.status).toBe('ok')
    expect(value.checks.some(check => check.check === 'doi-exists')).toBe(true)
    const blocks = tool.output.render({}, value as never) as Array<{ text: string }>
    expect(blocks[0]?.text).toContain('cite_verify')
    expect(blocks[0]?.text).toContain('crossref')
  })

  it('cite_verify failure (bad identifier) is a normalised error', async () => {
    const tool = makeCiteVerifyTool(await runtime())
    const value = (await tool.execute({ doi: 'nope' }, EXEC)) as CiteVerifyValue | CiteVerifyFailure
    expect(value.ok).toBe(false)
    if (value.ok) throw new Error('expected failure')
    expect(value.error.code).toBe('INVALID_INPUT')
  })

  it('cite_batch summarises per-item outcomes', async () => {
    const tool = makeCiteBatchTool(await runtime())
    const value = (await tool.execute({ citations: ['doi:10.1000/xyz', 'doi:10.1000/missing'] }, EXEC)) as CiteBatchValue
    expect(value.ok).toBe(true)
    if (!value.ok) throw new Error('expected success')
    expect(value.count).toBe(2)
    const blocks = tool.output.render({}, value as never) as Array<{ text: string }>
    expect(blocks[0]?.text).toContain('ok=1')
    expect(blocks[0]?.text).toContain('unchecked=1')
  })

  it('separates a definitive not-found from a failed lookup in value and render', async () => {
    const missingTool = makeCiteVerifyTool(await runtime())
    const missing = (await missingTool.execute({ doi: '10.1000/missing' }, EXEC)) as CiteVerifyValue | CiteVerifyFailure
    expect(missing.ok).toBe(true)
    if (!missing.ok) throw new Error('expected success')
    expect(missing.notFound).toBe(true)
    expect(missing.lookupError).toBe(false)
    const missingText = (missingTool.output.render({}, missing as never) as Array<{ text: string }>)[0]?.text ?? ''
    expect(missingText).toContain('no record found')
    expect(missingText).not.toContain('lookup failed')

    const failing = new CiteVerifyRuntime({
      config: resolveConfig({ root }),
      client: scriptedClient([], { fail: new CiteNetworkError('timeout', 'timed out') }).client,
      now: () => AT,
    })
    const failingTool = makeCiteVerifyTool(failing)
    const value = (await failingTool.execute({ doi: '10.1000/xyz' }, EXEC)) as CiteVerifyValue | CiteVerifyFailure
    expect(value.ok).toBe(true)
    if (!value.ok) throw new Error('expected success')
    expect(value.notFound).toBe(false)
    expect(value.lookupError).toBe(true)
    const text = (failingTool.output.render({}, value as never) as Array<{ text: string }>)[0]?.text ?? ''
    expect(text).toContain('lookup failed')
    expect(text).not.toContain('no record found')
  })


  it('cite_export resolves an identifier and formats BibTeX', async () => {
    const tool = makeCiteExportTool(await runtime())
    const value = (await tool.execute({ doi: '10.1000/xyz', style: 'bibtex', volume: '12', issue: '3' }, EXEC)) as CiteExportValue | CiteExportFailure
    expect(value.ok).toBe(true)
    if (!value.ok) throw new Error('expected success')
    expect(value.entry).toContain('@article{doe2020a,')
    expect(value.entry).toContain('journal = {Journal of Tests}')
    expect(value.missing).toEqual([])
    const blocks = tool.output.render({}, value as never) as Array<{ text: string }>
    expect(blocks[0]?.text).toContain('cite_export (bibtex)')
    expect(blocks[0]?.text).toContain('@article')
  })

  it('cite_export formats an offline record and reports unknown styles', async () => {
    const tool = makeCiteExportTool(await runtime())
    const value = (await tool.execute({
      style: 'apa',
      record: { provider: 'record', title: 'Offline', authors: ['Doe, Jane'], year: 2024 },
    }, EXEC)) as CiteExportValue | CiteExportFailure
    expect(value.ok).toBe(true)
    if (!value.ok) throw new Error('expected success')
    expect(value.entry).toContain('Doe, J. (2024). Offline.')

    const bad = (await tool.execute({ doi: '10.1000/xyz', style: 'mla' }, EXEC)) as CiteExportValue | CiteExportFailure
    expect(bad.ok).toBe(false)
    if (bad.ok) throw new Error('expected failure')
    expect(bad.error.code).toBe('INVALID_INPUT')
  })

  it('cite_fix returns text only', async () => {
    const tool = makeCiteFixTool(await runtime())
    const value = (await tool.execute({ bibtex: '@article{k, title={Wrong}, doi={10.1000/xyz}}' }, EXEC)) as CiteFixValue
    expect(value.ok).toBe(true)
    if (!value.ok) throw new Error('expected success')
    expect(value.bibtex).toContain('@article{k,')
    expect(value.diffs.length).toBeGreaterThan(0)
  })
})
