/**
 * Minimal BibTeX reader/writer.
 *
 * It handles the subset that reference managers emit — `@type{key, field =
 * {value}, ...}` with braced, quoted or bare values — and preserves unknown
 * fields so `cite_fix` can correct metadata without destroying the entry. It is
 * not a TeX engine: macros inside values are preserved verbatim.
 *
 * @module dsh-cite-verify/bibtex
 */

/** One parsed BibTeX entry. */
export interface BibEntry {
  /** Entry type, lowercased (`article`, `book`, …). */
  readonly type: string
  /** Citation key. */
  readonly key: string
  /** Fields in source order (names lowercased, values without the outer braces). */
  readonly fields: Readonly<Record<string, string>>
}

/** Strip one layer of `{}` or `"` from a field value. */
function unwrap(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed.slice(1, -1)
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1)
  return trimmed
}

/** Split a field body on top-level commas (brace/quote aware). */
function splitFields(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inQuotes = false
  let current = ''
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!
    if (char === '"' && !inQuotes) {
      inQuotes = true
      current += char
      continue
    }
    if (char === '"' && inQuotes) {
      inQuotes = false
      current += char
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') depth -= 1
    if (char === ',' && depth === 0 && !inQuotes) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim() !== '') parts.push(current)
  return parts
}

/**
 * Parse every BibTeX entry in a string.
 * @param input - BibTeX text (may contain comments and multiple entries).
 * @returns the parsed entries.
 */
export function parseBibtex(input: string): BibEntry[] {
  const entries: BibEntry[] = []
  const opener = /@([a-zA-Z]+)\s*[{(]\s*([^,\s{}()]+)\s*,/gu
  for (const match of input.matchAll(opener)) {
    const type = match[1]!.toLowerCase()
    const key = match[2]!
    const bodyStart = match.index + match[0].length
    let depth = 1
    let index = bodyStart
    let inQuotes = false
    for (; index < input.length; index += 1) {
      const char = input[index]!
      if (char === '"' && input[index - 1] !== '\\') inQuotes = !inQuotes
      if (inQuotes) continue
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    const body = input.slice(bodyStart, index)
    const fields: Record<string, string> = {}
    for (const part of splitFields(body)) {
      const separator = part.indexOf('=')
      if (separator === -1) continue
      const name = part.slice(0, separator).trim().toLowerCase()
      const value = part.slice(separator + 1)
      if (name === '' || value.trim() === '') continue
      fields[name] = unwrap(value)
    }
    entries.push({ type, key, fields })
  }
  return entries
}

/**
 * Parse the first entry of a BibTeX string.
 * @param input - BibTeX text.
 * @returns the entry, or undefined when the text carries none.
 */
export function parseBibtexEntry(input: string): BibEntry | undefined {
  return parseBibtex(input)[0]
}

/**
 * Serialize one entry back to BibTeX.
 * @param entry - the entry.
 * @param options - `fieldOrder` puts known fields first; the rest follow.
 * @returns the BibTeX text.
 */
export function serializeBibtex(entry: BibEntry, options: { fieldOrder?: readonly string[] } = {}): string {
  const order = options.fieldOrder ?? []
  const keys = Object.keys(entry.fields)
  const ordered = [...order.filter(key => keys.includes(key)), ...keys.filter(key => !order.includes(key))]
  const lines = [`@${entry.type}{${entry.key},`]
  for (const key of ordered) {
    lines.push(`  ${key} = {${entry.fields[key] ?? ''}},`)
  }
  lines.push('}')
  return lines.join('\n')
}

/**
 * Split a BibTeX author field into individual authors.
 * @param value - the `author` field value.
 * @returns the authors in source order.
 */
export function authorsOf(value: string): string[] {
  return value
    .split(/\s+and\s+/iu)
    .map(author => author.trim())
    .filter(author => author !== '' && author !== 'others')
}

/**
 * Extract the family/last name from an author string.
 * @param author - `"Doe, John"`, `"John Doe"` or an organization.
 * @returns the lowercased family name.
 */
export function lastNameOf(author: string): string {
  const clean = author.replace(/\s+/gu, ' ').trim()
  const comma = clean.indexOf(',')
  if (comma !== -1) return clean.slice(0, comma).trim().toLowerCase()
  const parts = clean.split(' ')
  return (parts.at(-1) ?? clean).toLowerCase()
}

/**
 * Read the year from a BibTeX entry (`year`, else the first 4 digits of `date`).
 * @param entry - the entry.
 * @returns the year, or undefined.
 */
export function yearOf(entry: BibEntry): number | undefined {
  const year = entry.fields['year']
  if (year !== undefined) {
    const match = /\d{4}/u.exec(year)
    if (match !== null) return Number(match[0])
  }
  const date = entry.fields['date']
  if (date !== undefined) {
    const match = /\d{4}/u.exec(date)
    if (match !== null) return Number(match[0])
  }
  return undefined
}
