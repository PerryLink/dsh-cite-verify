/**
 * Text normalization shared by title/author comparison.
 *
 * Diacritics and common non-decomposable letters are folded so `Müller` and
 * `Muller`, `Østergård` and `Ostergard`, `Straße` and `Strasse` compare equal:
 * a transliteration difference is a name form, not a different person.
 * @module dsh-cite-verify/text
 */

/** Letters that Unicode decomposition does not fold to ASCII. */
const TRANSLITERATE: Readonly<Record<string, string>> = {
  ø: 'o',
  Ø: 'O',
  æ: 'ae',
  Æ: 'AE',
  œ: 'oe',
  Œ: 'OE',
  ß: 'ss',
  ł: 'l',
  Ł: 'L',
  đ: 'd',
  Đ: 'D',
  ð: 'd',
  Ð: 'D',
  þ: 'th',
  Þ: 'TH',
  ı: 'i',
  ħ: 'h',
}

/**
 * Fold diacritics and the common non-decomposable letters.
 * @param value - the raw text.
 * @returns ASCII-folded text (other scripts are left untouched).
 */
export function stripDiacritics(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .normalize('NFC')
    .replace(/[øØæÆœŒßłŁđĐðÐþÞıħ]/gu, letter => TRANSLITERATE[letter] ?? letter)
}
