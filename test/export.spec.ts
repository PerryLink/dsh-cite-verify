/**
 * Export formatters: seven styles, deterministic strings, missing fields.
 * @module test/export.spec
 */

import { describe, expect, it } from 'vitest'
import { exportCitation, isCitationStyle, parseName } from '../src/export.ts'
import type { ResolvedSummary } from '../src/verify.ts'

const RECORD: ResolvedSummary = {
  provider: 'crossref',
  doi: '10.1000/xyz',
  title: 'A study of things',
  authors: ['Doe, Jane', 'Roe, Richard'],
  year: 2020,
  venue: 'Journal of Tests',
  volume: '12',
  issue: '3',
  pages: '1-10',
  publisher: 'Test Press',
  type: 'journal-article',
}

describe('name parsing', () => {
  it('parses comma, natural and PubMed forms', () => {
    expect(parseName('Doe, Jane')).toEqual({ family: 'Doe', given: 'Jane', cjk: false })
    expect(parseName('Jane Doe')).toEqual({ family: 'Doe', given: 'Jane', cjk: false })
    expect(parseName('Doe J')).toEqual({ family: 'Doe', given: 'J', cjk: false })
    expect(parseName('张三')).toEqual({ family: '张三', given: '', cjk: true })
  })
})

describe('style selection', () => {
  it('accepts only the seven supported styles', () => {
    expect(isCitationStyle('apa')).toBe(true)
    expect(isCitationStyle('gbt7714-numeric')).toBe(true)
    expect(isCitationStyle('mla')).toBe(false)
    expect(isCitationStyle(undefined)).toBe(false)
  })
})

describe('GB/T 7714', () => {
  it('formats authors, source, volume/issue and DOI', () => {
    const { entry, missing } = exportCitation(RECORD, 'gbt7714-numeric')
    expect(entry).toBe('Doe J, Roe R. A study of things[J]. Journal of Tests, 2020, 12(3): 1-10. DOI: 10.1000/xyz.')
    expect(missing).toEqual([])
  })

  it('uses 等 for four or more Chinese authors', () => {
    const chinese: ResolvedSummary = {
      provider: 'record',
      title: '中国研究',
      authors: ['张三', '李四', '王五', '赵六'],
      year: 2024,
      venue: '中国科学',
      type: 'journal-article',
    }
    const { entry } = exportCitation(chinese, 'gbt7714-numeric', { language: 'zh' })
    expect(entry).toContain('张三, 李四, 王五, 等')
    expect(entry).toContain('中国研究[J]')
    expect(entry).toContain('中国科学, 2024')
  })
})

describe('APA 7', () => {
  it('formats two authors, en dash pages and the DOI URL', () => {
    const { entry } = exportCitation(RECORD, 'apa')
    expect(entry).toContain('Doe, J., & Roe, R. (2020).')
    expect(entry).toContain('A study of things.')
    expect(entry).toContain('Journal of Tests, 12(3), 1–10.')
    expect(entry).toContain('https://doi.org/10.1000/xyz')
  })
})

describe('IEEE', () => {
  it('formats initials first, quoted title and numbered reference', () => {
    const { entry } = exportCitation(RECORD, 'ieee', { index: 4 })
    expect(entry).toBe('[4] J. Doe and R. Roe, "A study of things," Journal of Tests, vol. 12, no. 3, pp. 1-10, 2020, doi: 10.1000/xyz.')
  })
})

describe('Vancouver', () => {
  it('formats family + initials and the year;volume(issue):pages locator', () => {
    const { entry } = exportCitation(RECORD, 'vancouver')
    expect(entry).toBe('Doe J, Roe R. A study of things. Journal of Tests. 2020;12(3):1-10. doi: 10.1000/xyz.')
  })
})

describe('BibTeX', () => {
  it('emits an article entry with a deterministic key', () => {
    const { entry } = exportCitation(RECORD, 'bibtex')
    expect(entry).toContain('@article{doe2020a,')
    expect(entry).toContain('author = {Doe, Jane and Roe, Richard}')
    expect(entry).toContain('journal = {Journal of Tests}')
    expect(entry).toContain('number = {3}')
    expect(entry).toContain('doi = {10.1000/xyz}')
  })
})

describe('RIS', () => {
  it('emits the tagged format with start/end pages', () => {
    const { entry } = exportCitation(RECORD, 'ris')
    expect(entry).toContain('TY  - JOUR')
    expect(entry).toContain('AU  - Doe, Jane')
    expect(entry).toContain('SP  - 1')
    expect(entry).toContain('EP  - 10')
    expect(entry).toContain('DO  - 10.1000/xyz')
    expect(entry.endsWith('ER  -')).toBe(true)
  })
})

describe('CSL-JSON', () => {
  it('emits a structured item other tools can consume', () => {
    const { entry } = exportCitation(RECORD, 'csl-json')
    const parsed = JSON.parse(entry) as {
      id: string
      type: string
      author: Array<{ family: string; given: string }>
      issued: { 'date-parts': number[][] }
      volume: string
      page: string
      DOI: string
    }
    expect(parsed.type).toBe('article-journal')
    expect(parsed.author[0]).toEqual({ family: 'Doe', given: 'Jane' })
    expect(parsed.issued['date-parts'][0]?.[0]).toBe(2020)
    expect(parsed.volume).toBe('12')
    expect(parsed.page).toBe('1-10')
    expect(parsed.DOI).toBe('10.1000/xyz')
  })
})

describe('missing fields', () => {
  it('reports absent fields instead of inventing them', () => {
    const partial: ResolvedSummary = { provider: 'record', title: 'Only a title', authors: [] }
    const { missing, entry } = exportCitation(partial, 'gbt7714-numeric')
    expect(missing).toEqual(['authors', 'year', 'venue'])
    expect(entry).toContain('Only a title[J]')
  })
})
