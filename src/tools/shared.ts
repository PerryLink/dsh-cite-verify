/**
 * Shared schema fragments for the citation tools.
 * @module dsh-cite-verify/tools/shared
 */

/** The failure branch. */
export const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
} as const

/** One check result. */
export const CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    checkId: { type: 'string', required: true },
    check: { type: 'string', required: true },
    status: { type: 'string', required: true },
    detail: { type: 'string', required: true },
    code: { type: 'string' },
    severity: { type: 'string' },
    expected: { type: 'json' },
    actual: { type: 'json' },
  },
} as const

/** The resolved record summary. */
export const RESOLVED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string', required: true },
    doi: { type: 'string' },
    pmid: { type: 'string' },
    arxiv: { type: 'string' },
    title: { type: 'string' },
    authors: { type: 'array', items: { type: 'string' } },
    year: { type: 'integer' },
    venue: { type: 'string' },
    pages: { type: 'string' },
    type: { type: 'string' },
  },
} as const
