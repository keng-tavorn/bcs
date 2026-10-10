import { z } from 'zod'
// Relative, not '@/lib/constants': prisma.config.ts loads this file through the Prisma CLI, which has no path aliases.
import { PASSWORD_MIN_LENGTH } from './constants'

// Environment schema (spec Appendix B + additions in .env.example). Validated at start-up, by the `pnpm verify` env
// gate, and outside local by `pnpm db:migrate` and prisma.config.ts before the Prisma CLI connects
// (envIssuesOutsideLocal); a missing or malformed value stops the app and names the variable.

const APP_ENVS = ['local', 'preview', 'staging', 'production'] as const
export type AppEnv = (typeof APP_ENVS)[number]

// Empty strings in .env mean "not set".
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional())

const flag = optional(z.enum(['0', '1', 'true', 'false']).transform((v) => v === '1' || v === 'true'))

const urlSchema = () => z.url('ต้องเป็น URL เต็ม เช่น https://example.com')

// liff.ts sends LIFF ID tokens here and trusts the claims that come back, so outside local only LINE itself may
// answer (BR-LINE-02); the fake LINE server is local-only (docs/runbooks/p0-08-vercel.md).
const LINE_API_ORIGIN = 'https://api.line.me'
// src/integrations/line uploads rich menu images here with the channel access token (§9.5), so outside local the token
// goes to LINE's data API only; locally both LINE values may point at the fake LINE server (pnpm line:fake).
const LINE_DATA_API_ORIGIN = 'https://api-data.line.me'

const ENCRYPTION_KEY = z
  .string()
  .regex(/^base64:/, 'ต้องขึ้นต้นด้วย base64:')
  .refine((v) => Buffer.from(v.slice('base64:'.length), 'base64').length === 32, 'ต้องถอดรหัสได้ 32 ไบต์ (AES-256-GCM)')

// Literal secrets anyone with the repo knows: the .env.example values (spec Appendix B) including the role passwords
// inside its DATABASE_URL and DIRECT_URL, the docker-compose.yml superuser password, the placeholder in the Neon
// runbook SQL, and the default keys of the local S3 stand-ins (ADR-036). No shared environment may use them
// (NFR-SEC-07). tests/unit/env.test.ts copies every .env.example value into a shared environment, so a new example
// value fails the tests until it is refused here or allowed there.
const PUBLISHED_SECRETS = [
  'change-me-dev-only', // SEED_DEV_PASSWORD
  'change-me-at-least-32-characters', // BETTER_AUTH_SECRET
  'base64:REPLACE_WITH_32_RANDOM_BYTES_BASE64', // ENCRYPTION_KEY
  'change-me-dev-only-totp-key-32chars', // SEED_TOTP_KEY
  'minio', // S3_ACCESS_KEY_ID
  'minio12345', // S3_SECRET_ACCESS_KEY
  'bcs_app', // password in DATABASE_URL
  'bcs_migrator', // password in DIRECT_URL
  'postgres', // docker-compose.yml POSTGRES_PASSWORD
  'PASTE_BCS_APP_PASSWORD_HERE', // docs/runbooks/p0-05-neon-staging.md step 7
  'minioadmin', // MinIO default keys
  'rustfsadmin', // RustFS default keys
].map((v) => v.toLowerCase())

const isPublishedSecret = (value: string) =>
  /change-me|REPLACE_WITH/i.test(value) || PUBLISHED_SECRETS.includes(value.trim().toLowerCase())

// .env.example names the bucket of the local storage server; each shared environment has its own (p0-06 runbook).
const EXAMPLE_S3_BUCKET = 'bcs-local'

// FR-PLT-006/AC3: the runtime connects as the app role and migrations as the migrator role. The migrations grant
// privileges to these names (prisma/migrations/*_s1_platform), so any other role at runtime bypasses them.
const DB_ROLES = {
  DATABASE_URL: {
    role: 'bcs_app',
    fix: 'ต้องเชื่อมต่อด้วย role bcs_app ซึ่ง migration จำกัดสิทธิ์ไว้ ไม่ใช่ role เจ้าของหรือ bcs_migrator — ใส่ชื่อ role ในส่วน user ของ connection string และถ้ามี ?user= ต้องเป็นชื่อเดียวกัน (FR-PLT-006/AC3 · docs/runbooks/p0-05-neon-staging.md ขั้นที่ 9)',
  },
  DIRECT_URL: {
    role: 'bcs_migrator',
    fix: 'ต้องเชื่อมต่อด้วย role bcs_migrator ที่รัน migration — ใส่ชื่อ role ในส่วน user ของ connection string เพราะ Prisma CLI ไม่อ่าน ?user= และถ้ามี ?user= ต้องเป็นชื่อเดียวกัน (FR-PLT-006/AC3 · docs/runbooks/p0-05-neon-staging.md ขั้นที่ 5)',
  },
} as const

