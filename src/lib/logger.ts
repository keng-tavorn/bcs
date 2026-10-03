import pino, { type Bindings, type ChildLoggerOptions, type DestinationStream, type Logger, type SerializerFn } from 'pino'

// Structured JSON logs (pino). NFR-SEC-09: logs never contain passwords, PINs, tokens, secrets, full bank account
// or card numbers, or national ID numbers. FR-PLT-008 AC3: error reports carry no personal data. Redaction happens
// here, at the logger, for every log line:
//   1. a value under a key that names a secret, in English or Thai, is replaced at any depth: log objects, child
//      bindings, setBindings, printf arguments, [name, value] lists ([...headers], Object.entries) and argv lists
//      (--token x). A key that describes a secret (pinFailedCount, tokenExpiresAt) keeps a number, a boolean or a
//      date, nothing else;
//   2. text is scrubbed: the message after printf interpolation and msgPrefix, error messages and stacks, string
//      values and object keys. It loses key/value pairs that name a secret (bare, quoted, JSON-escaped, a {…} / […]
//      block, a command-line flag, an XML element, a percent-encoded query parameter, every cookie of a Cookie or
//      Set-Cookie header), URL passwords, one-time link tokens, bearer credentials, PINs, OTPs and passwords
//      announced in English or Thai prose, the local part of e-mail addresses (somchai@example.com →
//      [REDACTED]@example.com: personal data under PDPA; the domain stays for debugging), and national ID, bank
//      account and card numbers written contiguously, in their printed groups or in Thai digits;
//   3. a child logger cannot opt out: its own serializers, formatters and message prefix are redacted as well.
// Every 10–13 digit integer is redacted, in text and as a number value, because it may be an account or a national
// ID number: log times as ISO strings, never as epoch numbers. BigInt values pass unchanged: they carry money
// (satang) and sequence numbers, never IDs or account numbers. UUIDs and hex identifiers (32+ hex digits, or a
// letter and 24+ as in a LINE user ID) keep their digits, except a 13-digit run that passes the national ID check
// digit. Document numbers stay readable. Names cannot be detected reliably and are not redacted: do not log raw
// driver messages that may echo them.
// Bind requestId / correlationId / organizationId with logger.child({...}) (NFR-OBS-01).

export const REDACTED = '[REDACTED]'

// ---------------------------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------------------------

// Compared lower-cased with separators removed: x-api-key → xapikey, INNGEST_SIGNING_KEY → inngestsigningkey
const SECRET_KEY_PART = new RegExp(
  [
    'password|passwd|passphrase|passcode|passkey|passport|token|secret|authori[sz]ation|cookie|session|credential',
    'signature|jwt|csrf|xsrf|apikey|privatekey|signingkey|encryptionkey|eventkey|masterkey|licensekey',
    'otpauth|totp|twofactor|backupcode|recoverycode|codeverifier',
    '(?:verification|confirmation|security|activation|reset|auth|access|login|mfa|sms|onetime)code',
    'accountno|accountnumber|bankaccount|cardnumber|nationalid|citizenid|idcard',
  ].join('|'),
)
// Whole words of a key: pw, cvv, sid (session ID), hmac, bearer, verifier (PKCE)
const SECRET_KEY_WORDS = new Set(['pw', 'cvv', 'cvc', 'sid', 'hmac', 'bearer', 'verifier'])
// Thai field names: รหัสผ่าน (password), รหัสพิน, รหัส OTP, รหัสยืนยัน (verification code), เลขบัตรประชาชน and
// เลขประจำตัวประชาชน (national ID), เลขบัญชี (account number)
const THAI_SECRET_KEY = /รหัสผ่าน|รหัสพิน|รหัสลับ|รหัสยืนยัน|รหัส ?(?:pin|otp)|โอทีพี|บัตรประชาชน|ประจำตัวประชาชน|เลขบัญชี|โทเค็น/i
// The last word of a key: auth (http.request({ auth: 'user:password' })), basicAuth; not authProvider or authType
const SECRET_LAST_WORDS = new Set(['auth'])
// pin, otp, pass and pwd inside a one-word name, at its end or before a suffix: pins, newpin, PGPASS, smsotp, dbpwd,
// pincode, pinhash, transactionpinhash (Postgres folds unquoted column names to lower case), otpcode, passkey
const SHORT_SECRET = /(?:pin|otp|pass|pwd)s?$/
const SHORT_SECRET_SUFFIX = /(?:code|hash|hashed|number|no|key|block|value|digest)s?$/
// Ordinary words that end the same way (shipping, pinned, spinner, footprint and opinion do not). bypass is not
// one of them: x-vercel-protection-bypass carries a secret, and a boolean bypass flag stays readable anyway.
const LOOKALIKE_WORDS = new Set([
  'spin', 'backspin', 'sidespin', 'tailspin', 'topspin', 'hairpin', 'hatpin', 'kingpin', 'linchpin', 'pushpin', 'tenpin',
  'tiepin', 'clothespin', 'compass', 'encompass', 'overpass', 'underpass', 'surpass', 'trespass',
])
// A key that names a secret but ends in one of these describes it: pinFailedCount, pinLockedUntil, tokenExpiresAt.
// It keeps a value of that shape (a number, a boolean, a date or an ISO date string); any other value is redacted.
const METADATA_WORDS = new Set(['count', 'attempts', 'at', 'until', 'expires', 'expiry', 'ttl', 'length', 'enabled', 'required'])
const METADATA_TEXT = /^(?:-?\d{1,5}(?:\.\d+)?|\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d(?::?\d\d)?)?)?|true|false)$/

