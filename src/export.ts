/**
 * Citation export formats.
 *
 * One resolved record, seven serializations: GB/T 7714 (numeric), APA 7, IEEE,
 * Vancouver, BibTeX, RIS and CSL-JSON. Formatting is deterministic and
 * dependency-free; missing fields are reported instead of guessed. Title case
 * is never rewritten — the caller's title is preserved.
 *
 * @module dsh-cite-verify/export
 */

import { serializeBibtex, type BibEntry } from './bibtex.ts'
import { stripDiacritics } from './text.ts'
import type { ResolvedSummary } from './verify.ts'

/** Every supported export style. */
export const CITATION_STYLES = [
  'gbt7714-numeric',
  'apa',
  'ieee',
  'vancouver',
  'bibtex',
  'ris',
  'csl-json',
] as const

/** One supported export style. */
export type CitationStyle = (typeof CITATION_STYLES)[number]

/** Extra bibliographic fields not carried by every provider record. */
export interface CitationExtras {
  /** Volume, when the caller has it and the provider did not. */
  readonly volume?: string
  /** Issue/number. */
  readonly issue?: string
  /** Pages (e.g. `1-10`). */
  readonly pages?: string
  /** Publisher, for books/reports. */
  readonly publisher?: string
  /** Landing page or PDF URL. */
  readonly url?: string
  /** Language hint for CJK author lists (`zh` selects 等 over et al.). */
  readonly language?: 'zh' | 'en'
  /** IEEE reference number (default 1). */
  readonly index?: number
}

/** One formatted citation. */
export interface CitationExport {
  readonly style: CitationStyle
  readonly entry: string
  /** Fields that were absent and therefore omitted from the entry. */
  readonly missing: readonly string[]
}

const STYLE_SET = new Set<string>(CITATION_STYLES)

/**
 * Narrow an arbitrary string to a supported style.
 * @param value - candidate style.
 * @returns true when the value is a {@link CitationStyle}.
 */
export function isCitationStyle(value: unknown): value is CitationStyle {
  return typeof value === 'string' && STYLE_SET.has(value)
}

/** One parsed personal name. */
interface NameParts {
  readonly family: string
  readonly given: string
  readonly cjk: boolean
}

function isCjk(text: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(text)
}

/**
 * Parse one author string into family/given parts.
 * Handles `Doe, Jane`, `Jane Doe`, PubMed's `Doe J`, CJK names and
 * single-token organizations.
 * @param raw - the author string.
 * @returns the parsed parts.
 */
export function parseName(raw: string): NameParts {
  const value = raw.replace(/\s+/gu, ' ').trim()
  if (value === '') return { family: '', given: '', cjk: false }
  if (isCjk(value)) return { family: value, given: '', cjk: true }
  const comma = value.indexOf(',')
  if (comma > 0) {
    const family = value.slice(0, comma).trim()
    const given = value.slice(comma + 1).trim()
    if (family !== '') return { family, given, cjk: false }
  }
  const parts = value.split(' ').filter(part => part !== '')
  if (parts.length === 1) return { family: parts[0] ?? value, given: '', cjk: false }
  const last = parts.at(-1) ?? ''
  // PubMed writes `Doe J`: the trailing initials are given names.
  if (/^[A-Z]{1,3}\.?$/u.test(last)) {
    return { family: parts.slice(0, -1).join(' '), given: last.replace(/\.$/u, ''), cjk: false }
  }
  return { family: last, given: parts.slice(0, -1).join(' '), cjk: false }
}

function initialsOf(given: string, dots: boolean): string {
  const letters = given
    .split(/[\s.\-]+/u)
    .filter(part => part !== '')
    .map(part => (part[0] ?? '').toUpperCase())
    .filter(letter => letter !== '')
  return dots ? letters.map(letter => `${letter}.`).join(' ') : letters.join('')
}

function cleanTitle(title: string): string {
  return title.replace(/\s+/gu, ' ').trim().replace(/[.?!]+$/u, '')
}

