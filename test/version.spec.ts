/**
 * Package contract and config validation.
 * @module test/version.spec
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { VERSION } from '../src/version.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Read and parse one JSON file. */
async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
}

describe('package contract', () => {
  it('VERSION matches package.json', async () => {
    const pkg = await readJson(path.join(here, '..', 'package.json'))
    expect(pkg['version']).toBe(VERSION)
  })

  it('declares the bundle patch, files and the current DSH peer line', async () => {
    const pkg = await readJson(path.join(here, '..', 'package.json'))
    expect(pkg['type']).toBe('module')
    expect(pkg['dsh']).toEqual({ manifestVersion: 1, bundle: { patch: './cordis.patch.yml' } })
    expect(pkg['files']).toContain('lib')
    const engines = pkg['engines'] as Record<string, string>
    expect(engines['dsh']).toContain('>=0.2.1-0 <0.3.0')
    expect(engines['node']).toBe('^22.19.0 || >=24.9.0')
    expect((pkg['peerDependencies'] as Record<string, string>)['@perrylink/dsh-research-core']).toBe('^0.1.0')
    expect(pkg['dependencies']).toEqual({})
  })

  it('ships a patch whose keys resolve and rejects invalid bounds', async () => {
    const patch = await readFile(path.join(here, '..', 'cordis.patch.yml'), 'utf8')
    for (const key of ['enabled', 'root', 'timeoutMs', 'minIntervalMs', 'maxRedirects', 'cacheTtlMs', 'titleThreshold', 'batchConcurrency', 'maxBatch']) {
      expect(patch).toContain(key)
    }
    expect(() => resolveConfig({ titleThreshold: 0 })).toThrow(/titleThreshold/u)
    expect(() => resolveConfig({ batchConcurrency: 0 })).toThrow(/positive/u)
    expect(() => resolveConfig({ maxBatch: -1 })).toThrow(/non-negative/u)
  })
})
