/**
 * `cite_export` — format one resolved citation in seven styles.
 * @module dsh-cite-verify/tools/cite-export
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  exportCitation,
  isCitationStyle,
  type CitationExtras,
  type CitationStyle,
} from '../export.ts'
import { CiteVerifyError, type CiteVerifyRuntime } from '../runtime.ts'
import {
  CiteInputError,
  type CitationInput,
  type ResolvedSummary,
} from '../verify.ts'
import { ERROR_SCHEMA } from './shared.ts'

/** The canonical success value. */
export interface CiteExportValue {
  readonly ok: true
  readonly style: CitationStyle
  readonly entry: string
  readonly missing: readonly string[]
  readonly evidenceId?: string
  readonly warnings: readonly string[]
}

/** The canonical failure value. */
export interface CiteExportFailure {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string }
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    style: { type: 'string' },
    entry: { type: 'string' },
    missing: { type: 'array', items: { type: 'string' } },
    evidenceId: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    error: ERROR_SCHEMA,
  },
} as const

/** The tool arguments, as received from the model. */
interface CiteExportArgs {
  readonly doi?: string
  readonly pmid?: string
  readonly arxiv?: string
  readonly bibtex?: string
  readonly title?: string
  readonly authors?: readonly string[]
  readonly year?: number
  readonly venue?: string
  readonly pages?: string
  readonly volume?: string
  readonly issue?: string
  readonly publisher?: string
  readonly url?: string
  readonly language?: 'zh' | 'en'
  readonly index?: number
  readonly style?: string
  readonly record?: unknown
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

/** Turn an already-resolved record (offline formatting) into a summary. */
function asRecord(value: unknown): ResolvedSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CiteVerifyError('INVALID_INPUT', 'record must be a resolved-citation object')
  }
  const raw = value as Record<string, unknown>
  const authors = Array.isArray(raw.authors)
    ? raw.authors.filter((author): author is string => typeof author === 'string')
    : []
  const provider = stringOf(raw.provider) ?? 'record'
  const doi = stringOf(raw.doi)
  const pmid = stringOf(raw.pmid)
  const arxiv = stringOf(raw.arxiv)
  const title = stringOf(raw.title)
  const year = numberOrUndefined(raw.year)
  const venue = stringOf(raw.venue)
  const volume = stringOf(raw.volume)
  const issue = stringOf(raw.issue)
  const pages = stringOf(raw.pages)
  const publisher = stringOf(raw.publisher)
  const type = stringOf(raw.type)
  return {
    provider,
    authors,
    ...(doi === undefined ? {} : { doi }),
    ...(pmid === undefined ? {} : { pmid }),
    ...(arxiv === undefined ? {} : { arxiv }),
    ...(title === undefined ? {} : { title }),
    ...(year === undefined ? {} : { year }),
    ...(venue === undefined ? {} : { venue }),
    ...(volume === undefined ? {} : { volume }),
    ...(issue === undefined ? {} : { issue }),
    ...(pages === undefined ? {} : { pages }),
    ...(publisher === undefined ? {} : { publisher }),
    ...(type === undefined ? {} : { type }),
  }
}

/**
 * Build the `cite_export` tool.
 * @param runtime - the citation runtime (used to resolve identifiers).
 * @returns the tool definition.
 */