function endDot(text: string): string {
  return /[.?!]$/u.test(text) ? text : `${text}.`
}

function nameWithInitials(name: NameParts, dots: boolean, comma: boolean): string {
  if (name.cjk) return name.family
  const initials = initialsOf(name.given, dots)
  if (initials === '') return name.family
  return comma ? `${name.family}, ${initials}` : `${name.family} ${initials}`
}

function authorsOf(resolved: ResolvedSummary): NameParts[] {
  return resolved.authors.map(parseName).filter(name => name.family !== '')
}

function gbtAuthors(names: readonly NameParts[], zh: boolean): string {
  const shown = names.slice(0, 3).map(name => nameWithInitials(name, false, false))
  const suffix = names.length > 3 ? (zh ? ', 等' : ', et al') : ''
  return shown.join(', ') + suffix
}

function apaAuthors(names: readonly NameParts[]): string {
  const shown = names.map(name => nameWithInitials(name, true, true))
  if (shown.length === 0) return ''
  if (shown.length === 1) return shown[0] ?? ''
  if (shown.length === 2) return `${shown[0]}, & ${shown[1]}`
  return `${shown.slice(0, -1).join(', ')}, & ${shown.at(-1)}`
}

function ieeeAuthors(names: readonly NameParts[]): string {
  const shown = names.map(name => {
    if (name.cjk) return name.family
    const initials = initialsOf(name.given, true)
    return initials === '' ? name.family : `${initials} ${name.family}`
  })
  if (shown.length === 0) return ''
  if (shown.length === 1) return shown[0] ?? ''
  if (shown.length === 2) return `${shown[0]} and ${shown[1]}`
  return `${shown.slice(0, -1).join(', ')}, and ${shown.at(-1)}`
}

function vancouverAuthors(names: readonly NameParts[]): string {
  const shown = names.map(name => nameWithInitials(name, false, false))
  if (shown.length > 6) return `${shown.slice(0, 6).join(', ')}, et al`
  return shown.join(', ')
}

function normalizeType(type: string | undefined): string {
  return (type ?? '').toLowerCase().replace(/[^a-z]/gu, '')
}

const TYPE_MARKERS: Readonly<Record<string, string>> = {
  journalarticle: 'J',
  article: 'J',
  journal: 'J',
  book: 'M',
  bookchapter: 'M',
  chapter: 'M',
  conferencepaper: 'C',
  conference: 'C',
  inproceedings: 'C',
  proceedings: 'C',
  thesis: 'D',
  dissertation: 'D',
  report: 'R',
  techreport: 'R',
  standard: 'S',
  patent: 'P',
  webpage: 'EB/OL',
  website: 'EB/OL',
  dataset: 'DS',
}

function gbtMarker(type: string | undefined): string {
  const key = normalizeType(type)
  if (key === '') return 'J'
  return TYPE_MARKERS[key] ?? 'Z'
}

function bibType(type: string | undefined): string {
  switch (normalizeType(type)) {
    case 'journalarticle':
    case 'article':
    case 'journal':
      return 'article'
    case 'book':
      return 'book'
    case 'conferencepaper':
    case 'conference':
    case 'inproceedings':
      return 'inproceedings'
    case 'thesis':
    case 'dissertation':
      return 'phdthesis'
    case 'report':
    case 'techreport':
      return 'techreport'
    default:
      return 'misc'
  }
}

function cslType(type: string | undefined): string {
  switch (normalizeType(type)) {
    case 'journalarticle':
    case 'article':
    case 'journal':
      return 'article-journal'
    case 'book':
      return 'book'
    case 'conferencepaper':
    case 'conference':
    case 'inproceedings':
      return 'paper-conference'
    case 'thesis':
    case 'dissertation':
      return 'thesis'
    case 'report':
    case 'techreport':
      return 'report'
    case 'webpage':
    case 'website':
      return 'webpage'
    case 'dataset':
      return 'dataset'
    default:
      return 'article-journal'
  }
}

