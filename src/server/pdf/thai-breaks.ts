// Where a line of Thai may break in a printed document (spec FR-PLT-009 AC3, ADR-044). react-pdf's textkit splits text
// at ASCII spaces only and asks a "hyphenation callback" to cut each space-free token into syllables; between two
// non-empty syllables it puts a penalty and draws a "-" when it breaks there, but an empty syllable becomes zero-width
// glue, where a break draws nothing. So Thai tokens are cut at Intl.Segmenter word boundaries with "" between words.

const THAI = /[฀-๿]/
/** Never end a line with an opening mark, never start one with a closing mark, ๆ or ฯ */
const OPENERS = /^[([{“‘«"']+$/
const CLOSERS = /^[)\]}”’»"'.,:;!?%ๆฯ]+$/
// ICU's dictionary does not know every loanword (เมทัลชีท → เมทั|ล|ชีท): a piece ending with mai han-akat or a leading
// vowel cannot end a syllable, one starting with a combining mark or a following vowel cannot start one, and a lone
// consonant is almost always the tail of the previous syllable — those are glued to a neighbour.
const CANNOT_END = /[ัเ-ไ]$/
const CANNOT_START = /^[ะ-ฺๅ็-๎]/
const LONE_CONSONANT = /^[ก-ฮ]$/

const segmenter = new Intl.Segmenter('th', { granularity: 'word' })

/** The Thai word pieces of one space-free token */
export function thaiWords(token: string): string[] {
  if (!THAI.test(token)) return [token]
  const pieces: string[] = []
  let carry = ''
  for (const { segment } of segmenter.segment(token)) {
    const previous = pieces.at(-1)
    if (OPENERS.test(segment)) {
      carry += segment
      continue
    }
    if (previous !== undefined && !carry && (CLOSERS.test(segment) || CANNOT_START.test(segment) || CANNOT_END.test(previous) || LONE_CONSONANT.test(segment))) {
      pieces[pieces.length - 1] = previous + segment
      continue
    }
    pieces.push(carry + segment)
    carry = ''
  }
  if (carry) {
    if (pieces.length) pieces[pieces.length - 1] += carry
    else pieces.push(carry)
  }
  return pieces
}

/**
 * Sara am (U+0E33) as nikhahit + sara aa (U+0E4D U+0E32), the glyphs Sarabun's own ccmp makes. fontkit 2.0.4 keeps the
 * code points of the first glyph it builds per glyph id, so the extra า of that substitution reports different code
 * points from one run to the next and shifts textkit's text-to-glyph map: letters at line ends vanish and lines break
 * inside words. Fed the pair, fontkit never runs that substitution and draws the same glyphs. The PDF's text layer
 * then holds ํา for ำ (copying and searching see the pair).
 */
export const decomposeSaraAm = (text: string): string => text.replace(/ำ/g, 'ํา')

/**
 * The callback react-pdf's Font.registerHyphenationCallback takes. textkit passes every space-free token of every
 * Text through it before shaping, so it is also the one place where sara am is decomposed: break chances only, never a
 * hyphen, never a raw U+0E33 reaching fontkit. Words are found in the original spelling (ICU knows ำ, not ํา).
 */
export function thaiHyphenationCallback(word: string): string[] {
  if (!word || word.trim() === '') return [word]
  const pieces = thaiWords(word).map(decomposeSaraAm)
  if (pieces.length < 2) return pieces
  return pieces.flatMap((piece, i) => (i === 0 ? [piece] : ['', piece]))
}
