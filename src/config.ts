/**
 * Config schema and resolution for `dsh-cite-verify`.
 *
 * Network behaviour is bounded and explicit: an allowlist, timeouts, a
 * per-host minimum interval, a bounded redirect chain and a cache TTL. Anything
 * outside those bounds fails loud instead of silently degrading.
 * @module dsh-cite-verify/config
 */

import path from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Raw plugin config — every field optional. */
export interface Config {
  /** Master switch. `false` mounts nothing. */
  enabled?: boolean
  /** Store/cache root, resolved against the harness working directory. */
  root?: string
  /** `User-Agent` sent to metadata APIs (include a contact address when possible). */
  userAgent?: string
  /** Contact e-mail appended to PubMed E-utilities requests. */
  mailto?: string
  /** Per-request deadline in milliseconds. */
  timeoutMs?: number
  /** Minimum delay between two requests to the same host. */
  minIntervalMs?: number
  /** Bounded retries for 429/503 responses (0 = no retry). */
  retries?: number
  /** Maximum redirects followed per request (each hop re-validated). */
  maxRedirects?: number
  /** Cache lifetime for provider responses (0 disables the cache). */
  cacheTtlMs?: number
  /** Title similarity threshold (0–1) above which a title is considered matching. */
  titleThreshold?: number
  /** Default concurrency for `cite_batch`. */
  batchConcurrency?: number
  /** Hard cap on items per `cite_batch` call. */
  maxBatch?: number
}

/** Fully resolved config. */
export interface ResolvedConfig {
  readonly enabled: boolean
  readonly root: string
  readonly userAgent: string
  readonly mailto: string | undefined
  readonly timeoutMs: number
  readonly minIntervalMs: number
  readonly retries: number
  readonly maxRedirects: number
  readonly cacheTtlMs: number
  readonly titleThreshold: number
  readonly batchConcurrency: number
  readonly maxBatch: number
}

/** Schemastery schema: the loader validates and fills defaults before `apply`. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  root: z.string().default('.cite-verify'),
  userAgent: z.string().default('dsh-cite-verify/0.1.0 (https://github.com/PerryLink/dsh-cite-verify)'),
  mailto: z.string(),
  timeoutMs: z.number().default(15_000),
  minIntervalMs: z.number().default(150),
  retries: z.number().default(1),
  maxRedirects: z.number().default(3),
  cacheTtlMs: z.number().default(7 * 24 * 60 * 60 * 1000),
  titleThreshold: z.number().default(0.85),
  batchConcurrency: z.number().default(3),
  maxBatch: z.number().default(50),
})

/** Throw unless the value is a non-negative safe integer. */
function assertNonNegativeInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer, got ${String(value)}`)
  }
}

/**
 * Validate raw values and fill explicit defaults.
 * @param config - raw (possibly partial) plugin config.
 * @returns the fully resolved config.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const root = config.root ?? '.cite-verify'
  if (typeof root !== 'string' || root.trim() === '') throw new TypeError('root must be a non-empty path')
  const timeoutMs = config.timeoutMs ?? 15_000
  const minIntervalMs = config.minIntervalMs ?? 150
  const retries = config.retries ?? 1
  const maxRedirects = config.maxRedirects ?? 3
  const cacheTtlMs = config.cacheTtlMs ?? 7 * 24 * 60 * 60 * 1000
  const batchConcurrency = config.batchConcurrency ?? 3
  const maxBatch = config.maxBatch ?? 50
  for (const [name, value] of Object.entries({ timeoutMs, minIntervalMs, retries, maxRedirects, cacheTtlMs, batchConcurrency, maxBatch })) {
    assertNonNegativeInt(name, value)
  }
  if (timeoutMs <= 0) throw new TypeError('timeoutMs must be positive')
  if (batchConcurrency <= 0) throw new TypeError('batchConcurrency must be positive')
  if (maxBatch <= 0) throw new TypeError('maxBatch must be positive')
  const titleThreshold = config.titleThreshold ?? 0.85
  if (!(titleThreshold > 0 && titleThreshold <= 1)) {
    throw new TypeError(`titleThreshold must be in (0, 1], got ${String(titleThreshold)}`)
  }
  return {
    enabled: config.enabled ?? true,
    root: path.resolve(root),
    userAgent: config.userAgent ?? 'dsh-cite-verify/0.1.0 (https://github.com/PerryLink/dsh-cite-verify)',
    ...(config.mailto === undefined || config.mailto.trim() === '' ? { mailto: undefined } : { mailto: config.mailto }),
    timeoutMs,
    minIntervalMs,
    retries,
    maxRedirects,
    cacheTtlMs,
    titleThreshold,
    batchConcurrency,
    maxBatch,
  }
}