// URLs the Inngest SDK reads from the environment itself (inngest/helpers/consts.js): where events and API calls
// go, and where Inngest Cloud calls the app back.
const INNGEST_URLS = ['INNGEST_BASE_URL', 'INNGEST_API_BASE_URL', 'INNGEST_EVENT_API_BASE_URL', 'INNGEST_SERVE_ORIGIN', 'INNGEST_SERVE_HOST'] as const

// Secrets the team generates (docs/runbooks/p0-08-vercel.md B2) and secrets issued by a provider.
const GENERATED_SECRETS = ['BETTER_AUTH_SECRET', 'ENCRYPTION_KEY', 'SEED_DEV_PASSWORD', 'SEED_TOTP_KEY'] as const
const PROVIDER_SECRETS = [
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'INNGEST_EVENT_KEY',
  'INNGEST_SIGNING_KEY',
  'LINE_MESSAGING_CHANNEL_SECRET',
  'LINE_MESSAGING_CHANNEL_ACCESS_TOKEN',
  'LINE_LOGIN_CHANNEL_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_SECRET',
  'ANTHROPIC_API_KEY',
] as const

const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

// Names the hosts file of common Linux images (Debian, RHEL, Amazon Linux) maps to loopback.
const LOOPBACK_NAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'localhost4',
  'localhost4.localdomain4',
  'localhost6',
  'localhost6.localdomain6',
  'ip6-localhost',
  'ip6-loopback',
])

/** The IPv4 address inside an IPv4-mapped (`::ffff:7f00:1`) or IPv4-compatible (`::7f00:1`) IPv6 address. */
function embeddedIPv4(host: string): string | undefined {
  const match = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (!match?.[1] || !match[2]) return undefined
  const high = Number.parseInt(match[1], 16)
  const low = Number.parseInt(match[2], 16)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}

/**
 * True for a host that reaches the machine the app runs on: names under `localhost` (RFC 6761) and its hosts-file
 * aliases, loopback and unspecified addresses (also inside IPv6 or with an IPv6 zone id), a Unix socket (`/path` or
 * `@name`) and an empty host, which pg and libpq read as localhost once PGHOST is unset (callers that act on an
 * empty host check PGHOST themselves). Public DNS names that resolve to 127.0.0.1 are not detected.
 */
export function isLocalHost(raw: string): boolean {
  let value = raw.trim().toLowerCase()
  if (value === '' || value.startsWith('/') || value.startsWith('@')) return true
  // A zone id (`::1%lo`) still reaches the address before it; URL cannot parse one, so drop it.
  if (value.includes(':')) value = value.replace(/%[^\]]*/, '')
  // Parsing as http canonicalizes IPv4 shorthand (127.1, 0x7f000001) and IPv6 the way a resolver reads them.
  const bracketed = value.includes(':') && !value.startsWith('[') ? `[${value}]` : value
  const host = (parseUrl(`http://${bracketed}`)?.hostname ?? value).replace(/^\[(.*)\]$/, '$1').replace(/\.+$/, '')
  const ipv4 = embeddedIPv4(host) ?? host
  return (
    LOOPBACK_NAMES.has(host) ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '::' ||
    /^127\.\d+\.\d+\.\d+$/.test(ipv4) ||
    ipv4 === '0.0.0.0'
  )
}

/**
 * A URL whose text starts with `https://` on a host that is not this machine. The text matters: consumers append
 * paths to the value as written (emails.ts, liff.ts), and z.url() returns `HTTPS://x` or `https:/x` unchanged.
 */
function isPublicHttps(value: string): boolean {
  const parsed = parseUrl(value)
  return parsed !== undefined && value.startsWith('https://') && !isLocalHost(parsed.hostname)
}