type KeyKind = 'plain' | 'secret' | 'metadata'

// Lower-cased words of a key: transactionPINHash → transaction pin hash, pin2 → pin 2. Zero-width splits stay
// linear on long keys.
function keyWords(key: string): string[] {
  return key
    .replace(/(?<=[a-z\d])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/g, ' ')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(Boolean)
}

function endsInShortSecret(word: string): boolean {
  return SHORT_SECRET.test(word) && !LOOKALIKE_WORDS.has(word) && !LOOKALIKE_WORDS.has(word.replace(/s$/, ''))
}

function isSecretWord(word: string): boolean {
  return SECRET_KEY_WORDS.has(word) || endsInShortSecret(word) || endsInShortSecret(word.replace(SHORT_SECRET_SUFFIX, ''))
}

function keyKind(key: string): KeyKind {
  const words = keyWords(key)
  const last = words.findLast((word) => /[a-z]/.test(word)) ?? ''
  const named =
    SECRET_KEY_PART.test(words.join('')) || words.some(isSecretWord) || SECRET_LAST_WORDS.has(last) || THAI_SECRET_KEY.test(key)
  if (!named) return 'plain'
  return METADATA_WORDS.has(last) ? 'metadata' : 'secret'
}

// The same field names come back on every log line, so their kind is cached; the cache is bounded and holds only
// short names, so hostile keys cannot grow it
const KEY_KINDS = new Map<string, KeyKind>()

function classifyKey(key: string): KeyKind {
  const cached = KEY_KINDS.get(key)
  if (cached) return cached
  const kind = keyKind(key)
  if (key.length <= 64) {
    if (KEY_KINDS.size >= 500) KEY_KINDS.clear()
    KEY_KINDS.set(key, kind)
  }
  return kind
}

// --key=x and --key x name a secret on a command line, unlike a cache key or a React key in an object
function classifyFlag(flag: string): KeyKind {
  return /^-+key$/i.test(flag) ? 'secret' : classifyKey(flag)
}

/** Whether a value under a key of this kind is replaced as a whole. Booleans and null never hold a secret. */
function hides(kind: KeyKind, value: unknown): boolean {
  if (kind === 'plain' || value === null || value === undefined || typeof value === 'boolean') return false
  if (kind === 'secret') return true
  const metadata =
    typeof value === 'number' || typeof value === 'bigint' || value instanceof Date || (typeof value === 'string' && METADATA_TEXT.test(value))
  return !metadata
}

// ---------------------------------------------------------------------------------------------------------------
// Key/value pairs inside text: password=x, "token":"x", {\"pin\":\"x\"}, data: { password: { set: "x" } },
// --password=x, --token x, Cookie: a=x; b=y, API Key: x
// ---------------------------------------------------------------------------------------------------------------

