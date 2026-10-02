import pino, { type DestinationStream, type Logger } from 'pino'

// Structured JSON logs (pino). NFR-SEC-09: logs never contain passwords, PINs, tokens, secrets, full bank
// account numbers or national ID numbers. Redaction happens here, at the logger, for every log line:
//   1. object keys that look sensitive are replaced at any depth;
//   2. free text (messages, error messages, stacks) is scrubbed of action-link secrets, bearer tokens,
//      secret query parameters and long digit runs (national IDs, bank accounts).
// Bind requestId / correlationId / organizationId with logger.child({...}) (NFR-OBS-01).

export const REDACTED = '[REDACTED]'

const SENSITIVE_KEY =
  /(pass(word|wd)?|^pin$|pin(code|hash)|token|secret|authorization|cookie|session|account(no|number)|bankaccount|nationalid|idcard|citizenid|otp|totp|apikey|signature|credential|private_?key|encryptionkey)/i

const TEXT_RULES: Array<[RegExp, string]> = [
  // e-mail action links /a/<tokenId>.<secret> (BR-TOK-03)
  [/\/a\/[A-Za-z0-9._~%-]+/g, `/a/${REDACTED}`],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  [/([?&](?:token|secret|code|signature|sig|key|password|otp|X-Amz-Signature|X-Amz-Credential)=)[^&\s"']+/gi, `$1${REDACTED}`],
  // key=value / key: value pairs in free text (error messages, debug strings)
  [
    /\b((?:access[_-]?|refresh[_-]?|session[_-]?|id[_-]?)?token|secret|pass(?:word|wd)?|pin|otp|api[_-]?key|private[_-]?key)(\s*[=:]\s*)[^\s&"',;]+/gi,
    `$1$2${REDACTED}`,
  ],
  // 13-digit Thai national ID / tax ID shaped numbers and 10–12 digit bank account numbers
  [/(?<!\d)\d{13}(?!\d)/g, REDACTED],
  [/(?<!\d)\d{10,12}(?!\d)/g, REDACTED],
  [/(?<!\d)\d{3}-\d-\d{5}-\d(?!\d)/g, REDACTED],
]

export function scrubText(text: string): string {
  return TEXT_RULES.reduce((acc, [re, replacement]) => acc.replace(re, replacement), text)
}

export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[TRUNCATED]'
  if (typeof value === 'string') return scrubText(value)
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    return { type: value.name, message: scrubText(value.message), stack: value.stack ? scrubText(value.stack) : undefined }
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) && v !== null && v !== undefined ? REDACTED : redactDeep(v, depth + 1)
    }
    return out
  }
  return value
}

export function createLogger(destination?: DestinationStream, level?: string): Logger {
  const options: pino.LoggerOptions = {
    level: level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service: 'bcs' },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: (e: unknown) => redactDeep(e), error: (e: unknown) => redactDeep(e) },
    formatters: {
      log: (obj) => redactDeep(obj) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        const cleaned = args.map((a) => (typeof a === 'string' ? scrubText(a) : a)) as Parameters<typeof method>
        method.apply(this, cleaned)
      },
    },
  }
  return destination ? pino(options, destination) : pino(options)
}

export const logger: Logger = createLogger()
