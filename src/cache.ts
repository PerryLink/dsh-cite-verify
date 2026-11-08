/**
 * Response cache.
 *
 * Provider responses are cached by `<provider>:<identifier>` so repeated
 * verifications (and `cite_batch` runs) do not hammer the APIs. The cache is
 * best-effort: a read or write failure is a cache miss, never a verification
 * failure. `fresh` bypasses it entirely.
 *
 * @module dsh-cite-verify/cache
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { sha256Hex } from '@perrylink/dsh-research-core'

/** One cached provider response. */
export interface CacheEntry {
  readonly provider: string
  readonly at: number
  readonly url: string
  readonly status: number
  readonly body: string
  readonly contentType: string
}

/** A TTL-bounded on-disk cache. */
export class ResponseCache {
  readonly #root: string
  readonly #ttlMs: number
  readonly #now: () => number

  constructor(root: string, ttlMs: number, now: () => number = Date.now) {
    this.#root = path.resolve(root)
    this.#ttlMs = ttlMs
    this.#now = now
  }

  /** Absolute cache directory. */
  get directory(): string {
    return path.join(this.#root, 'cache')
  }

  /** The file backing one key. */
  #file(key: string): string {
    return path.join(this.directory, `${sha256Hex(key)}.json`)
  }

  /**
   * Read one cached response.
   * @param key - `<provider>:<identifier>`.
   * @returns the entry when present and fresh.
   */
  async get(key: string): Promise<CacheEntry | undefined> {
    if (this.#ttlMs <= 0) return undefined
    try {
      const parsed = JSON.parse(await readFile(this.#file(key), 'utf8')) as CacheEntry
      if (typeof parsed.at !== 'number' || typeof parsed.body !== 'string') return undefined
      if (this.#now() - parsed.at > this.#ttlMs) return undefined
      return parsed
    } catch {
      return undefined
    }
  }

  /**
   * Store one response (best effort).
   * @param key - `<provider>:<identifier>`.
   * @param entry - the response.
   */
  async put(key: string, entry: CacheEntry): Promise<void> {
    if (this.#ttlMs <= 0) return
    try {
      await mkdir(this.directory, { recursive: true })
      await writeFile(this.#file(key), JSON.stringify(entry), 'utf8')
    } catch {
      // A cache write failure must never fail the verification.
    }
  }
}