// Token starts in this file use lookbehinds such as (?<!(?<!\\)[\dA-Za-z]): in JSON-encoded text the letter of an
// escape (\n, \t) separates tokens like the whitespace it encodes, and a key never starts with that letter. Token
// starts never overlap and repetitions inside a token are bounded or unambiguous, so every scan stays linear.
// A key may start with - _ or digits (__Secure-bcs.session_token, _csrf, --password), end in brackets (token[]) and
// is classified by its whole name. Group 1 is the quote around the key with the backslashes that escape it in
// JSON-encoded JSON (up to 5 levels), group 2 a key before : or =, group 3 the separator, group 4 a command-line
// flag before its value.
const TEXT_KEY =
  /(?<!\\)(?<!(?<!\\)[\w$.-])(?:(\\{0,31}["']?)([-\d_]*[A-Za-z][\w.-]*(?:\[[\w.-]{0,32}\])*)\1[ \t]*(:|=(?![=>]))\s*|(--?[A-Za-z][\w.-]*)[ \t]+(?=[^\s-]))/g
const QUOTE = /(\\*)(["'])/y
// A bare value runs to whitespace, a quote, ; or &, and on across a comma that no space follows: abc,def. After a
// colon (a header: x-inngest-signature: t=1&s=x) it also runs across &.
const BARE_VALUE = /[^\s"',;&]+(?:,[^\s"',;&]+)*/y
const HEADER_VALUE = /[^\s"',;]+(?:,[^\s"',;]+)*/y
// Authorization header values carry a scheme: "Token abc", "Bearer abc"
const AUTHORIZATION_VALUE = /(?:[A-Za-z][\w-]*[ \t]+(?=[^\s"',;&]))?[^\s"',;&]+/y
// Cookie: a=x; b=y and Set-Cookie: a=x; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly
const COOKIE_PAIR = String.raw`[^\s"',;=]+=(?:"[^"\n]*"|[^\s"',;]*)`
const COOKIE_LIST = new RegExp(String.raw`${COOKIE_PAIR}(?:;[ \t]*(?:[Ee]xpires=[^;\n"']*|${COOKIE_PAIR}|[^\s"',;=]+))*`, 'y')
const COOKIE_ITEM = /(^|;[ \t]*)([^\s"',;=]+)(=[^;]*)?/g
const COOKIE_ATTRIBUTES = new Set(['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly', 'partitioned', 'priority'])
const NOT_A_SECRET = /^(?:null|undefined|true|false)$/

function backslashesBefore(text: string, index: number, from: number): number {
  let count = 0
  while (index - count > from && text[index - count - 1] === '\\') count++
  return count
}

// A quote closes at the escape level it was opened with: unescaped for "…", exactly one backslash for \"…\"
function closesAt(text: string, index: number, from: number, level: number): boolean {
  const count = backslashesBefore(text, index, from)
  return level === 0 ? count % 2 === 0 : count === level
}

function closingQuote(text: string, from: number, level: number, mark: string): number {
  for (let i = text.indexOf(mark, from); i >= 0; i = text.indexOf(mark, i + 1)) {
    if (closesAt(text, i, from, level)) return i
  }
  return -1
}

function closingBracket(text: string, from: number, level: number): number {
  const closers: string[] = []
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (c === '{') closers.push('}')
    else if (c === '[') closers.push(']')
    else if (c === '}' || c === ']') {
      if (closers.pop() !== c) return -1
      if (closers.length === 0) return i
    } else if ((c === '"' || c === "'") && closesAt(text, i, from, level)) {
      const close = closingQuote(text, i + 1, level, c)
      if (close < 0) return -1
      i = close
    }
  }
  return -1
}

// Every cookie value goes, also a nameless one; the names and the Set-Cookie attributes after the first pair stay
function redactCookies(list: string): string {
  return list.replace(COOKIE_ITEM, (item: string, separator: string, name: string, value: string | undefined) => {
    if (separator && COOKIE_ATTRIBUTES.has(name.toLowerCase())) return item
    return separator + (value === undefined ? REDACTED : `${name}=${REDACTED}`)
  })
}

type TextValue = { end: number; replacement: string; content: string | null }

/** The value that starts at `start`, what replaces it and its text; an unterminated value runs to the end. */
function valueAt(text: string, start: number, level: number, key: string, header: boolean): TextValue | null {
  QUOTE.lastIndex = start
  const quote = QUOTE.exec(text)
  if (quote) {
    const open = quote[0]
    const escapes = (quote[1] ?? '').length
    const close = closingQuote(text, start + open.length, escapes, quote[2] ?? '"')
    if (close < 0) return { end: text.length, replacement: open + REDACTED, content: null }
    return { end: close + 1, replacement: open + REDACTED + open, content: text.slice(start + open.length, close - escapes) }
  }
  if (text[start] === '{' || text[start] === '[') {
    const close = closingBracket(text, start, level)
    return { end: close < 0 ? text.length : close + 1, replacement: REDACTED, content: null }
  }
  if (/cookie/i.test(key)) {
    COOKIE_LIST.lastIndex = start
    const list = COOKIE_LIST.exec(text)?.[0]
    if (list) return { end: start + list.length, replacement: redactCookies(list), content: null }
  }
  const bare = /authori[sz]ation/i.test(key) ? AUTHORIZATION_VALUE : header ? HEADER_VALUE : BARE_VALUE
  bare.lastIndex = start
  const value = bare.exec(text)?.[0]
  return !value || NOT_A_SECRET.test(value) ? null : { end: start + value.length, replacement: REDACTED, content: value }
}

// The word of prose before a key and one space, as in "API Key: x" or "Session ID: x": it starts the text or
// follows whitespace, a bracket, a quote, a comma or a semicolon, never = or : (then it is the value of a pair)
function wordBefore(text: string, at: number): string {
  if (text[at - 1] !== ' ' && text[at - 1] !== '\t') return ''
  let start = at - 1
  while (start > 0 && at - start <= 32 && /[\w-]/.test(text[start - 1] ?? '')) start--
  const word = text.slice(start, at - 1)
  return /^[A-Za-z]/.test(word) && (start === 0 || /[\s([{,;"']/.test(text[start - 1] ?? '')) ? word : ''
}

function textKeyKind(text: string, at: number, key: string, quote: string): KeyKind {
  if (key.startsWith('-')) return classifyFlag(key)
  const kind = classifyKey(key)
  if (kind !== 'plain' || quote) return kind
  const word = wordBefore(text, at)
  return word ? classifyKey(`${word} ${key}`) : kind
}

// No user code runs inside this loop, so the shared lastIndex of the module-level regexes cannot be re-entered
function scrubKeyValues(text: string): string {
  let out = ''
  let copied = 0
  TEXT_KEY.lastIndex = 0
  for (let m = TEXT_KEY.exec(text); m; m = TEXT_KEY.exec(text)) {
    // A key that names no secret is skipped, so its value is still scanned for nested pairs
    const quote = m[1] ?? ''
    const key = m[2] ?? m[4] ?? ''
    const kind = textKeyKind(text, m.index, key, quote)
    if (kind === 'plain') continue
    const start = m.index + m[0].length
    const value = valueAt(text, start, /["']$/.test(quote) ? quote.length - 1 : 0, key, m[3] === ':')
    if (!value || (kind === 'metadata' && value.content !== null && METADATA_TEXT.test(value.content))) continue
    out += text.slice(copied, start) + value.replacement
    copied = value.end
    TEXT_KEY.lastIndex = copied
  }
  return copied === 0 ? text : out + text.slice(copied)
}

// ---------------------------------------------------------------------------------------------------------------
// Numbers: national ID / tax ID (13 digits), bank accounts (10–12), card numbers (14–19, Luhn-valid)
// ---------------------------------------------------------------------------------------------------------------

// UUIDs and hex identifiers (sha256, commit and trace IDs; LINE user, group and room IDs: U, C or R and 32 hex)
// may hold digit runs that are not numbers. Captured, so split() keeps them as separate parts. A hex token of
// 24–31 digits without a letter in front is not one (file 1101700203451abcdefabcdef.pdf).
const IDENTIFIER =
  /((?<!(?<!\\)[\dA-Za-z])(?:[\dA-Fa-f]{8}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-[\dA-Fa-f]{12}|[G-Zg-z][\dA-Fa-f]{24,}|(?=[\dA-Fa-f]*[A-Fa-f])[\dA-Fa-f]{32,})(?![\dA-Za-z]))/
// A 13-digit run that passes the national ID check digit is redacted everywhere, also inside an identifier
const THIRTEEN_DIGITS = /(?<!\d)\d{13}(?!\d)/g
// Thai digits ๐–๙: a run (also printed in groups) is checked as ASCII digits and stays Thai unless it is redacted
const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙'
const THAI_DIGIT_RUN = /[๐-๙](?:[๐-๙ -]*[๐-๙])?/g

function luhn(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2
    sum += d
  }
  return sum % 10 === 0
}

// Thai national ID / tax ID: the 13th digit is (11 − Σ dᵢ·(13 − i) mod 11) mod 10 over the first 12
function isNationalId(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (13 - i)
  return (11 - (sum % 11)) % 10 === Number(digits[12])
}

function isSecretDigits(digits: string): boolean {
  if (digits.length >= 10 && digits.length <= 13) return true
  return digits.length >= 14 && digits.length <= 19 && luhn(digits)
}

const secretDigits = (match: string): string => (isSecretDigits(match.replace(/\D/g, '')) ? REDACTED : match)
const nationalId = (digits: string): string => (isNationalId(digits) ? REDACTED : digits)

const NUMBER_RULES: Array<[RegExp, (match: string) => string]> = [
  // printed national ID / tax ID 1-4-5-2-1 (also with dots) or 4-4-4-1, and bank accounts 3-1-5-1, 3-6-1, 4-3-3 and
  // 0xxx-4-4 (12-digit accounts such as GSB; the leading 0 tells them from a list of years), separated by spaces,
  // hyphens or dashes (‐ ‑ ‒ – —)
  [
    /(?<!(?<!\\)[\dA-Za-z])(?:\d([-\u2010-\u2014 .])\d{4}\1\d{5}\1\d{2}\1\d|\d{4}([-\u2010-\u2014 ])\d{4}\2\d{4}\2\d|\d{3}([-\u2010-\u2014 ])\d\3\d{5}\3\d|\d{3}([-\u2010-\u2014 ])\d{6}\4\d|\d{4}([-\u2010-\u2014 ])\d{3}\5\d{3}|0\d{3}([-\u2010-\u2014 ])\d{4}\6\d{4})(?![\dA-Za-z])/g,
    () => REDACTED,
  ],
  // card numbers printed in groups: 4-4-4-4(-3), and 4-6-5 or 4-6-4 (American Express, Diners Club)
  [/(?<!(?<!\\)[\dA-Za-z])(?:\d{4}([-\u2010-\u2014 ])\d{4}\1\d{4}\1\d{4}(?:\1\d{1,3})?|\d{4}([-\u2010-\u2014 ])\d{6}\2\d{4,5})(?![\dA-Za-z])/g, secretDigits],
  // other dash-joined digit groups, unless part of a document number such as PR-2569-00001
  [/(?<!(?<!\\)[\dA-Za-z]-?)\d{1,6}(?:-\d{1,6}){2,}(?!-?[\dA-Za-z])/g, secretDigits],
  // contiguous runs, also glued to letters (ID1101700203451, v1.1101700203451); the digits of a decimal number
  // (1234567890.50, 0.1234567890123) are an amount or a fraction
  [/(?<!\d)(?<!(?<![\dA-Za-z.])\d+\.)\d{10,19}(?!\d|\.\d)/g, secretDigits],
  // ... yet a valid national ID goes wherever it appears
  [THIRTEEN_DIGITS, nationalId],
]

function scrubDigits(text: string): string {
  if (!/\d/.test(text)) return text
  return text
    .split(IDENTIFIER)
    .map((part, i) =>
      i % 2 === 1 ? part.replace(THIRTEEN_DIGITS, nationalId) : NUMBER_RULES.reduce((acc, [re, replace]) => acc.replace(re, replace), part),
    )
    .join('')
}

function scrubNumbers(text: string): string {
  if (!/[๐-๙]/.test(text)) return scrubDigits(text)
  const thai = text.replace(THAI_DIGIT_RUN, (run) => {
    const ascii = run.replace(/[๐-๙]/g, (digit) => String(THAI_DIGITS.indexOf(digit)))
    const scrubbed = scrubDigits(ascii)
    return scrubbed === ascii ? run : scrubbed
  })
  return scrubDigits(thai)
}

// ---------------------------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------------------------

// The local part of an e-mail address, also before a percent-encoded @. The domain needs a top-level domain of
// letters, so package versions (pnpm@12.8.1, @prisma+client@7.10.0) are not addresses.
const EMAIL_LOCAL_PART =
  /(?<!\\)(?<!(?<!\\)[\p{L}\p{M}\p{N}_.%+-])[\p{L}\p{M}\p{N}_.%+-]{1,64}(?=(?:@|%40)(?:[\p{L}\p{M}\p{N}-]{1,63}\.){1,8}\p{L}{2,63}(?![\p{L}\p{M}\p{N}_-]))/gu

// A secret named in a percent-encoded query string: next=%2Freset-password%3Ftoken%3D<secret>%26lang%3Dth
function redactEncodedPair(pair: string, before: string, key: string, equals: string, value: string): string {
  return hides(classifyKey(key), value) ? `${before}${key}${equals}${REDACTED}` : pair
}

// A secret in an XML element, as in a SOAP body: <password>x</password>
function redactElement(element: string, name: string, value: string): string {
  return value.trim() && hides(classifyKey(name), value) ? `<${name}>${REDACTED}</${name}>` : element
}

type TextRule = {
  pattern: RegExp
  replacement: string | ((match: string, ...groups: string[]) => string)
  // a cheap test that the text can match at all, so most log text skips the rule
  when?: RegExp
}

const TEXT_RULES: TextRule[] = [
  // URL credentials: scheme://user:password@host — the password may itself contain '@'
  {
    pattern: /(?<!(?<!\\)[a-z\d+.-])([a-z][a-z\d+.-]{0,31}:\/\/[^\s:/?#@]*:)[^\s/?#]*(?=@[^\s/?#@]*(?:[\s/?#"'`)\]}]|$))/gi,
    replacement: `$1${REDACTED}`,
    when: /:\/\//,
  },
  // e-mail addresses are personal data (PDPA): the local part goes and the domain stays. A token used as the user
  // name of a URL (https://<token>@github.com) goes with it.
  { pattern: EMAIL_LOCAL_PART, replacement: REDACTED, when: /@|%40/ },
  // one-time links: e-mail action links /a/<tokenId>.<secret> (BR-TOK-03), invitations, password resets; the
  // Inngest event API path /e/<event key>
  { pattern: /(\/(?:a|e|invite|reset-password)\/)[^\s/?#"'<>]+/g, replacement: `$1${REDACTED}` },
  { pattern: /(?<!(?<!\\)\w)(Bearer|Basic)\s+[\w.~+/=-]+/gi, replacement: `$1 ${REDACTED}` },
  // query parameters that are secret only in URLs; named secrets are handled by the key/value scan
  { pattern: /([?&](?:code|sig|key)=)[^&\s"'#]+/gi, replacement: `$1${REDACTED}`, when: /[?&]/ },
  { pattern: /(%3[Ff]|%26)([A-Za-z_][\w.-]{0,63})(%3[Dd])((?:(?!%26|%23)[^\s"'&#<>])+)/g, replacement: redactEncodedPair, when: /%3[Dd]/ },
  { pattern: /<([A-Za-z][\w.:-]{0,63})>([^<]*)<\/\1>/g, replacement: redactElement, when: /<\// },
  // a password announced in prose: "temporary password is x"; not "default password is not set"
  {
    pattern:
      /((?<!(?<!\\)\w)(?:temporary|temp|initial|default|generated|one-time)[ \t]+(?:password|passcode|passphrase|pin)[ \t]+(?:is|was)[ \t]+)(?!(?:not|too|disabled|expired|invalid|required|missing|empty|set|unset|changed|being|now)\b)[^\s"'<>]+/gi,
    replacement: `$1${REDACTED}`,
  },
  // a 4–8 digit run soon after PIN or OTP: "your PIN 482913", "PIN code: 482913", "รหัส OTP ของคุณคือ 135794";
  // not a date or a time (PIN locked until 2026-10-02)
  {
    pattern: /((?<!(?<!\\)\w)(?:pin|otp|passcode)\b|พิน|โอทีพี)([^\d\n]{0,40}?)\d{4,8}(?!\d|[-:./]\d)/giu,
    replacement: `$1$2${REDACTED}`,
    when: /\d{4}/,
  },
  // Thai labels: รหัสผ่าน: x (password), รหัสยืนยันคือ x (verification code), รหัส PIN ใหม่: x. Each run of
  // spaces belongs to one place in the pattern, so a long run cannot be split two ways.
  {
    pattern:
      /((?:รหัสผ่าน|รหัสยืนยัน|รหัสลับ|รหัส ?(?:pin|otp|พิน))[^\S\n]*(?:(?:ใหม่|เดิม|ชั่วคราว|ของคุณ|ของท่าน)[^\S\n]*)?(?:[:=]|คือ)[^\S\n]*)[^\s"'<>]+/giu,
    replacement: `$1${REDACTED}`,
    when: /รหัส/,
  },
]

export function scrubText(text: string): string {
  let scrubbed = text
  for (const { pattern, replacement, when } of TEXT_RULES) {
    if (when && !when.test(scrubbed)) continue
    scrubbed = typeof replacement === 'string' ? scrubbed.replace(pattern, replacement) : scrubbed.replace(pattern, replacement)
  }
  return scrubNumbers(scrubKeyValues(scrubbed))
}

// ---------------------------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------------------------

const MAX_DEPTH = 12
// An object key with an e-mail address or 10+ digits may itself be personal data or a number (rows grouped by it)
const KEY_TO_SCRUB = /@|%40|[๐-๙]|(?:\d\D?){10}/
// A command-line flag on its own, before its value: ['node', 'seed.ts', '--token', 'x']
const FLAG = /^--?[A-Za-z][\w.-]*$/

const scrubKey = (key: string): string => (KEY_TO_SCRUB.test(key) ? scrubText(key) : key)

const isEntry = (item: unknown): item is [string, unknown] => Array.isArray(item) && item.length === 2 && typeof item[0] === 'string'

function redactField(kind: KeyKind, value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  return hides(kind, value) ? REDACTED : redactValue(value, depth, ancestors)
}

function redactValue(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED]'
  if (typeof value === 'string') return scrubText(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && scrubNumbers(String(value)) !== String(value) ? REDACTED : value
  }
  if (value === null || typeof value !== 'object') return value
  if (ancestors.has(value)) return '[Circular]'
  try {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
    if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${value.byteLength} bytes]`
    ancestors.add(value)
    try {
      return redactObject(value, depth, ancestors)
    } finally {
      ancestors.delete(value)
    }
  } catch {
    return '[Unserializable]'
  }
}

function redactArray(items: unknown[], depth: number, ancestors: WeakSet<object>): unknown[] {
  // [...headers], Object.entries(…), [...map]: [name, value] pairs, each value read as if it were under its name
  if (items.length > 0 && items.every(isEntry)) {
    return items.map(([name, item]) => [scrubKey(name), redactField(classifyKey(name), item, depth + 2, ancestors)])
  }
  const out = items.map((item: unknown) => redactValue(item, depth + 1, ancestors))
  for (let i = 1; i < items.length; i++) {
    const flag = items[i - 1]
    const item = items[i]
    if (typeof flag !== 'string' || !FLAG.test(flag) || (typeof item === 'string' && item.startsWith('-'))) continue
    if (hides(classifyFlag(flag), item)) out[i] = REDACTED
  }
  return out
}

function redactObject(value: object, depth: number, ancestors: WeakSet<object>): unknown {
  if (value instanceof Error) {
    const text = (part: unknown) => (typeof part === 'string' ? scrubText(part) : redactValue(part, depth + 1, ancestors))
    return { type: value.name, message: text(value.message), stack: value.stack === undefined ? undefined : text(value.stack) }
  }
  if (Array.isArray(value)) return redactArray(value, depth, ancestors)
  const toJSON: unknown = (value as { toJSON?: unknown }).toJSON
  if (typeof toJSON === 'function') {
    const json: unknown = toJSON.call(value)
    if (json !== value) return redactValue(json, depth + 1, ancestors)
  }
  const out: Record<string, unknown> = {}
  const renamed = new Map<string, number>()
  for (const key of Object.keys(value)) {
    // Two keys rewritten alike keep apart: [REDACTED], [REDACTED] (2)
    let name = scrubKey(key)
    if (name !== key) {
      const seen = (renamed.get(name) ?? 0) + 1
      renamed.set(name, seen)
      if (seen > 1) name = `${name} (${seen})`
    }
    let item: unknown
    try {
      item = (value as Record<string, unknown>)[key]
    } catch {
      out[name] = '[Unreadable]'
      continue
    }
    out[name] = redactField(classifyKey(key), item, depth + 1, ancestors)
  }
  return out
}

export function redactDeep(value: unknown, depth = 0): unknown {
  return redactValue(value, depth, new WeakSet())
}

// ---------------------------------------------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------------------------------------------

const redactSerialized: SerializerFn = (value) => redactDeep(value)

function redactBindings(bindings: Bindings): Bindings {
  return bindings !== null && typeof bindings === 'object' ? (redactDeep(bindings) as Bindings) : bindings
}

function asLogObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : { value }
}

// What a child logger's own serializers, formatters and message prefix produce is redacted too
function guardChildOptions(options: ChildLoggerOptions): ChildLoggerOptions {
  const guarded: ChildLoggerOptions = { ...options }
  if (typeof options.msgPrefix === 'string') guarded.msgPrefix = scrubText(options.msgPrefix)
  if (options.serializers) {
    const serializers: Record<string, SerializerFn> = { ...options.serializers }
    for (const [key, serialize] of Object.entries(options.serializers)) {
      serializers[key] = typeof serialize === 'function' ? (value: unknown) => redactDeep(serialize(value)) : redactSerialized
    }
    guarded.serializers = serializers
  }
  if (options.formatters) {
    const { level, bindings, log } = options.formatters
    guarded.formatters = {
      ...(level && { level: (label: string, value: number) => asLogObject(redactDeep(level(label, value))) }),
      ...(bindings && { bindings: (b: Bindings) => asLogObject(redactDeep(bindings(b))) }),
      ...(log && { log: (o: object) => asLogObject(redactDeep(log(o))) }),
    }
  }
  return guarded
}

// pino serializes child bindings itself, outside formatters.log, and resets the bindings formatter for every
// child. Wrapping child() and setBindings() on the root is inherited by every descendant (children are created
// with Object.create(parent)).
function guardChildren(root: Logger): Logger {
  const pinoChild: (this: Logger, bindings: Bindings, options?: ChildLoggerOptions) => Logger = root.child
  const pinoSetBindings: (this: Logger, bindings: Bindings) => void = root.setBindings
  return Object.assign(root, {
    child(this: Logger, bindings: Bindings, options?: ChildLoggerOptions): Logger {
      return pinoChild.call(this, redactBindings(bindings), options && guardChildOptions(options))
    },
    setBindings(this: Logger, bindings: Bindings): void {
      pinoSetBindings.call(this, redactBindings(bindings))
    },
  })
}

export function createLogger(destination?: DestinationStream, level?: string): Logger {
  const options: pino.LoggerOptions = {
    level: level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service: 'bcs' },
    timestamp: pino.stdTimeFunctions.isoTime,
    // msg is serialized last: after printf interpolation, msgPrefix and the copy pino takes of err.message
    serializers: { err: redactSerialized, error: redactSerialized, msg: redactSerialized },
    formatters: {
      log: (obj) => asLogObject(redactDeep(obj)),
    },
    hooks: {
      logMethod(args, method) {
        // printf arguments (%s %d %j %o %O) are interpolated after this hook: objects are redacted here while
        // their keys are visible; strings and numbers are scrubbed with the finished message (serializers.msg),
        // so scrubbing can never shift a placeholder onto another argument.
        const first: unknown = args[0]
        const messageAt = typeof first === 'object' || first === undefined ? 1 : 0
        const redacted = args.map((arg: unknown, i) =>
          i >= messageAt && arg !== null && typeof arg === 'object' && !(arg instanceof Error) ? redactDeep(arg) : arg,
        )
        try {
          method.apply(this, redacted as Parameters<typeof method>)
        } catch {
          // pino reads err.message itself: a getter or toJSON that throws must not turn a log call into a crash
          try {
            method.apply(this, [{ logError: 'the log arguments could not be serialized' }] as unknown as Parameters<typeof method>)
          } catch {
            // nothing more can be written
          }
        }
      },
    },
  }
  return guardChildren(destination ? pino(options, destination) : pino(options))
}

export const logger: Logger = createLogger()