const RIS_TYPES: Readonly<Record<string, string>> = {
  journalarticle: 'JOUR',
  article: 'JOUR',
  journal: 'JOUR',
  book: 'BOOK',
  conferencepaper: 'CPAPER',
  conference: 'CPAPER',
  inproceedings: 'CPAPER',
  thesis: 'THES',
  dissertation: 'THES',
  report: 'RPRT',
  techreport: 'RPRT',
  webpage: 'ELEC',
  website: 'ELEC',
  dataset: 'DATA',
}

function bibKey(names: readonly NameParts[], year: number | undefined, title: string): string {
  const family = names[0] === undefined ? 'anon' : stripDiacritics(names[0].family).toLowerCase().replace(/[^a-z0-9]/gu, '')
  const word = stripDiacritics(cleanTitle(title))
    .toLowerCase()
    .split(/\s+/u)
    .map(part => part.replace(/[^a-z0-9]/gu, ''))
    .find(part => part !== '') ?? ''
  return `${family === '' ? 'anon' : family}${year ?? 'nd'}${word.slice(0, 12)}`.slice(0, 40)
}

function fieldsOf(resolved: ResolvedSummary, extras: CitationExtras): {
  readonly volume: string
  readonly issue: string
  readonly pages: string
  readonly publisher: string
} {
  return {
    volume: extras.volume ?? resolved.volume ?? '',
    issue: extras.issue ?? resolved.issue ?? '',
    pages: extras.pages ?? resolved.pages ?? '',
    publisher: extras.publisher ?? resolved.publisher ?? '',
  }
}

function gbt7714(resolved: ResolvedSummary, extras: CitationExtras, names: readonly NameParts[]): string {
  const zh = extras.language === 'zh' || names.some(name => name.cjk)
  const authors = gbtAuthors(names, zh)
  const title = cleanTitle(resolved.title ?? '')
  const { volume, issue, pages } = fieldsOf(resolved, extras)
  const marker = gbtMarker(resolved.type)
  const head = [authors === '' ? '' : `${authors}. `, `${title === '' ? '(题名缺失)' : title}[${marker}].`].join('')
  const source: string[] = []
  if (resolved.venue !== undefined && resolved.venue !== '') source.push(resolved.venue)
  if (resolved.year !== undefined) source.push(String(resolved.year))
  let tail = source.join(', ')
  const volumeIssue = `${volume}${issue === '' ? '' : `(${issue})`}`
  if (volumeIssue !== '') tail = tail === '' ? volumeIssue : `${tail}, ${volumeIssue}`
  if (pages !== '') tail = tail === '' ? pages : `${tail}: ${pages}`
  const doi = resolved.doi === undefined ? '' : ` DOI: ${resolved.doi}.`
  return `${head}${tail === '' ? '' : ` ${endDot(tail)}`}${doi}`.trim()
}

function apa(resolved: ResolvedSummary, extras: CitationExtras, names: readonly NameParts[]): string {
  const authors = apaAuthors(names)
  const year = resolved.year === undefined ? '(n.d.)' : `(${resolved.year})`
  const title = endDot(cleanTitle(resolved.title ?? '') || '(题名缺失)')
  const { volume, issue, pages } = fieldsOf(resolved, extras)
  const volumeIssue = `${volume}${issue === '' ? '' : `(${issue})`}`
  const pageText = pages === '' ? '' : pages.replace(/-/gu, '–')
  const source = [resolved.venue ?? '', volumeIssue, pageText].filter(part => part !== '').join(', ')
  const doi = resolved.doi === undefined ? (extras.url ?? '') : `https://doi.org/${resolved.doi}`
  return [
    `${authors === '' ? '(作者缺失)' : authors} ${year}. ${title}`,
    source === '' ? '' : endDot(source),
    doi,
  ]
    .filter(part => part !== '')
    .join(' ')
}

