/**
 * `dsh-cite-verify` — citation existence and metadata verification.
 *
 * Three tools, one job: turn a citation into a checkable provider record with
 * field-by-field verdicts and an immutable response snapshot. Network access is
 * bounded by an allowlist, timeouts, a per-host interval and a redirect budget;
 * `not_found` is reported as skipped, never as fabrication.
 *
 * Function plugin — no default export.
 * @module dsh-cite-verify
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig, type Config as ConfigShape } from './config.ts'
import { CiteVerifyRuntime, type EvidencePort } from './runtime.ts'
import { makeCiteBatchTool } from './tools/cite-batch.ts'
import { makeCiteFixTool } from './tools/cite-fix.ts'
import { makeCiteVerifyTool } from './tools/cite-verify.ts'

/** Cordis plugin name. */
export const name = 'cite-verify'

/** The tool registry is required; the REP service is optional. */
export const inject = ['tools']

export { Config, resolveConfig }
export type { ConfigShape }
export type { ResolvedConfig } from './config.ts'
export { VERSION } from './version.ts'
export { ALLOWED_HOSTS, CiteNetworkError, assertAllowed, createHttpClient } from './http.ts'
export type { FetchLike, HttpClient, HttpClientOptions, HttpResponse, NetworkErrorCode } from './http.ts'
export { ResponseCache } from './cache.ts'
export type { CacheEntry } from './cache.ts'
export { authorsOf, lastNameOf, parseBibtex, parseBibtexEntry, serializeBibtex, yearOf } from './bibtex.ts'
export type { BibEntry } from './bibtex.ts'
export { compareAuthors, compareTitle, compareVenue, compareYear, normalizeText, similarity } from './match.ts'
export { decodeXmlEntities, parseArxiv, parseCrossref, parsePubmed } from './providers.ts'
export type { CitationRecord, ProviderOutcome } from './providers.ts'
export {
  CiteInputError,
  correctedBibtex,
  normalizeArxiv,
  normalizeCitation,
  normalizeDoi,
  normalizePmid,
  verifyCitation,
} from './verify.ts'
export type {
  CitationInput,
  CiteInputErrorCode,
  NormalizedCitation,
  ResolvedSummary,
  VerificationOutcome,
  VerificationSnapshot,
  VerifyDeps,
} from './verify.ts'
export { CiteVerifyError, CiteVerifyRuntime, buildFieldAnchors, parseCitationToken } from './runtime.ts'
export type {
  CiteBatchItem,
  CiteBatchResult,
  CiteFixResult,
  CiteVerifyErrorCode,
  CiteVerifyResult,
  CiteVerifyRuntimeOptions,
  EvidencePort,
} from './runtime.ts'
export { makeCiteVerifyTool } from './tools/cite-verify.ts'
export { makeCiteBatchTool } from './tools/cite-batch.ts'
export { makeCiteFixTool } from './tools/cite-fix.ts'

/**
 * Mount the three tools.
 * @param ctx - the plugin context (host).
 * @param config - raw plugin config.
 */
export function apply(ctx: Context, config: ConfigShape): void {
  const resolved = resolveConfig(config)
  const logger = ctx.logger('cite-verify')
  if (!resolved.enabled) {
    logger.info('disabled: enabled is false — no tools are mounted')
    return
  }
  const service = ctx.get('researchEvidence') as EvidencePort | undefined
  const runtime = new CiteVerifyRuntime({ config: resolved, ...(service === undefined ? {} : { service }) })
  if (service === undefined) {
    logger.info(`ctx.researchEvidence is not mounted; using a local core store under ${resolved.root}`)
  }
  ctx.effect(() => ctx.tools.register(makeCiteVerifyTool(runtime)), 'cite-verify: cite_verify tool')
  ctx.effect(() => ctx.tools.register(makeCiteBatchTool(runtime)), 'cite-verify: cite_batch tool')
  ctx.effect(() => ctx.tools.register(makeCiteFixTool(runtime)), 'cite-verify: cite_fix tool')
}
