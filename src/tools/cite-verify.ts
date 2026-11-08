/**
 * `cite_verify` — verify one citation's existence and metadata.
 * @module dsh-cite-verify/tools/cite-verify
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CheckResult } from '@perrylink/dsh-research-core'
import { CiteVerifyError, type CiteVerifyRuntime, type CiteVerifyResult } from '../runtime.ts'
import { CHECK_SCHEMA, ERROR_SCHEMA, RESOLVED_SCHEMA } from './shared.ts'

/** The canonical success value. */
export interface CiteVerifyValue {
  readonly ok: true
  readonly status: CiteVerifyResult['status']
  readonly notFound: boolean
  readonly lookupError: boolean
  readonly resolved?: CiteVerifyResult['resolved']
  readonly checks: readonly CheckResult[]
  readonly evidenceId?: string
  readonly recordPath?: string
  readonly warnings: readonly string[]
}

/** The canonical failure value. */
export interface CiteVerifyFailure {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string }
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    status: { type: 'string' },
    notFound: { type: 'boolean' },
    lookupError: { type: 'boolean' },
    resolved: RESOLVED_SCHEMA,
    checks: { type: 'array', items: CHECK_SCHEMA },
    evidenceId: { type: 'string' },
    recordPath: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    error: ERROR_SCHEMA,
  },
} as const

/** Project one REP check into lossless JSON. */
export function plainCheck(check: CheckResult) {
  return {
    checkId: check.checkId,
    check: check.check,
    status: check.status,
    detail: check.detail,
    ...(check.code === undefined ? {} : { code: check.code }),
    ...(check.severity === undefined ? {} : { severity: check.severity }),
    ...(check.expected === undefined ? {} : { expected: check.expected as never }),
    ...(check.actual === undefined ? {} : { actual: check.actual as never }),
  }
}

/**
 * Build the `cite_verify` tool.
 * @param runtime - the verification runtime.
 * @returns the tool definition.
 */
export function makeCiteVerifyTool(runtime: CiteVerifyRuntime) {
  return defineTool({
    name: 'cite_verify',
    description: [
      'Verify that a citation exists and that its metadata is right (dsh-cite-verify).',
      '',
      'Provide at least one identifier — `doi`, `pmid`, `arxiv`, or a `bibtex` entry (from which the identifier and the expected fields are read). Optionally pass the fields as cited (`title`, `authors`, `year`, `venue`, `pages`) to get field-by-field checks.',
      '',
      'Crossref / PubMed / arXiv responses are stored as immutable snapshots and registered as REP evidence, so every verdict can be re-read from the provider answer. `not_found` is returned as a skipped check (status unchecked): it is not evidence of fabrication and not evidence of cleanliness. Retraction status is NOT checked in v0.1 beyond the record\'s own update notices.',
    ].join('\n'),
    parameters: {
      doi: { type: 'string', description: 'DOI (with or without the https://doi.org/ prefix).' },
      pmid: { type: 'string', description: 'PubMed id (digits).' },
      arxiv: { type: 'string', description: 'arXiv id, optionally versioned (e.g. 2401.00001v2).' },
      bibtex: { type: 'string', description: 'A BibTeX entry; its doi/pmid/eprint and fields seed the verification.' },
      title: { type: 'string', description: 'Title as cited, to compare with the resolved record.' },
      authors: { type: 'array', items: { type: 'string' }, description: 'Authors as cited (family names are compared).' },
      year: { type: 'integer', description: 'Year as cited.' },
      venue: { type: 'string', description: 'Journal/venue as cited.' },
      pages: { type: 'string', description: 'Pages as cited (e.g. 123-130).' },
      fresh: { type: 'boolean', description: 'Bypass the response cache and hit the provider again.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value as CiteVerifyValue | CiteVerifyFailure
        if (!result.ok) return [{ type: 'text', text: `cite_verify failed (${result.error.code}): ${result.error.message}` }]
        const suffix = result.notFound
          ? ' (no record found by the provider)'
          : result.lookupError
            ? ' (lookup failed — not a not-found verdict)'
            : ''
        const lines = [`cite_verify: ${result.status}${suffix}`]
        if (result.lookupError) lines.push('  note: at least one lookup failed; the answer may be partial and is not a verdict about the work')
        if (result.resolved !== undefined) {
          const resolved = result.resolved
          lines.push(
            `${resolved.provider}: ${resolved.authors.slice(0, 3).join('; ')}${resolved.authors.length > 3 ? ' et al.' : ''} (${resolved.year ?? '?'}) ${resolved.title ?? '(no title)'}${resolved.venue === undefined ? '' : ` — ${resolved.venue}`}`,
          )
        }
        for (const check of result.checks) {
          lines.push(`  [${check.status}] ${check.check}: ${check.detail}`)
        }
        for (const warning of result.warnings) lines.push(`  warning: ${warning}`)
        if (result.evidenceId !== undefined) lines.push(`evidence ${result.evidenceId}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args: unknown) {
      const input = args as Parameters<CiteVerifyRuntime['verify']>[0]
      try {
        const result = await runtime.verify(input)
        return {
          ok: true as const,
          status: result.status,
          notFound: result.notFound,
          lookupError: result.lookupError,
          ...(result.resolved === undefined
            ? {}
            : { resolved: { ...result.resolved, authors: [...result.resolved.authors] } }),
          checks: result.checks.map(plainCheck),
          ...(result.evidenceId === undefined ? {} : { evidenceId: result.evidenceId }),
          ...(result.recordPath === undefined ? {} : { recordPath: result.recordPath }),
          warnings: [...result.warnings],
        }
      } catch (error) {
        if (error instanceof CiteVerifyError) return { ok: false as const, error: { code: error.code, message: error.message } }
        throw error
      }
    },
  })
}