function ieee(resolved: ResolvedSummary, extras: CitationExtras, names: readonly NameParts[]): string {
  const authors = ieeeAuthors(names)
  const title = cleanTitle(resolved.title ?? '') || '(题名缺失)'
  const { volume, issue, pages } = fieldsOf(resolved, extras)
  // The comma after the title belongs inside the quotes in IEEE style, so the
  // title is part of the head rather than a joined segment.
  const head = `${authors === '' ? '(作者缺失)' : authors}, "${title},"`
  const tail: string[] = []
  if (resolved.venue !== undefined && resolved.venue !== '') tail.push(resolved.venue)
  if (volume !== '') tail.push(`vol. ${volume}`)
  if (issue !== '') tail.push(`no. ${issue}`)
  if (pages !== '') tail.push(`pp. ${pages}`)
  if (resolved.year !== undefined) tail.push(String(resolved.year))
  if (resolved.doi !== undefined) tail.push(`doi: ${resolved.doi}`)
  else if (extras.url !== undefined) tail.push(extras.url)
  return `[${extras.index ?? 1}] ${head}${tail.length === 0 ? '' : ` ${tail.join(', ')}`}.`
}

function vancouver(resolved: ResolvedSummary, extras: CitationExtras, names: readonly NameParts[]): string {
  const authors = vancouverAuthors(names)
  const title = endDot(cleanTitle(resolved.title ?? '') || '(题名缺失)')
  const { volume, issue, pages } = fieldsOf(resolved, extras)
  const journal = resolved.venue === undefined || resolved.venue === '' ? '' : endDot(resolved.venue)
  const locator = `${resolved.year === undefined ? '' : String(resolved.year)}${resolved.year === undefined ? '' : ';'}${volume}${issue === '' ? '' : `(${issue})`}${pages === '' ? '' : `:${pages}`}`
  const doi = resolved.doi === undefined ? '' : `doi: ${resolved.doi}.`
  return [`${authors === '' ? '(作者缺失)' : authors}. ${title}`, journal, locator === '' ? '' : endDot(locator), doi]
    .filter(part => part !== '')
    .join(' ')
}

function bibtex(resolved: ResolvedSummary, extras: CitationExtras, names: readonly NameParts[]): string {
  const { volume, issue, pages, publisher } = fieldsOf(resolved, extras)
  const type = bibType(resolved.type)
  const fields: Record<string, string> = {}
  if (names.length > 0) {
    fields.author = names
      .map(name => (name.cjk ? name.family : name.given === '' ? name.family : `${name.family}, ${name.given}`))
      .join(' and ')
  }
  if (resolved.title !== undefined && resolved.title !== '') fields.title = cleanTitle(resolved.title)
  if (resolved.venue !== undefined && resolved.venue !== '') fields[type === 'inproceedings' ? 'booktitle' : 'journal'] = resolved.venue
  if (resolved.year !== undefined) fields.year = String(resolved.year)
  if (volume !== '') fields.volume = volume
  if (issue !== '') fields.number = issue
  if (pages !== '') fields.pages = pages
  if (publisher !== '') fields.publisher = publisher
  if (resolved.doi !== undefined) fields.doi = resolved.doi
  if (extras.url !== undefined) fields.url = extras.url
  const sanitized: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields)) sanitized[key] = value.replace(/[{}]/gu, '')
  const entry: BibEntry = {
    type,
    key: bibKey(names, resolved.year, resolved.title ?? ''),
    fields: sanitized,
  }
  return serializeBibtex(entry, {
    fieldOrder: ['author', 'title', 'journal', 'booktitle', 'year', 'volume', 'number', 'pages', 'publisher', 'doi', 'url'],
  })
}

