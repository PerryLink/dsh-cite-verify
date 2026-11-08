/**
 * Field comparison for citation metadata.
 *
 * Everything is deterministic: normalized token sets and exact year rules.
 * No embeddings, no fuzzy black boxes — the caller gets the similarity value
 * and the mismatching tokens, so a human can re-check in seconds.
 *
 * @module dsh-cite-verify/match
 */

import { lastNameOf } from './bibtex.ts'
import { stripDiacritics } from './text.ts'

/**
 * Normalize text for comparison: NFKC, diacritics removed, lowercase,
 * punctuation → space, whitespace collapsed. CJK characters are kept as-is.
 * @param value - the raw text.
 * @returns the normalized text.
 */
export function normalizeText(value: string): string {
  return stripDiacritics(value.normalize('NFKC'))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * Token set for similarity: words, or character bigrams for scripts without
 * spaces (Chinese/Japanese titles).
 * @param value - the raw text.
 * @returns the token set.
 */
export function tokensOf(value: string): string[] {
  const normalized = normalizeText(value).replace(/\s+/gu, ' ').trim()
  if (normalized === '') return []
  if (!normalized.includes(' ') && normalized.length > 4) {
    const grams: string[] = []
    for (let index = 0; index + 2 <= normalized.length; index += 1) grams.push(normalized.slice(index, index + 2))
    return grams
  }
  return normalized.split(' ')
}

/**
 * Sørensen–Dice coefficient over token sets.
 * @param left - one text.
 * @param right - the other text.
 * @returns similarity in [0, 1].
 */
export function similarity(left: string, right: string): number {
  const a = new Set(tokensOf(left))
  const b = new Set(tokensOf(right))
  if (a.size === 0 || b.size === 0) return a.size === b.size ? 1 : 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return (2 * shared) / (a.size + b.size)
}

/** The title comparison outcome. */
export interface TitleComparison {
  readonly similarity: number
  readonly matched: boolean
  readonly expectedTokens: string[]
  readonly missingTokens: string[]
}

/**
 * Compare an expected title with the resolved one.
 * @param expected - the title as cited.
 * @param actual - the title the provider returned.
 * @param threshold - similarity threshold.
 * @returns the comparison.
 */
export function compareTitle(expected: string, actual: string, threshold: number): TitleComparison {
  const expectedTokens = tokensOf(expected)
  const actualTokens = new Set(tokensOf(actual))
  const missingTokens = expectedTokens.filter(token => !actualTokens.has(token))
  const value = similarity(expected, actual)
  // A cited title that is a complete prefix of the real one (subtitle omitted)
  // is a citation style, not a wrong title. Require a minimum token count so a
  // single generic word cannot "contain" an unrelated title.
  const contained = expectedTokens.length >= 3 && missingTokens.length === 0
  return { similarity: Number(value.toFixed(4)), matched: contained || value >= threshold, expectedTokens, missingTokens }
}

/** The author comparison outcome. */
export interface AuthorComparison {
  readonly matched: string[]
  readonly missing: string[]
  readonly extra: string[]
  readonly ratio: number
}

/**
 * Compare author lists by family name.
 * @param expected - authors as cited.
 * @param actual - authors as resolved.
 * @returns the comparison.
 */
export function compareAuthors(expected: readonly string[], actual: readonly string[]): AuthorComparison {
  const expectedNames = [...new Set(expected.map(lastNameOf))]
  const actualNames = new Set(actual.map(lastNameOf))
  const matched = expectedNames.filter(name => actualNames.has(name))
  const missing = expectedNames.filter(name => !actualNames.has(name))
  const extra = [...actualNames].filter(name => !expectedNames.includes(name))
  return {
    matched,
    missing,
    extra,
    ratio: expectedNames.length === 0 ? 1 : Number((matched.length / expectedNames.length).toFixed(4)),
  }
}

/** The year comparison outcome. */
export type YearComparison = 'match' | 'near' | 'mismatch' | 'unknown'

/**
 * Compare publication years. ±1 counts as `near` (online-first vs issue year).
 * @param expected - the cited year.
 * @param actual - the resolved year.
 * @returns the comparison bucket.
 */
export function compareYear(expected: number | undefined, actual: number | undefined): YearComparison {
  if (expected === undefined || actual === undefined) return 'unknown'
  if (expected === actual) return 'match'
  if (Math.abs(expected - actual) === 1) return 'near'
  return 'mismatch'
}

/**
 * Compare venue strings (journal/conference names).
 * @param expected - the cited venue.
 * @param actual - the resolved venue.
 * @param threshold - similarity threshold.
 * @returns similarity in [0, 1].
 */
export function compareVenue(expected: string | undefined, actual: string | undefined, threshold = 0.6): { similarity: number; matched: boolean } {
  if (expected === undefined || actual === undefined) return { similarity: 0, matched: false }
  const value = similarity(expected, actual)
  return { similarity: Number(value.toFixed(4)), matched: value >= threshold }
}