export function makeCiteExportTool(runtime: CiteVerifyRuntime) {
  return defineTool({
    name: 'cite_export',
    description: [
      'Format one citation as GB/T 7714 (numeric), APA 7, IEEE, Vancouver, BibTeX, RIS or CSL-JSON (dsh-cite-verify).',
      '',
      'Provide an identifier (`doi`, `pmid`, `arxiv`, `bibtex`) to resolve the record, or a `record` object to format offline. Optional `volume`, `issue`, `publisher` and `url` fill fields the provider record does not carry. Missing fields are reported, never guessed; the title is preserved as given.',
    ].join('\n'),
    parameters: {
      doi: { type: 'string', description: 'DOI (with or without the https://doi.org/ prefix).' },
      pmid: { type: 'string', description: 'PubMed id (digits).' },
      arxiv: { type: 'string', description: 'arXiv id, optionally versioned.' },
      bibtex: { type: 'string', description: 'A BibTeX entry to resolve the identifier from.' },
      title: { type: 'string', description: 'Title override (also used as the cited title for checks).' },
      authors: { type: 'array', items: { type: 'string' }, description: 'Author override; family/given or "Family, Given".' },
      year: { type: 'integer', description: 'Year override.' },
      venue: { type: 'string', description: 'Journal/venue override.' },
      pages: { type: 'string', description: 'Pages override (e.g. 1-10).' },
      volume: { type: 'string', description: 'Volume (when the provider record has none).' },
      issue: { type: 'string', description: 'Issue/number.' },
      publisher: { type: 'string', description: 'Publisher (books/reports).' },
      url: { type: 'string', description: 'Landing page or PDF URL.' },
      language: { type: 'string', description: 'Author-list language hint: zh (等) or en (et al).' },
      index: { type: 'integer', description: 'IEEE reference number (default 1).' },
      style: {
        type: 'string',
        description: 'gbt7714-numeric (default) | apa | ieee | vancouver | bibtex | ris | csl-json.',
      },
      record: { type: 'json', description: 'An already-resolved record ({provider, authors, title, year, venue, ...}) to format offline.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value as CiteExportValue | CiteExportFailure
        if (!result.ok) return [{ type: 'text', text: `cite_export failed (${result.error.code}): ${result.error.message}` }]
        const lines = [`cite_export (${result.style})`]
        if (result.missing.length > 0) lines.push(`  missing: ${result.missing.join(', ')}`)
        lines.push(result.entry)
        if (result.evidenceId !== undefined) lines.push(`evidence ${result.evidenceId}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(input: unknown) {
      const args = (input ?? {}) as CiteExportArgs
      try {
        const style = args.style ?? 'gbt7714-numeric'
        if (!isCitationStyle(style)) {
          throw new CiteVerifyError('INVALID_INPUT', `unknown style "${style}"; use ${['gbt7714-numeric', 'apa', 'ieee', 'vancouver', 'bibtex', 'ris', 'csl-json'].join(', ')}`)
        }
        let resolved: ResolvedSummary | undefined
        let evidenceId: string | undefined
        let warnings: string[] = []
        if (args.record !== undefined) {
          resolved = asRecord(args.record)
        } else {
          const citation: CitationInput = {
            ...(args.doi === undefined ? {} : { doi: args.doi }),
            ...(args.pmid === undefined ? {} : { pmid: args.pmid }),
            ...(args.arxiv === undefined ? {} : { arxiv: args.arxiv }),
            ...(args.bibtex === undefined ? {} : { bibtex: args.bibtex }),
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(args.authors === undefined ? {} : { authors: args.authors }),
            ...(args.year === undefined ? {} : { year: args.year }),
            ...(args.venue === undefined ? {} : { venue: args.venue }),
            ...(args.pages === undefined ? {} : { pages: args.pages }),
          }
          const result = await runtime.verify(citation)
          resolved = result.resolved
          evidenceId = result.evidenceId
          warnings = [...result.warnings]
        }
        if (resolved === undefined) {
          return {
            ok: false as const,
            error: { code: 'NOT_FOUND', message: 'no provider record resolved; pass doi/pmid/arxiv/bibtex or a record object' },
          }
        }
        const merged: ResolvedSummary = {
          ...resolved,
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.authors === undefined ? {} : { authors: args.authors }),
          ...(args.year === undefined ? {} : { year: args.year }),
          ...(args.venue === undefined ? {} : { venue: args.venue }),
          ...(args.pages === undefined ? {} : { pages: args.pages }),
        }
        const extras: CitationExtras = {
          ...(args.volume === undefined ? {} : { volume: args.volume }),
          ...(args.issue === undefined ? {} : { issue: args.issue }),
          ...(args.pages === undefined ? {} : { pages: args.pages }),
          ...(args.publisher === undefined ? {} : { publisher: args.publisher }),
          ...(args.url === undefined ? {} : { url: args.url }),
          ...(args.language === undefined ? {} : { language: args.language }),
          ...(args.index === undefined ? {} : { index: args.index }),
        }
        const exported = exportCitation(merged, style, extras)
        return {
          ok: true as const,
          style,
          entry: exported.entry,
          missing: [...exported.missing],
          ...(evidenceId === undefined ? {} : { evidenceId }),
          warnings,
        }
      } catch (error) {
        if (error instanceof CiteVerifyError) {
          return { ok: false as const, error: { code: error.code, message: error.message } }
        }
        if (error instanceof CiteInputError) {
          return { ok: false as const, error: { code: error.code, message: error.message } }
        }
        throw error
      }
    },
  })
}
