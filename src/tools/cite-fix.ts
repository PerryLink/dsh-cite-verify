/**
 * `cite_fix` — produce a corrected BibTeX entry from the authoritative record.
 *
 * It only returns text. It never rewrites a file, never deletes fields it does
 * not understand, and reports every field it would change.
 * @module dsh-cite-verify/tools/cite-fix
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { CiteVerifyError, type CiteVerifyRuntime, type CiteFixResult } from '../runtime.ts'
import { ERROR_SCHEMA } from './shared.ts'

/** The `cite_fix` canonical value. */
export type CiteFixValue =
  | {
      readonly ok: true
      readonly bibtex: string
      readonly diffs: readonly { readonly field: string; readonly before?: string; readonly after?: string }[]
      readonly status: string
      readonly evidenceId?: string
      readonly warnings: readonly string[]
    }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    bibtex: { type: 'string' },
    diffs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          field: { type: 'string', required: true },
          before: { type: 'string' },
          after: { type: 'string' },
        },
      },
    },
    status: { type: 'string' },
    evidenceId: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    error: ERROR_SCHEMA,
  },
} as const

/**
 * Build the `cite_fix` tool.
 * @param runtime - the verification runtime.
 * @returns the tool definition.
 */
export function makeCiteFixTool(runtime: CiteVerifyRuntime) {
  return defineTool({
    name: 'cite_fix',
    description: [
      'Produce a corrected BibTeX entry for a citation (dsh-cite-verify).',
      '',
      'Takes the same inputs as `cite_verify`. The authoritative record fills title/author/year/journal/pages/doi; unknown fields of the input entry are preserved and the citation key is kept. The result is TEXT ONLY — this tool never writes to a file. Every changed field is listed in `diffs` so the user can accept or reject it.',
      '',
      'If no record can be resolved (not_found or network failure) the BibTeX is empty and `status` says why.',
    ].join('\n'),
    parameters: {
      doi: { type: 'string', description: 'DOI (with or without the https://doi.org/ prefix).' },
      pmid: { type: 'string', description: 'PubMed id (digits).' },
      arxiv: { type: 'string', description: 'arXiv id.' },
      bibtex: { type: 'string', description: 'The original BibTeX entry (its key and unknown fields are preserved).' },
      title: { type: 'string', description: 'Title as cited.' },
      authors: { type: 'array', items: { type: 'string' }, description: 'Authors as cited.' },
      year: { type: 'integer', description: 'Year as cited.' },
      venue: { type: 'string', description: 'Venue as cited.' },
      pages: { type: 'string', description: 'Pages as cited.' },
      fresh: { type: 'boolean', description: 'Bypass the response cache.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value as CiteFixValue
        if (!result.ok) return [{ type: 'text', text: `cite_fix failed (${result.error.code}): ${result.error.message}` }]
        if (result.bibtex === '') {
          return [{ type: 'text', text: `cite_fix: nothing to correct (${result.status})\n${result.warnings.join('\n')}` }]
        }
        const lines = [`cite_fix: ${result.status}, ${result.diffs.length} field(s) changed`]
        for (const diff of result.diffs) lines.push(`  ${diff.field}: ${diff.before ?? '(missing)'} → ${diff.after ?? ''}`)
        lines.push('', result.bibtex)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args: unknown) {
      const input = args as Parameters<CiteVerifyRuntime['fix']>[0]
      try {
        const result: CiteFixResult = await runtime.fix(input)
        return {
          ok: true as const,
          bibtex: result.bibtex,
          diffs: result.diffs.map(diff => ({
            field: diff.field,
            ...(diff.before === undefined ? {} : { before: diff.before }),
            ...(diff.after === undefined ? {} : { after: diff.after }),
          })),
          status: result.status,
          ...(result.evidenceId === undefined ? {} : { evidenceId: result.evidenceId }),
          warnings: [...result.warnings],
        }
      } catch (error) {
        if (error instanceof CiteVerifyError) return { ok: false as const, error: { code: error.code, message: error.message } }
        throw error
      }
    },
  })
}
