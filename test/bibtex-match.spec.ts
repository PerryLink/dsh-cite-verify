/**
 * BibTeX parsing and field comparison.
 * @module test/bibtex-match.spec
 */

import { describe, expect, it } from 'vitest'
import { authorsOf, lastNameOf, parseBibtex, parseBibtexEntry, serializeBibtex, yearOf } from '../src/bibtex.ts'
import { compareAuthors, compareTitle, compareVenue, compareYear, normalizeText, similarity } from '../src/match.ts'

describe('bibtex', () => {
  const entry = [
    '@article{doe2020,',
    '  title = {A {Nested} Study of Things},',
    '  author = {Doe, Jane and Roe, Richard},',
    '  year = {2020},',
    '  journal = {Journal of Tests},',
    '  doi = {10.1000/xyz}',
    '}',
  ].join('\n')

  it('parses type, key and fields, keeping nested braces and unknown fields', () => {
    const parsed = parseBibtexEntry(entry)
    expect(parsed?.type).toBe('article')
    expect(parsed?.key).toBe('doe2020')
    expect(parsed?.fields['title']).toBe('A {Nested} Study of Things')
    expect(parsed?.fields['doi']).toBe('10.1000/xyz')
  })

  it('parses quoted values and multiple entries', () => {
    const text = '@book{a, title = "One", year = 2001}\n@misc{b, note = {Two}}'
    const entries = parseBibtex(text)
    expect(entries.map(item => item.key)).toEqual(['a', 'b'])
    expect(entries[0]?.fields['title']).toBe('One')
    expect(entries[0]?.fields['year']).toBe('2001')
  })

  it('round-trips through the serializer', () => {
    const parsed = parseBibtexEntry(entry)!
    const text = serializeBibtex(parsed, { fieldOrder: ['title', 'author', 'year', 'journal', 'doi'] })
    expect(parseBibtexEntry(text)?.fields['title']).toBe('A {Nested} Study of Things')
    expect(text.startsWith('@article{doe2020,')).toBe(true)
  })

  it('splits authors and reads family names/years', () => {
    expect(authorsOf('Doe, Jane and Roe, Richard')).toEqual(['Doe, Jane', 'Roe, Richard'])
    expect(authorsOf('Jane Doe and others')).toEqual(['Jane Doe'])
    expect(lastNameOf('Doe, Jane')).toBe('doe')
    expect(lastNameOf('Jane Q. Doe')).toBe('doe')
    expect(yearOf(parseBibtexEntry(entry)!)).toBe(2020)
  })
})

describe('comparison', () => {
  it('normalizes punctuation and case', () => {
    expect(normalizeText('  A Study: of Things! ')).toBe('a study of things')
  })

  it('matches titles within the threshold and exposes missing tokens', () => {
    const exact = compareTitle('A study of things', 'A Study of Things.', 0.85)
    expect(exact.matched).toBe(true)
    expect(exact.similarity).toBe(1)
    const partial = compareTitle('A study of things', 'Completely different work', 0.85)
    expect(partial.matched).toBe(false)
    expect(partial.missingTokens.length).toBeGreaterThan(0)
  })

  it('compares authors by family name', () => {
    const comparison = compareAuthors(['Doe, Jane', 'Roe, Richard'], ['Jane Doe', 'Richard Roe', 'Smith, A'])
    expect(comparison.missing).toEqual([])
    expect(comparison.ratio).toBe(1)
    expect(comparison.extra).toContain('smith')
  })

  it('treats a one-year difference as near', () => {
    expect(compareYear(2020, 2020)).toBe('match')
    expect(compareYear(2020, 2021)).toBe('near')
    expect(compareYear(2020, 2015)).toBe('mismatch')
    expect(compareYear(undefined, 2020)).toBe('unknown')
  })

  it('scores venues by token overlap', () => {
    expect(compareVenue('Journal of Tests', 'Journal of Tests').matched).toBe(true)
    expect(compareVenue('Journal of Tests', 'Proceedings of Something Else').matched).toBe(false)
    expect(similarity('', '')).toBe(1)
  })
})
