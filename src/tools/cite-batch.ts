/**
 * `cite_batch` — verify a reference list with bounded concurrency.
 * @module dsh-cite-verify/tools/cite-batch
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { CiteVerifyError, type CiteVerifyRuntime, type CiteBatchResult } from '../runtime.ts'
import { CHECK_SCHEMA, ERROR_SCHEMA, RESOLVED_SCHEMA } from './shared.ts'

/** The `cite_batch` canonical value. */
export type CiteBatchValue =
  | { readonly ok: true; readonly count: number; readonly items: readonly unknown[]; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    count: { type: 'integer' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer', required: true },
          input: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          status: { type: 'string' },
          evidenceId: { type: 'string' },
          error: ERROR_SCHEMA,
        },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
    error: ERROR_SCHEMA,
    checks: { type: 'array', items: CHECK_SCHEMA },
    resolved: RESOLVED_SCHEMA,
  },
} as const

/**
 * Build the `cite_batch` tool.
 * @param runtime - the verification runtime.
 * @returns the tool definition.
 */
export function makeCiteBatchTool(runtime: CiteVerifyRuntime) {
  return defineTool({
    name: 'cite_batch',
    description: [
      'Verify a list of citations in one call (dsh-cite-verify).',
      '',
      'Each entry is a string: `doi:10.xxxx/...`, `pmid:123456`, `arxiv:2401.00001`, an `@article{...}` BibTeX entry, or a bare DOI/PMID/arXiv id detected by shape. Items are checked with bounded concurrency against the same allowlisted providers and cached like `cite_verify`; repeated identifiers are flagged as duplicates.',
      '',
      'Per-item failures (bad identifier, blocked host, timeout) are reported in that item only — one broken citation never fails the batch.',
    ].join('\n'),
    parameters: {
      citations: { type: 'array', items: { type: 'string' }, description: 'Citations to verify (max from config, default 50).' },
      fresh: { type: 'boolean', description: 'Bypass the response cache.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value as CiteBatchValue
        if (!result.ok) return [{ type: 'text', text: `cite_batch failed (${result.error.code}): ${result.error.message}` }]
        const counts = new Map<string, number>()
        for (const item of result.items as CiteBatchResult['items']) {
          if (!item.ok) counts.set('error', (counts.get('error') ?? 0) + 1)
          else counts.set(item.status ?? 'unchecked', (counts.get(item.status ?? 'unchecked') ?? 0) + 1)
        }
        const summary = [...counts.entries()].map(([key, count]) => `${key}=${count}`).join(', ')
        return [{ type: 'text', text: `cite_batch: ${result.count} citation(s) — ${summary}` }]
      },
    },
    async execute(args: unknown) {
      const request = args as { citations?: string[]; fresh?: boolean }
      try {
        const result = await runtime.batch(request.citations ?? [], request.fresh === true ? { fresh: true } : {})
        return {
          ok: true as const,
          count: result.count,
          items: result.items.map(item => ({
            index: item.index,
            input: item.input,
            ok: item.ok,
            ...(item.status === undefined ? {} : { status: item.status }),
            ...(item.evidenceId === undefined ? {} : { evidenceId: item.evidenceId }),
            ...(item.error === undefined ? {} : { error: { code: item.error.code, message: item.error.message } }),
          })),
          warnings: [...result.warnings],
        }
      } catch (error) {
        if (error instanceof CiteVerifyError) return { ok: false as const, error: { code: error.code, message: error.message } }
        throw error
      }
    },
  })
}