function ris(resolved: ResolvedSummary, extras: CitationExtras, names: readonly NameParts[]): string {
  const { volume, issue, pages, publisher } = fieldsOf(resolved, extras)
  const lines = [`TY  - ${RIS_TYPES[normalizeType(resolved.type)] ?? 'JOUR'}`]
  for (const name of names) {
    lines.push(`AU  - ${name.cjk ? name.family : name.given === '' ? name.family : `${name.family}, ${name.given}`}`)
  }
  if (resolved.title !== undefined && resolved.title !== '') lines.push(`TI  - ${cleanTitle(resolved.title)}`)
  if (resolved.venue !== undefined && resolved.venue !== '') lines.push(`JO  - ${resolved.venue}`)
  if (resolved.year !== undefined) lines.push(`PY  - ${resolved.year}`)
  if (volume !== '') lines.push(`VL  - ${volume}`)
  if (issue !== '') lines.push(`IS  - ${issue}`)
  if (pages !== '') {
    const [start, end] = pages.split('-')
    if (start !== undefined && start !== '') lines.push(`SP  - ${start}`)
    if (end !== undefined && end !== '') lines.push(`EP  - ${end}`)
  }
  if (publisher !== '') lines.push(`PB  - ${publisher}`)
  if (resolved.doi !== undefined) lines.push(`DO  - ${resolved.doi}`)
  if (extras.url !== undefined) lines.push(`UR  - ${extras.url}`)
  lines.push('ER  -')
  return lines.join('\n')
}

function cslJson(resolved: ResolvedSummary, extras: CitationExtras, names: readonly NameParts[]): string {
  const { volume, issue, pages, publisher } = fieldsOf(resolved, extras)
  const author = names.map(name => {
    if (name.cjk) return { literal: name.family }
    return name.given === '' ? { family: name.family } : { family: name.family, given: name.given }
  })
  const record: Record<string, unknown> = {
    id: bibKey(names, resolved.year, resolved.title ?? ''),
    type: cslType(resolved.type),
  }
  if (resolved.title !== undefined && resolved.title !== '') record.title = cleanTitle(resolved.title)
  if (author.length > 0) record.author = author
  if (resolved.year !== undefined) record.issued = { 'date-parts': [[resolved.year]] }
  if (resolved.venue !== undefined && resolved.venue !== '') record['container-title'] = resolved.venue
  if (volume !== '') record.volume = volume
  if (issue !== '') record.issue = issue
  if (pages !== '') record.page = pages
  if (publisher !== '') record.publisher = publisher
  if (resolved.doi !== undefined) record.DOI = resolved.doi
  if (extras.url !== undefined) record.URL = extras.url
  return JSON.stringify(record, null, 2)
}

/**
 * Format one resolved citation.
 * @param resolved - the provider record summary.
 * @param style - the target style.
 * @param extras - fields the provider did not carry.
 * @returns the formatted entry plus the fields that were missing.
 */
export function exportCitation(
  resolved: ResolvedSummary,
  style: CitationStyle,
  extras: CitationExtras = {},
): CitationExport {
  const names = authorsOf(resolved)
  const missing: string[] = []
  if (resolved.title === undefined || resolved.title === '') missing.push('title')
  if (names.length === 0) missing.push('authors')
  if (resolved.year === undefined) missing.push('year')
  if ((resolved.venue === undefined || resolved.venue === '') && gbtMarker(resolved.type) === 'J') missing.push('venue')

  let entry: string
  switch (style) {
    case 'gbt7714-numeric':
      entry = gbt7714(resolved, extras, names)
      break
    case 'apa':
      entry = apa(resolved, extras, names)
      break
    case 'ieee':
      entry = ieee(resolved, extras, names)
      break
    case 'vancouver':
      entry = vancouver(resolved, extras, names)
      break
    case 'bibtex':
      entry = bibtex(resolved, extras, names)
      break
    case 'ris':
      entry = ris(resolved, extras, names)
      break
    case 'csl-json':
      entry = cslJson(resolved, extras, names)
      break
  }
  return { style, entry, missing }
}