/**
 * The base src/server/auth/liff.ts appends `/oauth2/v2.1/verify` to, and src/integrations/line appends the Messaging
 * API paths to (LINE_API_BASE_URL, LINE_DATA_API_BASE_URL): the URL as the parser reads it (lower case, no default
 * port) without trailing slashes, so every spelling of one address gives one URL. Undefined when the value cannot be
 * such a base: not http(s), or with user:password, a query or a fragment, which would swallow or break the appended
 * path.
 */
function lineApiBase(value: string): string | undefined {
  const url = parseUrl(value)
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return undefined
  if (url.username !== '' || url.password !== '' || /[?#]/.test(value)) return undefined
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/**
 * Hosts, users and passwords a PostgreSQL connection string resolves to, read the way pg-connection-string 2.x does:
 * spaces and stray `%` re-encoded first, `host`/`hostaddr`/`password` query parameters, comma-separated host lists,
 * and an empty host after the credentials (`user:pw@/db`). `user` is the authority user, which the Prisma CLI uses;
 * pg lets the last non-empty `?user=` (in `queryUsers`) override it. Undefined when pg could not read it either.
 */
function connectionTarget(value: string): { hosts: string[]; user: string; queryUsers: string[]; passwords: string[] } | undefined {
  try {
    const source = / |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(value) ? encodeURI(value).replace(/%25(\d\d)/g, '%$1') : value
    let url = parseUrl(source)
    let authorityHost = url?.hostname ?? ''
    if (!url) {
      url = parseUrl(source.replace('@/', '@empty-host/'))
      authorityHost = ''
    }
    if (!url) return undefined
    const params = url.searchParams
    // Query parameters arrive decoded; the authority is percent-encoded (`%2Fvar%2Frun` is a socket path).
    const hosts = [decodeURIComponent(authorityHost), ...params.getAll('host'), ...params.getAll('hostaddr')]
      .flatMap((h) => h.split(','))
      .map((h) => h.trim())
      .filter((h) => h !== '')
    const passwords = [decodeURIComponent(url.password), ...params.getAll('password')].filter((p) => p !== '')
    return { hosts, user: decodeURIComponent(url.username), queryUsers: params.getAll('user'), passwords }
  } catch {
    // A percent escape that does not decode (`%ff`, a lone `%`): pg throws URIError on it as well.
    return undefined
  }
}

/**
 * Every host a PostgreSQL connection string reaches (authority, `?host=`, `?hostaddr=`, comma lists), for scripts
 * that must act on this machine only. An empty list means the client default: pg connects to PGHOST, and to
 * localhost only when PGHOST is unset (scripts/db-reset.ts checks it). Undefined when pg could not read the string
 * either.
 */
export function postgresHosts(value: string): string[] | undefined {
  return connectionTarget(value)?.hosts
}

const schema = z
  .object({
    APP_ENV: z.enum(APP_ENVS),
    APP_URL: urlSchema(),
    // Every seeded user signs in with this password, so it follows the product rule (FR-AUTH-001 AC2), as
    // prisma/seed.ts does; checked in every APP_ENV.
    SEED_DEV_PASSWORD: optional(
      z.string().min(PASSWORD_MIN_LENGTH, `ต้องยาวอย่างน้อย ${PASSWORD_MIN_LENGTH} ตัวอักษรตามกติการหัสผ่านของระบบ (FR-AUTH-001 AC2) — ผู้ใช้ตัวอย่างทุกคน login ด้วยรหัสนี้`),
    ),

    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'ต้องเป็น connection string ของ PostgreSQL'),
    DIRECT_URL: z.string().regex(/^postgres(ql)?:\/\//, 'ต้องเป็น connection string ของ PostgreSQL'),

    BETTER_AUTH_SECRET: z.string().min(32, 'ต้องยาวอย่างน้อย 32 ตัวอักษร'),
    BETTER_AUTH_URL: urlSchema(),
    // Read by Better Auth itself: a comma list of origins its CSRF check trusts besides BETTER_AUTH_URL.
    BETTER_AUTH_TRUSTED_ORIGINS: optional(z.string()),
    ENCRYPTION_KEY,

    S3_ENDPOINT: optional(urlSchema()),
    S3_REGION: z.string().min(1),
    S3_BUCKET: z.string().min(3),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: flag,

    EMAIL_PROVIDER: z.enum(['smtp', 'resend', 'ses']),
    EMAIL_SMTP_URL: optional(z.string().regex(/^smtps?:\/\//, 'ต้องขึ้นต้นด้วย smtp:// หรือ smtps://')),
    EMAIL_FROM: z.string().min(3),

    REGISTRY_MODE: z.enum(['stub', 'live']).default('stub'),
    RD_VAT_SERVICE_URL: optional(urlSchema()),
    DBD_JURISTIC_API_URL: optional(urlSchema()),

    INNGEST_DEV: optional(z.string()),
    INNGEST_EVENT_KEY: optional(z.string()),
    INNGEST_SIGNING_KEY: optional(z.string()),
    // Read by the Inngest SDK itself (INNGEST_URLS); checked outside local only, so local stays as the SDK allows.
    INNGEST_BASE_URL: optional(z.string()),
    INNGEST_API_BASE_URL: optional(z.string()),
    INNGEST_EVENT_API_BASE_URL: optional(z.string()),
    INNGEST_SERVE_ORIGIN: optional(z.string()),
    INNGEST_SERVE_HOST: optional(z.string()),

    LINE_PROVIDER_ID: optional(z.string()),
    LINE_MESSAGING_CHANNEL_ID: optional(z.string()),
    LINE_MESSAGING_CHANNEL_SECRET: optional(z.string()),
    LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: optional(z.string()),
    LINE_LOGIN_CHANNEL_ID: optional(z.string()),
    LINE_LOGIN_CHANNEL_SECRET: optional(z.string()),
    LINE_LIFF_CHANNEL_ID: optional(z.string()),
    NEXT_PUBLIC_LIFF_ID: optional(z.string()),
    // As written here (checked below); the parsed environment carries lineApiBase() of it.
    LINE_API_BASE_URL: optional(urlSchema()).transform((v) => v ?? LINE_API_ORIGIN),
    // The same rules as LINE_API_BASE_URL, for the host of LINE's content API (rich menu images)
    LINE_DATA_API_BASE_URL: optional(urlSchema()).transform((v) => v ?? LINE_DATA_API_ORIGIN),

    GOOGLE_CLIENT_ID: optional(z.string()),
    GOOGLE_CLIENT_SECRET: optional(z.string()),
    MICROSOFT_CLIENT_ID: optional(z.string()),
    MICROSOFT_CLIENT_SECRET: optional(z.string()),
    MICROSOFT_TENANT_ID: optional(z.string()),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    SENTRY_DSN: optional(urlSchema()),

    AI_ENABLED: flag,
    ANTHROPIC_API_KEY: optional(z.string()),
    AI_MODEL_DEFAULT: optional(z.string()),

    // Trimmed: a key pasted into Vercel with a trailing space or line break would otherwise seed codes that no copy of
    // the key (scripts/seed-totp.ts) reproduces
    SEED_TOTP_KEY: optional(z.string().trim().min(32, 'ต้องยาวอย่างน้อย 32 ตัวอักษร')),
    // The transaction PIN of every demo approver (S5-05, src/server/seed/pins.ts), local and staging only (below); the
    // seed refuses an easy one with the rule of src/core/pin, which this file cannot import.
    SEED_DEV_PIN: optional(z.string().regex(/^[0-9]{6}$/, 'ต้องเป็นตัวเลข 6 หลัก — PIN ยืนยันธุรกรรมของผู้ใช้ตัวอย่างที่ดำรงตำแหน่งใน DOA')),
    APP_COMMIT_SHA: optional(z.string()),
    E2E_TEST_CLOCK: flag,
    LIFF_MOCK: flag,
    VERCEL_TOKEN: optional(z.string()),
    // Set by Vercel: production or preview on its deployments, development under `vercel dev` / `vercel env pull`.
    VERCEL_ENV: optional(z.string()),
  })
  .superRefine((e, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message })
    const local = e.APP_ENV === 'local'

    if (e.EMAIL_PROVIDER === 'smtp' && !e.EMAIL_SMTP_URL) issue('EMAIL_SMTP_URL', 'ต้องตั้งเมื่อ EMAIL_PROVIDER=smtp')
    // Tier 1–3 never call AI (EG-1, NG-5); AI stays off until S13.
    if (e.AI_ENABLED) issue('AI_ENABLED', 'ต้องเป็น false จนถึงขั้น S13 (EG-1)')
    // liff.ts appends the verify path to this value, locally too (the fake LINE server).
    if (parseUrl(e.LINE_API_BASE_URL) && lineApiBase(e.LINE_API_BASE_URL) === undefined) {
      issue('LINE_API_BASE_URL', 'ต้องเป็น URL ฐานแบบ http(s) เช่น https://api.line.me ไม่มี user:password, ? หรือ # — ระบบต่อ /oauth2/v2.1/verify ท้ายค่านี้ (BR-LINE-02)')
    }
    if (parseUrl(e.LINE_DATA_API_BASE_URL) && lineApiBase(e.LINE_DATA_API_BASE_URL) === undefined) {
      issue('LINE_DATA_API_BASE_URL', 'ต้องเป็น URL ฐานแบบ http(s) เช่น https://api-data.line.me ไม่มี user:password, ? หรือ # — ระบบต่อ /v2/bot/richmenu/… ท้ายค่านี้')
    }

    // APP_ENV=local is the .env.example default; on a deployment it would switch off every check below.
    const vercelEnv = e.VERCEL_ENV?.trim().toLowerCase()
    if (local && (vercelEnv === 'production' || vercelEnv === 'preview')) {
      issue('APP_ENV', 'ห้ามเป็น local บน deployment ของ Vercel — ตั้งตาม environment จริง เช่น staging (docs/runbooks/p0-08-vercel.md ขั้น B1)')
    }

    if (!local) {
      // Values published in the repo must never reach a shared environment (NFR-SEC-07).
      for (const key of GENERATED_SECRETS) {
        const value = e[key]
        if (typeof value === 'string' && isPublishedSecret(value)) {
          issue(key, 'ยังเป็นค่าตัวอย่างที่เปิดเผยใน repo (.env.example หรือค่าเริ่มต้นของเครื่องมือ) — สร้างค่าสุ่มใหม่')
        }
      }
      for (const key of PROVIDER_SECRETS) {
        const value = e[key]
        if (typeof value === 'string' && isPublishedSecret(value)) {
          issue(key, 'ยังเป็นค่าตัวอย่างที่เปิดเผยใน repo (.env.example หรือค่าเริ่มต้นของเครื่องมือ) — ใช้ค่าที่ออกให้โดยผู้ให้บริการของ environment นี้')
        }
      }
      if (e.S3_BUCKET.trim().toLowerCase() === EXAMPLE_S3_BUCKET) {
        issue('S3_BUCKET', 'ยังเป็น bucket ตัวอย่างจาก .env.example — ใช้ bucket ของ environment นี้ เช่น bcs-staging (docs/runbooks/p0-06-storage-staging.md)')
      }
      if (e.INNGEST_DEV) issue('INNGEST_DEV', 'ต้องว่างนอก local (Inngest v4 ใช้ cloud mode)')
      if (!e.INNGEST_SIGNING_KEY) issue('INNGEST_SIGNING_KEY', 'ต้องตั้งนอก local')
      if (!e.INNGEST_EVENT_KEY) issue('INNGEST_EVENT_KEY', 'ต้องตั้งนอก local')
      // Test-only switches are refused outside local (they would bypass real time or real LIFF login).
      if (e.E2E_TEST_CLOCK) issue('E2E_TEST_CLOCK', 'ใช้ได้เฉพาะ APP_ENV=local')
      if (e.LIFF_MOCK) issue('LIFF_MOCK', 'ใช้ได้เฉพาะ APP_ENV=local')

      // Browsers, LINE and the app's own outbound calls use these URLs, so they must be https on a host that is not
      // this machine (NFR-SEC-02), with https:// written as such. A value that is not a URL at all was already
      // reported by z.url().
      const publicHttps = (key: string, value: string | undefined, fix: string): boolean => {
        const refused = value !== undefined && parseUrl(value) !== undefined && !isPublicHttps(value)
        if (refused) issue(key, fix)
        return refused
      }
      // auth.ts issues Secure cookies for an https APP_URL and emails.ts appends paths to it; Better Auth builds its
      // cookies and callback URLs from BETTER_AUTH_URL. Each is written as a bare lowercase origin, "https://host[:port]"
      // (docs/runbooks/p0-08-vercel.md B5), and BETTER_AUTH_URL is the same value as APP_URL (B1).
      const httpsOrigin = (key: 'APP_URL' | 'BETTER_AUTH_URL', reason: string): boolean => {
        const value = e[key]
        if (publicHttps(key, value, 'ต้องขึ้นต้นด้วย https:// (ตัวพิมพ์เล็ก) บนโดเมนจริงของ environment นี้ ไม่ใช่ localhost (NFR-SEC-02)')) return false
        const origin = parseUrl(value)?.origin
        if (origin === undefined) return false
        if (origin !== value) {
          issue(key, `ต้องเขียนเป็น https://โดเมน ด้วยตัวพิมพ์เล็ก ไม่มี / ท้าย ไม่มี path, :443, user:password, ? หรือ # — ${reason} (docs/runbooks/p0-08-vercel.md ขั้น B5)`)
          return false
        }
        return true
      }
      const appUrlOk = httpsOrigin('APP_URL', 'ระบบต่อ path ท้ายค่านี้เป็นลิงก์ในอีเมล')
      const authUrlOk = httpsOrigin('BETTER_AUTH_URL', 'Better Auth สร้าง callback และ cookie จากค่านี้')
      if (appUrlOk && authUrlOk && e.BETTER_AUTH_URL !== e.APP_URL) {
        issue('BETTER_AUTH_URL', 'ต้องเท่ากับ APP_URL — Better Auth ออก cookie และรับ callback ที่ที่อยู่นี้ (docs/runbooks/p0-08-vercel.md ขั้น B1)')
      }
      publicHttps('S3_ENDPOINT', e.S3_ENDPOINT, 'ต้องขึ้นต้นด้วย https:// และไม่ใช่ localhost นอก local — ใช้ endpoint ของที่เก็บไฟล์จริง (ADR-033)')
      publicHttps('SENTRY_DSN', e.SENTRY_DSN, 'ต้องขึ้นต้นด้วย https:// และไม่ใช่ localhost นอก local — ใช้ DSN จากโปรเจกต์ Sentry ของ environment นี้ (NFR-SEC-02)')
      for (const key of ['RD_VAT_SERVICE_URL', 'DBD_JURISTIC_API_URL'] as const) {
        publicHttps(key, e[key], 'ต้องขึ้นต้นด้วย https:// และไม่ใช่ localhost นอก local — ใช้ที่อยู่ของบริการจริงตาม .env.example (NFR-SEC-02)')
      }
      // Exactly the default as written, not merely the same address (BR-LINE-02, decided).
      if (parseUrl(e.LINE_API_BASE_URL) && e.LINE_API_BASE_URL !== LINE_API_ORIGIN) {
        issue('LINE_API_BASE_URL', `ต้องเป็น ${LINE_API_ORIGIN} นอก local — ลบตัวแปรนี้เพื่อใช้ค่าเริ่มต้น ระบบส่ง ID token ของ LIFF ไปตรวจที่นี่ (BR-LINE-02) fake LINE server ใช้ได้เฉพาะ local`)
      }
      // The channel access token goes with every upload, so only LINE's own data API may receive it (FR-ADM-006 AC2)
      if (parseUrl(e.LINE_DATA_API_BASE_URL) && e.LINE_DATA_API_BASE_URL !== LINE_DATA_API_ORIGIN) {
        issue('LINE_DATA_API_BASE_URL', `ต้องเป็น ${LINE_DATA_API_ORIGIN} นอก local — ลบตัวแปรนี้เพื่อใช้ค่าเริ่มต้น ระบบส่ง channel access token ไปกับการอัปโหลดภาพ rich menu ที่นี่ fake LINE server ใช้ได้เฉพาะ local`)
      }

      // Better Auth and the Inngest SDK read these from the environment themselves.
      for (const key of INNGEST_URLS) {
        const value = e[key]
        if (value !== undefined && !isPublicHttps(value)) {
          issue(key, 'ต้องเป็น URL ที่ขึ้นต้นด้วย https:// และไม่ใช่ localhost นอก local หรือไม่ต้องตั้ง (Inngest Cloud ใช้ค่าเริ่มต้นของ SDK) — Inngest dev server ใช้ได้เฉพาะ local')
        }
      }
      const trustedOrigins = (e.BETTER_AUTH_TRUSTED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter((o) => o !== '')
      if (trustedOrigins.some((o) => !isPublicHttps(o))) {
        issue('BETTER_AUTH_TRUSTED_ORIGINS', 'ทุก origin (คั่นด้วย ,) ต้องขึ้นต้นด้วย https:// และไม่ใช่ localhost นอก local — Better Auth เชื่อคำขอจาก origin เหล่านี้ (NFR-SEC-02)')
      }

      // Mailpit on this machine stands in for email locally (ADR-031); a shared environment would lose every email.
      if (e.EMAIL_SMTP_URL !== undefined) {
        const smtp = parseUrl(e.EMAIL_SMTP_URL)
        if (!smtp || isLocalHost(smtp.hostname)) {
          issue('EMAIL_SMTP_URL', 'ต้องเป็น SMTP ของผู้ให้บริการจริงในรูปแบบ smtp://user:password@host:port ไม่ใช่ localhost — Mailpit ใช้ได้เฉพาะ local (docs/runbooks/p0-08-vercel.md ขั้น B4)')
        }
      }

      // Outside local the database is Neon (§4.12): never this machine, never a published password, and each URL
      // connects as its own role.
      for (const key of ['DATABASE_URL', 'DIRECT_URL'] as const) {
        const target = connectionTarget(e[key])
        if (!target) {
          issue(key, 'อ่าน connection string ไม่ได้ — ใช้รูปแบบ postgresql://user:password@host/database และเขียน % ในรหัสผ่านเป็น %25')
          continue
        }
        if (target.hosts.length === 0 || target.hosts.some(isLocalHost)) {
          issue(key, 'ต้องชี้ไปที่ฐานข้อมูลของ environment นี้ (Neon ตาม §4.12) ไม่ใช่ localhost หรือ socket บนเครื่อง')
        }
        if (target.passwords.some(isPublishedSecret)) {
          issue(key, 'รหัสผ่านใน connection string ยังเป็นค่าที่เปิดเผยใน repo (.env.example หรือเอกสาร) — ตั้งรหัสผ่านใหม่ให้ role นี้')
        }
        // The Prisma CLI connects as the authority user and pg as the last non-empty ?user=: both must be the role.
        const { role, fix } = DB_ROLES[key]
        if (target.user !== role || target.queryUsers.some((u) => u !== '' && u !== role)) issue(key, fix)
      }
    }
    if (e.APP_ENV === 'production' && (e.SEED_DEV_PASSWORD || e.SEED_TOTP_KEY)) {
      issue('SEED_DEV_PASSWORD', 'production ห้ามมีค่าของ seed (ผู้ใช้ตัวอย่างสร้างได้เฉพาะ local/staging)')
    }
    if (e.SEED_DEV_PIN && e.APP_ENV !== 'local' && e.APP_ENV !== 'staging') issue('SEED_DEV_PIN', 'ใช้ได้เฉพาะ APP_ENV=local หรือ staging (PIN ของผู้ใช้ตัวอย่าง)')
  })
  // Runs only when every check passed, so lineApiBase() reads a value the checks above accepted.
  .transform((e) => ({
    ...e,
    LINE_API_BASE_URL: lineApiBase(e.LINE_API_BASE_URL) ?? LINE_API_ORIGIN,
    LINE_DATA_API_BASE_URL: lineApiBase(e.LINE_DATA_API_BASE_URL) ?? LINE_DATA_API_ORIGIN,
  }))

export type Env = z.infer<typeof schema>

export class EnvError extends Error {
  constructor(readonly issues: string[]) {
    super(`ค่าใน environment ไม่ถูกต้อง:\n${issues.map((i) => `- ${i}`).join('\n')}`)
    this.name = 'EnvError'
  }
}

/** The parsed environment, or one "KEY: message" line per issue (never the value, which may be a secret). */
function check(source: Record<string, string | undefined>): { env: Env } | { issues: string[] } {
  const result = schema.safeParse(source)
  if (result.success) return { env: result.data }
  return { issues: result.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`) }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const checked = check(source)
  if ('issues' in checked) throw new EnvError(checked.issues)
  return checked.env
}

/**
 * The issues that stop a tool which connects to a shared environment's database outside the app: `pnpm db:migrate`
 * and every Prisma CLI command (prisma.config.ts) check the whole environment first, so the DIRECT_URL host, role and
 * password rules run in the process that uses DIRECT_URL (FR-PLT-006 AC3, §4.12). Empty for APP_ENV=local, which
 * `pnpm verify` and the app check instead; APP_ENV unset counts as local, as in `pnpm db:migrate`, and any other value,
 * an empty or misspelled one included, is checked.
 */
export function envIssuesOutsideLocal(source: Record<string, string | undefined>): string[] {
  if ((source.APP_ENV ?? 'local') === 'local') return []
  const checked = check(source)
  return 'issues' in checked ? checked.issues : []
}

let cached: Env | undefined

/** Validated environment of the running process (memoized). */
export function getEnv(): Env {
  cached ??= parseEnv(process.env)
  return cached
}
