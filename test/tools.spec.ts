/**
 * Tool surface: names, parameter schemas, canonical values, renderers.
 * @module test/tools.spec
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { CiteVerifyRuntime } from '../src/runtime.ts'
import { makeCiteBatchTool } from '../src/tools/cite-batch.ts'
import type { CiteBatchValue } from '../src/tools/cite-batch.ts'
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

  it('cite_fix returns text only', async () => {
    const tool = makeCiteFixTool(await runtime())
    const value = (await tool.execute({ bibtex: '@article{k, title={Wrong}, doi={10.1000/xyz}}' }, EXEC)) as CiteFixValue
    expect(value.ok).toBe(true)
    if (!value.ok) throw new Error('expected success')
    expect(value.bibtex).toContain('@article{k,')
    expect(value.diffs.length).toBeGreaterThan(0)
  })
})
