import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parse } from 'dotenv'
import { describe, expect, it } from 'vitest'
import { PASSWORD_MIN_LENGTH } from '@/lib/constants'
import { type Env, EnvError, envIssuesOutsideLocal, isLocalHost, parseEnv, postgresHosts } from '@/lib/env'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const KEY = `base64:${Buffer.alloc(32, 7).toString('base64')}`

const local = {
  APP_ENV: 'local',
  APP_URL: 'http://localhost:3000',
  SEED_DEV_PASSWORD: 'change-me-dev-only',
  DATABASE_URL: 'postgresql://bcs_app:bcs_app@localhost:5432/bcs',
  DIRECT_URL: 'postgresql://bcs_migrator:bcs_migrator@localhost:5432/bcs',
  BETTER_AUTH_SECRET: 'x'.repeat(40),
  BETTER_AUTH_URL: 'http://localhost:3000',
  ENCRYPTION_KEY: KEY,
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'ap-southeast-1',
  S3_BUCKET: 'bcs-local',
  S3_ACCESS_KEY_ID: 'minio',
  S3_SECRET_ACCESS_KEY: 'minio12345',
  S3_FORCE_PATH_STYLE: 'true',
  EMAIL_PROVIDER: 'smtp',
  EMAIL_SMTP_URL: 'smtp://localhost:1025',
  EMAIL_FROM: 'BCS <no-reply@bcs.local>',
  INNGEST_DEV: '1',
  INNGEST_EVENT_KEY: '',
  INNGEST_SIGNING_KEY: '',
  AI_ENABLED: 'false',
}

// A staging deployment configured as in docs/runbooks/p0-08-vercel.md (Neon, R2, Mailtrap, Inngest cloud).
const NEON_HOST = 'ep-calm-sun-a1b2c3.ap-southeast-1.aws.neon.tech'
const POOL_HOST = 'ep-calm-sun-a1b2c3-pooler.ap-southeast-1.aws.neon.tech'
const staging = {
  ...local,
  APP_ENV: 'staging',
  APP_URL: 'https://bcs-staging.example.com',
  BETTER_AUTH_URL: 'https://bcs-staging.example.com',
  SEED_DEV_PASSWORD: 'a-real-random-password',
  DATABASE_URL: `postgresql://bcs_app:test-only-app-pw@${POOL_HOST}/neondb?sslmode=require`,
  DIRECT_URL: `postgresql://bcs_migrator:test-only-migrator-pw@${NEON_HOST}/neondb?sslmode=require`,
  S3_ENDPOINT: 'https://0123456789abcdef.r2.cloudflarestorage.com',
  S3_REGION: 'auto',
  S3_BUCKET: 'bcs-staging',
  S3_ACCESS_KEY_ID: 'test-only-staging-access-key',
  S3_SECRET_ACCESS_KEY: 'test-only-staging-secret-key',
  EMAIL_SMTP_URL: 'smtp://user:pass@sandbox.smtp.mailtrap.io:2525',
  INNGEST_DEV: '',
  INNGEST_EVENT_KEY: 'evt',
  INNGEST_SIGNING_KEY: 'signkey-prod-123',
}

// .env.example as committed; the guards below must hold for its literal values, not for a copy in this file.
const example = parse(readFileSync(path.join(ROOT, '.env.example'), 'utf8'))

const SHARED_ENVS = ['preview', 'staging', 'production'] as const
type SharedEnv = (typeof SHARED_ENVS)[number]

/** The staging configuration under another shared APP_ENV (production carries no seed values). */
function shared(APP_ENV: SharedEnv): Record<string, string> {
  return { ...staging, APP_ENV, ...(APP_ENV === 'production' ? { SEED_DEV_PASSWORD: '' } : {}) }
}

function issues(source: Record<string, string>): string[] {
  try {
    parseEnv(source)
    return []
  } catch (error) {
    if (error instanceof EnvError) return error.issues
    throw error
  }
}

/** Issues reported for one variable (the "KEY: message" lines). */
function issuesFor(key: string, source: Record<string, string>): string[] {
  return issues(source).filter((line) => line.startsWith(`${key}:`))
}

/** The parsed environment, or undefined when parseEnv refuses the source. */
function accepted(source: Record<string, string>): Env | undefined {
  try {
    return parseEnv(source)
  } catch (error) {
    if (error instanceof EnvError) return undefined
    throw error
  }
}

describe('env schema (spec Appendix B)', () => {
  it('accepts the local defaults and treats empty strings as unset', () => {
    const env = parseEnv(local)
    expect(env.APP_ENV).toBe('local')
    expect(env.INNGEST_EVENT_KEY).toBeUndefined()
    expect(env.S3_FORCE_PATH_STYLE).toBe(true)
    expect(env.LINE_API_BASE_URL).toBe('https://api.line.me')
  })

  it('names a missing variable', () => {
    const { DATABASE_URL: _omit, ...rest } = local
    expect(issues(rest).join('\n')).toMatch(/^DATABASE_URL:/m)
  })

  it('requires ENCRYPTION_KEY to decode to 32 bytes', () => {
    expect(issues({ ...local, ENCRYPTION_KEY: 'base64:REPLACE_WITH_32_RANDOM_BYTES_BASE64' }).join()).toMatch(/ENCRYPTION_KEY/)
  })

  it('keeps AI off until S13 (EG-1)', () => {
    expect(issues({ ...local, AI_ENABLED: 'true' }).join()).toMatch(/AI_ENABLED/)
  })

  it('accepts a correctly configured staging environment', () => {
    expect(issues(staging)).toEqual([])
  })

  it('refuses example secrets, the Inngest dev mode and http outside local', () => {
    const found = issues({ ...staging, BETTER_AUTH_SECRET: 'change-me-at-least-32-characters', INNGEST_DEV: '1', APP_URL: 'http://x.example.com' })
    expect(found.join('\n')).toMatch(/BETTER_AUTH_SECRET/)
    expect(found.join('\n')).toMatch(/INNGEST_DEV/)
    expect(found.join('\n')).toMatch(/APP_URL/)
  })

  it('refuses test-only switches outside local', () => {
    const found = issues({ ...staging, E2E_TEST_CLOCK: '1', LIFF_MOCK: '1' }).join('\n')
    expect(found).toMatch(/E2E_TEST_CLOCK/)
    expect(found).toMatch(/LIFF_MOCK/)
    expect(issues({ ...local, E2E_TEST_CLOCK: '1', LIFF_MOCK: '1' })).toEqual([])
  })

  it('refuses seed credentials in production', () => {
    expect(issues({ ...staging, APP_ENV: 'production' }).join()).toMatch(/SEED_DEV_PASSWORD/)
  })
})

describe('[NFR-SEC-02] shared environments use https on real hosts, never this machine', () => {
  it('refuses the review scenario: localhost auth URL, example S3 keys and the fake LINE server', () => {
    for (const APP_ENV of SHARED_ENVS) {
      const found = issues({
        ...staging,
        APP_ENV,
        BETTER_AUTH_URL: 'http://localhost:3000',
        S3_ACCESS_KEY_ID: 'minio',
        S3_SECRET_ACCESS_KEY: 'minio12345',
        LINE_API_BASE_URL: 'http://localhost:4010',
      }).join('\n')
      for (const key of ['BETTER_AUTH_URL', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'LINE_API_BASE_URL']) {
        expect(found, `${APP_ENV} ${key}`).toMatch(new RegExp(`^${key}:`, 'm'))
      }
    }
  })

  it('refuses APP_URL and BETTER_AUTH_URL on http or on a loopback host', () => {
    const bad = [
      'http://localhost:3000',
      'https://localhost:3000',
      'https://LOCALHOST.',
      'https://app.localhost',
      'https://127.0.0.1:3000',
      'https://127.1',
      'https://[::1]:3000',
      'https://[::]',
      'https://0.0.0.0',
      'http://bcs-staging.example.com',
    ]
    for (const key of ['APP_URL', 'BETTER_AUTH_URL']) {
      for (const url of bad) {
        expect(issuesFor(key, { ...staging, [key]: url }), `${key}=${url}`).not.toEqual([])
        // Both set to the same value: each variable is refused by its own check, not by the comparison of the two.
        expect(issuesFor(key, { ...staging, APP_URL: url, BETTER_AUTH_URL: url }), `${key}=${url} (both)`).not.toEqual([])
      }
    }
  })

  it('accepts APP_URL and BETTER_AUTH_URL only as a bare lowercase https origin, each by its own check', () => {
    // src/server/auth/auth.ts issues Secure cookies for an https APP_URL, Better Auth builds its callbacks and cookies
    // from BETTER_AUTH_URL, and src/server/auth/emails.ts appends paths to APP_URL. z.url() returns the value as
    // written, so both are refused unless written as "https://host[:port]" (docs/runbooks/p0-08-vercel.md B1, B5).
    const spellings = [
      'HTTPS://bcs-staging.example.com',
      'Https://bcs-staging.example.com',
      'https:bcs-staging.example.com',
      'https:/bcs-staging.example.com',
      'https:\\\\bcs-staging.example.com',
      'https:/\\bcs-staging.example.com',
      'https://\\bcs-staging.example.com',
      'https:///bcs-staging.example.com',
      'https://bcs-staging.example.com/',
      'https://bcs-staging.example.com//',
      'https://bcs-staging.example.com/app',
      'https://bcs-staging.example.com/api/auth',
      'https://bcs-staging.example.com?next=1',
      'https://bcs-staging.example.com?',
      'https://bcs-staging.example.com#top',
      'https://BCS-Staging.example.com',
      'https://bcs-staging.example.com:443',
      'https://user:pw@bcs-staging.example.com',
    ]
    for (const APP_ENV of SHARED_ENVS) {
      expect(issues(shared(APP_ENV)), APP_ENV).toEqual([])
      for (const url of spellings) {
        // Both set to the same spelling (as p0-08 B1 asks): each variable is refused on its own.
        const both = { ...shared(APP_ENV), APP_URL: url, BETTER_AUTH_URL: url }
        expect(issuesFor('APP_URL', both), `${APP_ENV} APP_URL=${url}`).not.toEqual([])
        expect(issuesFor('BETTER_AUTH_URL', both), `${APP_ENV} BETTER_AUTH_URL=${url} (both)`).not.toEqual([])
        // Only BETTER_AUTH_URL misspelled, next to a correct APP_URL.
        expect(issuesFor('BETTER_AUTH_URL', { ...shared(APP_ENV), BETTER_AUTH_URL: url }), `${APP_ENV} BETTER_AUTH_URL=${url}`).not.toEqual([])
      }
      // Whatever a shared environment accepts, the consumers get https:// and a bare origin.
      for (const url of [...spellings, staging.APP_URL, ` ${staging.APP_URL} `]) {
        const env = accepted({ ...shared(APP_ENV), APP_URL: url, BETTER_AUTH_URL: url })
        if (!env) continue
        for (const value of [env.APP_URL, env.BETTER_AUTH_URL]) {
          expect(value.startsWith('https://'), `${APP_ENV} ${url}`).toBe(true)
          expect(value, `${APP_ENV} ${url}`).toBe(new URL(value).origin)
        }
      }
    }
  })

  it('accepts BETTER_AUTH_URL only as APP_URL itself (p0-08 B1: the same value)', () => {
    expect(issues({ ...staging, BETTER_AUTH_URL: staging.APP_URL })).toEqual([])
    const other = [
      `${staging.APP_URL}/`,
      `${staging.APP_URL}/api/auth`,
      'HTTPS://bcs-staging.example.com',
      'https:/bcs-staging.example.com',
      'https://BCS-Staging.example.com',
      'https://bcs-staging.example.com:443',
      'https://user:pw@bcs-staging.example.com',
      'https://bcs-staging.example.com?next=1',
      'https://bcs-staging.example.com/api/auth#x',
      'https://bcs-staging.example.com.evil.example',
    ]
    for (const APP_ENV of SHARED_ENVS) {
      for (const url of other) expect(issuesFor('BETTER_AUTH_URL', { ...shared(APP_ENV), BETTER_AUTH_URL: url }), `${APP_ENV} ${url}`).not.toEqual([])
    }
  })

  it('trims SEED_TOTP_KEY, so a key pasted with a trailing space or line break seeds the codes its copy gives', () => {
    const key = 'k'.repeat(43)
    expect(parseEnv({ ...staging, SEED_TOTP_KEY: `${key}
` }).SEED_TOTP_KEY).toBe(key)
    expect(parseEnv({ ...staging, SEED_TOTP_KEY: ` ${key} ` }).SEED_TOTP_KEY).toBe(key)
  })

  it('refuses LINE_API_BASE_URL on http or a loopback host, and accepts the real LINE API', () => {
    for (const url of ['http://localhost:4010', 'https://localhost:4010', 'https://127.0.0.1:4010', 'http://api.line.me']) {
      expect(issuesFor('LINE_API_BASE_URL', { ...staging, LINE_API_BASE_URL: url }), url).not.toEqual([])
    }
    expect(issues({ ...staging, LINE_API_BASE_URL: 'https://api.line.me' })).toEqual([])
    expect(parseEnv({ ...staging, LINE_API_BASE_URL: '' }).LINE_API_BASE_URL).toBe('https://api.line.me')
  })

  it('refuses an S3_ENDPOINT on http or a loopback host, and accepts the provider default when unset', () => {
    for (const url of ['http://localhost:9000', 'https://127.0.0.1:9000', 'http://s3.ap-southeast-1.amazonaws.com', 'HTTPS://0123456789abcdef.r2.cloudflarestorage.com']) {
      expect(issuesFor('S3_ENDPOINT', { ...staging, S3_ENDPOINT: url }), url).not.toEqual([])
    }
    expect(issues({ ...staging, S3_ENDPOINT: '' })).toEqual([])
  })

  it('refuses DATABASE_URL and DIRECT_URL that reach this machine (§4.12: Neon outside local)', () => {
    // Each URL connects as the right role, so the host is what is refused.
    const reachThisMachine = (role: string) => [
      `postgresql://${role}:pw@localhost:5432/bcs`,
      `postgres://${role}:pw@LOCALHOST/bcs`,
      `postgresql://${role}:pw@127.0.0.1:5432/bcs`,
      `postgresql://${role}:pw@127.1/bcs`,
      `postgresql://${role}:pw@[::1]:5432/bcs`,
      `postgresql://${role}:pw@[::]:5432/bcs`,
      `postgresql://${role}:pw@db.localhost/bcs`,
      `postgresql://${role}:pw@/bcs`, // no host: pg falls back to localhost
      `postgresql://${role}:pw@/bcs?host=/var/run/postgresql`, // Unix socket
      `postgresql://${role}:pw@%2Fvar%2Frun%2Fpostgresql/bcs`, // Unix socket, encoded in the host
      `postgresql://${role}:pw@${NEON_HOST}/bcs?host=localhost`, // pg prefers the host parameter
      `postgresql://${role}:pw@${NEON_HOST}/bcs?host=@bcs-socket`, // abstract Unix socket (libpq)
      `postgresql://${role}:pw@${NEON_HOST}/bcs?hostaddr=127.0.0.1`, // libpq connects to hostaddr
      `postgresql://${role}:pw@${NEON_HOST}/bcs?host=${NEON_HOST},localhost`, // libpq tries every host of a list
      `postgresql://${role}:pw@${NEON_HOST},localhost/bcs`,
    ]
    for (const [key, role] of [['DATABASE_URL', 'bcs_app'], ['DIRECT_URL', 'bcs_migrator']] as const) {
      for (const url of reachThisMachine(role)) expect(issuesFor(key, { ...staging, [key]: url }), `${key}=${url}`).not.toEqual([])
      expect(issues({ ...staging, [key]: `postgresql://${role}:pw@${NEON_HOST}/bcs` }), `${key} control`).toEqual([])
    }
    // No role at all: pg falls back to PGUSER or the OS user.
    for (const key of ['DATABASE_URL', 'DIRECT_URL']) expect(issuesFor(key, { ...staging, [key]: 'postgresql:///bcs' }), key).not.toEqual([])
  })

  it('reports malformed URLs by name instead of crashing', () => {
    const found = issues({ ...staging, APP_URL: 'not a url', BETTER_AUTH_URL: 'also not a url', DATABASE_URL: 'postgresql://u:p@host:port/db' })
    expect(found.join('\n')).toMatch(/^APP_URL:/m)
    expect(found.join('\n')).toMatch(/^BETTER_AUTH_URL:/m)
    expect(found.join('\n')).toMatch(/^DATABASE_URL:/m)
  })

  it('refuses hosts-file aliases, IPv4 addresses inside IPv6 and IPv6 zone ids that reach this machine', () => {
    // Aliases in /etc/hosts of Debian, RHEL and Amazon Linux images; IPv4-mapped and IPv4-compatible loopback; the
    // IPv6 unspecified address, which connect() sends to this machine.
    const hosts = [
      '[::]',
      'localhost.localdomain',
      'localhost4',
      'localhost4.localdomain4',
      'localhost6',
      'localhost6.localdomain6',
      'ip6-localhost',
      'ip6-loopback',
      '[::ffff:127.0.0.1]',
      '[::ffff:0.0.0.0]',
      '[::127.0.0.1]',
    ]
    for (const host of hosts) {
      const url = `https://${host}`
      for (const key of ['APP_URL', 'BETTER_AUTH_URL']) {
        expect(issuesFor(key, { ...staging, APP_URL: url, BETTER_AUTH_URL: url }), `${key} ${host}`).not.toEqual([])
      }
      for (const key of ['S3_ENDPOINT', 'SENTRY_DSN', 'INNGEST_BASE_URL', 'LINE_API_BASE_URL']) {
        expect(issuesFor(key, { ...staging, [key]: url }), `${key} ${host}`).not.toEqual([])
      }
    }
    for (const [key, role] of [['DATABASE_URL', 'bcs_app'], ['DIRECT_URL', 'bcs_migrator']] as const) {
      const urls = [
        ...hosts.map((host) => `postgresql://${role}:test-only-pw@${host}/bcs`),
        `postgresql://${role}:test-only-pw@${NEON_HOST}/bcs?host=::1%25lo`, // pg passes the zone id to connect(): loopback
        `postgresql://${role}:test-only-pw@${NEON_HOST}/bcs?host=localhost..`,
      ]
      for (const url of urls) expect(issuesFor(key, { ...staging, [key]: url }), url).not.toEqual([])
    }
  })

  it('accepts real hosts that only resemble local ones', () => {
    for (const url of ['https://localhost-proxy.example.com', 'https://127.example.com', 'https://[2001:db8::1]', 'https://bcs-staging.example.com:8443']) {
      expect(issues({ ...staging, APP_URL: url, BETTER_AUTH_URL: url }), url).toEqual([])
    }
    // A private address is another machine on the network, not this one.
    expect(issues({ ...staging, DATABASE_URL: 'postgresql://bcs_app:test-only-app-pw@10.0.0.5:5432/bcs' })).toEqual([])
  })

  it('refuses BETTER_AUTH_URL on another origin than APP_URL (Better Auth issues cookies and callbacks there)', () => {
    for (const APP_ENV of SHARED_ENVS) {
      expect(issuesFor('BETTER_AUTH_URL', { ...staging, APP_ENV, BETTER_AUTH_URL: 'https://bcs.example.com' }), APP_ENV).not.toEqual([])
    }
    // The same origin with a trailing slash is refused as well (p0-08 B5: no "/" at the end).
    expect(issuesFor('BETTER_AUTH_URL', { ...staging, BETTER_AUTH_URL: `${staging.APP_URL}/` })).not.toEqual([])
  })

  it('refuses an SMTP server on this machine (Mailpit is the local stand-in, ADR-031)', () => {
    for (const url of ['smtp://localhost:1025', 'smtp://127.0.0.1:1025', 'smtps://user:pw@[::1]:465', 'smtp://', 'smtp://smtp example.com:587']) {
      expect(issuesFor('EMAIL_SMTP_URL', { ...staging, EMAIL_SMTP_URL: url }), url).not.toEqual([])
    }
    // Loopback aliases and address forms, and values no URL parser can read (nodemailer could not either).
    const thisMachine = [
      'smtp://[::]:1025',
      'smtp://localhost6:1025',
      'smtp://localhost4.localdomain4:1025',
      'smtps://u:p@[::ffff:127.0.0.1]:465',
      'smtp://127.1:1025',
      'smtp://LOCALHOST:1025',
      'smtp://user:pw@:1025',
    ]
    const unreadable = ['smtp://smtp.example.com:port', 'smtp://[smtp.example.com]:587', 'smtps://user:pw@smtp example.com']
    for (const url of [...thisMachine, ...unreadable]) {
      for (const APP_ENV of SHARED_ENVS) expect(issuesFor('EMAIL_SMTP_URL', { ...shared(APP_ENV), EMAIL_SMTP_URL: url }), `${APP_ENV} ${url}`).not.toEqual([])
    }
    // The local SMTP URL never belongs on a shared environment, whichever provider is selected.
    expect(issuesFor('EMAIL_SMTP_URL', { ...staging, EMAIL_PROVIDER: 'resend', EMAIL_SMTP_URL: 'smtp://localhost:1025' })).not.toEqual([])
    expect(issues({ ...staging, EMAIL_SMTP_URL: 'smtps://resend:test-only-key@smtp.resend.com:465' })).toEqual([])
  })

  it('requires https on a real host for SENTRY_DSN and the registry services', () => {
    const bad: [string, string][] = [
      ['SENTRY_DSN', 'http://key@localhost:9000/1'],
      ['SENTRY_DSN', 'http://key@sentry.example.com/1'],
      ['SENTRY_DSN', 'HTTPS://key@o1.ingest.sentry.io/2'],
      ['RD_VAT_SERVICE_URL', 'http://localhost:4020/vat'],
      ['DBD_JURISTIC_API_URL', 'https://127.0.0.1:4021/juristic'],
    ]
    for (const [key, url] of bad) expect(issuesFor(key, { ...staging, REGISTRY_MODE: 'live', [key]: url }), `${key}=${url}`).not.toEqual([])
    const real = {
      SENTRY_DSN: 'https://key@o1.ingest.sentry.io/2',
      REGISTRY_MODE: 'live',
      RD_VAT_SERVICE_URL: example.RD_VAT_SERVICE_URL ?? '',
      DBD_JURISTIC_API_URL: example.DBD_JURISTIC_API_URL ?? '',
    }
    expect(issues({ ...staging, ...real })).toEqual([])
  })

  it('refuses this machine in the variables Better Auth and the Inngest SDK read from the environment themselves', () => {
    const bad: [string, string][] = [
      ['BETTER_AUTH_TRUSTED_ORIGINS', 'http://localhost:3000'],
      ['BETTER_AUTH_TRUSTED_ORIGINS', `${staging.APP_URL},http://localhost:3100`],
      ['BETTER_AUTH_TRUSTED_ORIGINS', 'https://127.0.0.1:3000'],
      ['BETTER_AUTH_TRUSTED_ORIGINS', 'http://bcs-staging.example.com'],
      ['BETTER_AUTH_TRUSTED_ORIGINS', 'bcs-staging.example.com'],
      ['INNGEST_BASE_URL', 'http://localhost:8288'],
      ['INNGEST_BASE_URL', 'https://[::1]:8288'],
      ['INNGEST_BASE_URL', 'not a url'],
      ['INNGEST_API_BASE_URL', 'http://127.0.0.1:8288'],
      ['INNGEST_EVENT_API_BASE_URL', 'http://inn.example.com'],
      ['INNGEST_SERVE_ORIGIN', 'http://localhost:3000'],
      ['INNGEST_SERVE_HOST', 'localhost:3000'],
    ]
    for (const APP_ENV of SHARED_ENVS) {
      for (const [key, value] of bad) expect(issuesFor(key, { ...shared(APP_ENV), [key]: value }), `${APP_ENV} ${key}=${value}`).not.toEqual([])
    }
    const real = {
      BETTER_AUTH_TRUSTED_ORIGINS: `${staging.APP_URL}, https://liff.line.me`,
      INNGEST_BASE_URL: 'https://inngest.example.com',
      INNGEST_API_BASE_URL: 'https://api.inngest.com',
      INNGEST_EVENT_API_BASE_URL: 'https://inn.gs',
      INNGEST_SERVE_ORIGIN: staging.APP_URL,
      INNGEST_SERVE_HOST: staging.APP_URL,
    }
    expect(issues({ ...staging, ...real })).toEqual([])
    // Locally the Inngest dev server and the e2e origin stay usable.
    const devServer = { BETTER_AUTH_TRUSTED_ORIGINS: 'http://localhost:3100', INNGEST_BASE_URL: 'http://localhost:8288', INNGEST_SERVE_ORIGIN: 'http://localhost:3000' }
    expect(issues({ ...local, ...devServer })).toEqual([])
  })

  it('reads the database host from ?host= when the authority has none, as pg does', () => {
    expect(issues({ ...staging, DATABASE_URL: `postgresql://bcs_app:test-only-app-pw@/neondb?host=${NEON_HOST}&sslmode=require` })).toEqual([])
    expect(issuesFor('DATABASE_URL', { ...staging, DATABASE_URL: 'postgresql://bcs_app:test-only-app-pw@/neondb' })).not.toEqual([])
  })

  it('reports connection strings pg cannot read and keeps the passwords pg re-encodes', () => {
    for (const url of ['postgres://%', `postgresql://bcs_app:%ff@${NEON_HOST}/bcs`]) {
      expect(issuesFor('DATABASE_URL', { ...staging, DATABASE_URL: url }), url).not.toEqual([])
    }
    for (const password of ['p%40ss%3Aw0rd', 'abc%zz', 'pw%']) {
      expect(issues({ ...staging, DATABASE_URL: `postgresql://bcs_app:${password}@${NEON_HOST}/bcs` }), password).toEqual([])
    }
  })

  it('exports the host reader behind these checks, so scripts that must stay on this machine see a ?host= too', () => {
    // pg connects to ?host= when it is set, whatever the authority says (scripts/db-reset.ts drops the schema).
    const remoteBehindLocal = [
      `postgresql://bcs_migrator:pw@localhost:5432/bcs?host=${NEON_HOST}`,
      `postgresql://bcs_migrator:pw@localhost:5432/neondb?sslmode=require&host=${NEON_HOST}`,
      `postgresql://bcs_migrator:pw@127.0.0.1/bcs?host=${NEON_HOST}&port=5432`,
    ]
    for (const url of remoteBehindLocal) {
      expect(postgresHosts(url), url).toContain(NEON_HOST)
      expect(postgresHosts(url)?.every(isLocalHost), url).toBe(false)
    }
    const thisMachine = [example.DIRECT_URL ?? '', example.DATABASE_URL ?? '', 'postgresql://bcs_migrator:pw@/bcs?host=/var/run/postgresql', 'postgresql://bcs_migrator:pw@[::1]:5432/bcs']
    for (const url of thisMachine) expect(postgresHosts(url)?.every(isLocalHost), url).toBe(true)
    expect(postgresHosts('postgres://%')).toBeUndefined()
  })
})

describe('[BR-LINE-02] outside local, LIFF ID tokens are verified by LINE itself', () => {
  it('refuses every LINE_API_BASE_URL other than https://api.line.me in shared environments', () => {
    // src/server/auth/liff.ts posts the token to `${LINE_API_BASE_URL}/oauth2/v2.1/verify` and trusts the claims
    // that come back, so any other host could vouch for any LINE user.
    const others = [
      'https://api.line.me@evil.example',
      'https://api.line.me.evil.example',
      'https://evil.example/https://api.line.me',
      'https://fake-line.ngrok-free.app',
      'https://api.line.me/',
      'https://api.line.me/oauth2',
      'https://API.LINE.ME',
      'HTTPS://api.line.me',
      'https://api.line.me:443',
      'http://api.line.me',
      'http://localhost:4010',
    ]
    for (const APP_ENV of SHARED_ENVS) {
      for (const url of others) expect(issuesFor('LINE_API_BASE_URL', { ...shared(APP_ENV), LINE_API_BASE_URL: url }), `${APP_ENV} ${url}`).not.toEqual([])
    }
  })

  it('sends the token to https://api.line.me/oauth2/v2.1/verify when the variable is unset or the real API', () => {
    for (const APP_ENV of SHARED_ENVS) {
      for (const LINE_API_BASE_URL of ['', 'https://api.line.me']) {
        const env = parseEnv({ ...shared(APP_ENV), LINE_API_BASE_URL })
        expect(`${env.LINE_API_BASE_URL}/oauth2/v2.1/verify`, `${APP_ENV} "${LINE_API_BASE_URL}"`).toBe('https://api.line.me/oauth2/v2.1/verify')
      }
    }
    // The e2e fake LINE server stays available locally.
    expect(parseEnv({ ...local, LINE_API_BASE_URL: 'http://localhost:4010' }).LINE_API_BASE_URL).toBe('http://localhost:4010')
  })

  it('gives liff.ts one well-formed verify URL for every spelling it accepts, in every APP_ENV', () => {
    // liff.ts appends "/oauth2/v2.1/verify" to the value as it is, so a trailing slash, upper case or :443 that the
    // schema let through would change the URL the ID token is posted to.
    const spellings = [
      'https://api.line.me',
      'https://api.line.me/',
      'https://api.line.me//',
      ' https://api.line.me/ ',
      'HTTPS://API.LINE.ME:443/',
      'https://api.line.me/.',
      'http://localhost:4010/',
      'http://localhost:3000/fake-line/',
    ]
    const sources: [string, Record<string, string>][] = [['local', local], ...SHARED_ENVS.map((e): [string, Record<string, string>] => [e, shared(e)])]
    for (const [APP_ENV, source] of sources) {
      for (const url of spellings) {
        const env = accepted({ ...source, LINE_API_BASE_URL: url })
        if (!env) continue
        const verify = `${env.LINE_API_BASE_URL}/oauth2/v2.1/verify`
        const parsed = new URL(verify)
        expect(verify, `${APP_ENV} ${url}`).toBe(parsed.href)
        expect(parsed.pathname, `${APP_ENV} ${url}`).not.toContain('//')
        expect(parsed.pathname.endsWith('/oauth2/v2.1/verify'), `${APP_ENV} ${url}`).toBe(true)
      }
    }
    // Locally a trailing slash is dropped instead of doubling the slash, and a path prefix is kept.
    expect(parseEnv({ ...local, LINE_API_BASE_URL: 'https://api.line.me/' }).LINE_API_BASE_URL).toBe('https://api.line.me')
    expect(parseEnv({ ...local, LINE_API_BASE_URL: 'http://localhost:3000/fake-line/' }).LINE_API_BASE_URL).toBe('http://localhost:3000/fake-line')
  })

  it('refuses a LINE_API_BASE_URL that cannot be the base of the verify URL, locally too', () => {
    // A query, fragment or user:password swallows or breaks the appended path; any other scheme is not an HTTP API.
    const notBase = [
      'https://api.line.me?x=1',
      'https://api.line.me?',
      'https://api.line.me#frag',
      'https://api.line.me#',
      'https://user:pw@api.line.me',
      'http://localhost:4010/?mock=1',
      'ftp://api.line.me',
      'mailto:verify@api.line.me',
    ]
    for (const source of [local, ...SHARED_ENVS.map(shared)]) {
      for (const url of notBase) {
        expect(issuesFor('LINE_API_BASE_URL', { ...source, LINE_API_BASE_URL: url }), `${source.APP_ENV} ${url}`).not.toEqual([])
      }
    }
  })
})

describe('[FR-PLT-006/AC3] the runtime and migrations use different database roles outside local', () => {
  it('refuses one role (e.g. the Neon owner) in both DATABASE_URL and DIRECT_URL', () => {
    const owner = `postgresql://neondb_owner:test-only-owner-pw@${NEON_HOST}/neondb?sslmode=require`
    for (const APP_ENV of SHARED_ENVS) {
      expect(issuesFor('DATABASE_URL', { ...staging, APP_ENV, DATABASE_URL: owner, DIRECT_URL: owner }), APP_ENV).not.toEqual([])
    }
    // pg lets the user parameter override the user in the authority.
    const viaParam = `postgresql://bcs_app:test-only-app-pw@${NEON_HOST}/neondb?user=bcs_migrator`
    expect(issuesFor('DATABASE_URL', { ...staging, DATABASE_URL: viaParam })).not.toEqual([])
    expect(issues({ ...local, DATABASE_URL: local.DIRECT_URL })).toEqual([])
  })

  it('requires role bcs_app at runtime and bcs_migrator for migrations, the roles the migrations grant to', () => {
    const owner = `postgresql://neondb_owner:test-only-owner-pw@${NEON_HOST}/neondb?sslmode=require`
    for (const APP_ENV of SHARED_ENVS) {
      expect(issuesFor('DATABASE_URL', { ...staging, APP_ENV, DATABASE_URL: owner }), `${APP_ENV} owner at runtime`).not.toEqual([])
      expect(issuesFor('DIRECT_URL', { ...staging, APP_ENV, DIRECT_URL: owner }), `${APP_ENV} owner for migrations`).not.toEqual([])
    }
    // No role in either URL: pg falls back to PGUSER or the OS user, the same role for both.
    const noRole = { DATABASE_URL: `postgresql://${NEON_HOST}/neondb?password=test-only-app-pw`, DIRECT_URL: `postgresql://${NEON_HOST}/neondb?password=test-only-migrator-pw` }
    expect(issuesFor('DATABASE_URL', { ...staging, ...noRole })).not.toEqual([])
    expect(issuesFor('DIRECT_URL', { ...staging, ...noRole })).not.toEqual([])
    // pg takes the last value of a repeated ?user= and decodes the authority.
    expect(issuesFor('DATABASE_URL', { ...staging, DATABASE_URL: `postgresql://bcs_app:test-only-app-pw@${NEON_HOST}/neondb?user=bcs_app&user=bcs_migrator` })).not.toEqual([])
    expect(issues({ ...staging, DATABASE_URL: `postgresql://bcs%5Fapp:test-only-app-pw@${NEON_HOST}/neondb` })).toEqual([])
  })

  it('reads the role from the user part, where the Prisma CLI reads it, and refuses a ?user= naming another role', () => {
    // The Prisma CLI that runs migrations connects as the authority user and ignores ?user=; pg lets a non-empty
    // ?user= override the authority. Both must arrive at the same role.
    const ownerAsMigrator = `postgresql://neondb_owner:test-only-owner-pw@${NEON_HOST}/neondb?sslmode=require&user=bcs_migrator`
    const ownerAsApp = `postgresql://neondb_owner:test-only-owner-pw@${POOL_HOST}/neondb?sslmode=require&user=bcs_app`
    const roleOnlyInParam = `postgresql://:test-only-migrator-pw@${NEON_HOST}/neondb?user=bcs_migrator`
    for (const APP_ENV of SHARED_ENVS) {
      expect(issuesFor('DIRECT_URL', { ...shared(APP_ENV), DIRECT_URL: ownerAsMigrator }), `${APP_ENV} DIRECT_URL`).not.toEqual([])
      expect(issuesFor('DIRECT_URL', { ...shared(APP_ENV), DIRECT_URL: roleOnlyInParam }), `${APP_ENV} DIRECT_URL ?user= only`).not.toEqual([])
      expect(issuesFor('DATABASE_URL', { ...shared(APP_ENV), DATABASE_URL: ownerAsApp }), `${APP_ENV} DATABASE_URL`).not.toEqual([])
    }
    // A ?user= that repeats the role, or an empty one (pg then falls back to the authority), keeps both on that role.
    expect(issues({ ...staging, DIRECT_URL: `${staging.DIRECT_URL}&user=bcs_migrator`, DATABASE_URL: `${staging.DATABASE_URL}&user=` })).toEqual([])
    expect(issues({ ...staging, DIRECT_URL: `${staging.DIRECT_URL}&user=`, DATABASE_URL: `${staging.DATABASE_URL}&user=bcs_app` })).toEqual([])
  })

  it('refuses a DIRECT_URL whose ?user= names another role, even with the migrator in the user part', () => {
    // The Prisma CLI would still log in as bcs_migrator, but pg (scripts, test setup) would log in as the ?user= role:
    // the two consumers must agree on one role.
    for (const APP_ENV of SHARED_ENVS) {
      for (const other of ['neondb_owner', 'bcs_app', 'BCS_MIGRATOR']) {
        const url = `${staging.DIRECT_URL}&user=${other}`
        expect(issuesFor('DIRECT_URL', { ...shared(APP_ENV), DIRECT_URL: url }), `${APP_ENV} ?user=${other}`).not.toEqual([])
      }
      // The last ?user= is not the only one read: an earlier one naming another role is refused too.
      const earlier = `${staging.DIRECT_URL}&user=neondb_owner&user=bcs_migrator`
      expect(issuesFor('DIRECT_URL', { ...shared(APP_ENV), DIRECT_URL: earlier }), `${APP_ENV} earlier ?user=`).not.toEqual([])
    }
  })
})

/** Variables the schema reads, and the PG* variables pg and libpq read, removed before a script runs in a test. */
const ENV_VARIABLE = /^(APP_|SEED_|DATABASE_URL$|DIRECT_URL$|BETTER_AUTH_|ENCRYPTION_KEY$|S3_|EMAIL_|REGISTRY_MODE$|RD_|DBD_|INNGEST_|LINE_|NEXT_PUBLIC_LIFF_ID$|GOOGLE_|MICROSOFT_|LOG_LEVEL$|SENTRY_DSN$|AI_|ANTHROPIC_|E2E_TEST_CLOCK$|LIFF_MOCK$|VERCEL|PG)/i

/**
 * Runs `node <args>` in an empty temporary folder with exactly the given variables (no .env is found there), so a
 * script that is not stopped cannot reach the developer database: the Prisma CLI finds no project and pg no .env.
 */
function runIsolated(args: string[], vars: Record<string, string>): { status: number | null; output: string } {
  const cwd = mkdtempSync(path.join(tmpdir(), 'bcs-env-test-'))
  try {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !ENV_VARIABLE.test(key)))
    // Next.js declares NODE_ENV on ProcessEnv; the child gets whatever this process has
    const env = { ...inherited, ...vars } as NodeJS.ProcessEnv
    const r = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 90_000 })
    return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

describe('[FR-PLT-006/AC3] outside local, migrations check the environment before they connect', () => {
  // The superuser of this machine with the docker-compose password, on a port nothing listens to.
  const SUPERUSER_HERE = 'postgresql://postgres:postgres@127.0.0.1:9/bcs'
  const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const PRISMA = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js')
  const CONFIG = path.join(ROOT, 'prisma.config.ts')

  it('reports the DIRECT_URL host, password and role rules outside local, and nothing for local', () => {
    const broken = [
      `postgresql://bcs_migrator:test-only-migrator-pw@localhost:5432/neondb`, // this machine
      `postgresql://bcs_migrator:bcs_migrator@${NEON_HOST}/neondb`, // the .env.example password
      `postgresql://neondb_owner:test-only-owner-pw@${NEON_HOST}/neondb?user=bcs_migrator`, // the owner for the Prisma CLI
    ]
    for (const APP_ENV of SHARED_ENVS) {
      expect(envIssuesOutsideLocal(shared(APP_ENV)), APP_ENV).toEqual([])
      for (const DIRECT_URL of broken) {
        const found = envIssuesOutsideLocal({ ...shared(APP_ENV), DIRECT_URL })
        expect(found.some((line) => line.startsWith('DIRECT_URL:')), `${APP_ENV} ${DIRECT_URL}`).toBe(true)
        expect(found.join('\n')).not.toMatch(/test-only|neon\.tech/)
      }
    }
    // Local (APP_ENV unset counts as local, as in pnpm db:migrate) is checked by the app and pnpm verify instead.
    expect(envIssuesOutsideLocal({ APP_ENV: 'local', DIRECT_URL: SUPERUSER_HERE })).toEqual([])
    expect(envIssuesOutsideLocal({ DIRECT_URL: SUPERUSER_HERE })).toEqual([])
    // Anything else that is not exactly "local" is checked, and an unknown APP_ENV is itself an issue.
    for (const APP_ENV of ['', 'Local', ' local', 'stagging']) {
      expect(envIssuesOutsideLocal({ ...staging, APP_ENV }).some((line) => line.startsWith('APP_ENV:')), JSON.stringify(APP_ENV)).toBe(true)
    }
  })

  it('pnpm db:migrate stops with the Thai issue list before the Prisma CLI starts', () => {
    const r = runIsolated([TSX, path.join(ROOT, 'scripts', 'db-migrate.ts')], { ...staging, DIRECT_URL: SUPERUSER_HERE })
    expect(r.status, r.output).toBe(1)
    expect(r.output).toMatch(/^db:migrate /m)
    expect(r.output).toMatch(/^- DIRECT_URL: /m)
    // Nothing was started after the check: no Prisma CLI, no connection attempt, and no value repeated.
    expect(r.output).not.toMatch(/Loaded Prisma config|Prisma schema loaded|Datasource|P1001|ERR_PNPM|not found/i)
    expect(r.output).not.toMatch(/postgres:postgres|127\.0\.0\.1/)
  }, 120_000)

  it('a Prisma CLI command started directly stops in prisma.config.ts, and a valid environment still loads', () => {
    const quiet = { CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' }
    const refused = runIsolated([PRISMA, 'migrate', 'deploy', '--config', CONFIG], { ...staging, ...quiet, DIRECT_URL: SUPERUSER_HERE })
    expect(refused.status, refused.output).toBe(1)
    expect(refused.output).toMatch(/^- DIRECT_URL: /m)
    expect(refused.output).not.toMatch(/Datasource|P1001|migrations? (found|applied)/i)
    expect(refused.output).not.toMatch(/postgres:postgres/)
    // `prisma validate` reads the config and the schema without connecting anywhere.
    const valid = runIsolated([PRISMA, 'validate', '--config', CONFIG], { ...staging, ...quiet })
    expect(valid.status, valid.output).toBe(0)
    expect(valid.output).not.toMatch(/^- /m)
  }, 180_000)
})

describe('[FR-AUTH-001/AC2] seeded users get a password the product accepts', () => {
  it('refuses a SEED_DEV_PASSWORD shorter than PASSWORD_MIN_LENGTH in every APP_ENV', () => {
    // FR-AUTH-001 AC2: at least 12 characters; prisma/seed.ts refuses shorter ones, so the app must not start with one.
    expect(PASSWORD_MIN_LENGTH).toBeGreaterThanOrEqual(12)
    const sources = [local, ...SHARED_ENVS.map(shared)]
    for (const source of sources) {
      for (const password of ['abcdefgh', 'k'.repeat(PASSWORD_MIN_LENGTH - 1)]) {
        const found = issuesFor('SEED_DEV_PASSWORD', { ...source, SEED_DEV_PASSWORD: password })
        expect(found, `${source.APP_ENV} ${password.length} characters`).not.toEqual([])
        expect(found.join('\n')).toContain(String(PASSWORD_MIN_LENGTH))
        expect(found.join('\n')).not.toContain(password)
      }
    }
    // Long enough is accepted where seed values are allowed (production refuses seed values altogether).
    for (const source of [local, shared('preview'), shared('staging')]) {
      expect(issuesFor('SEED_DEV_PASSWORD', { ...source, SEED_DEV_PASSWORD: 'k'.repeat(PASSWORD_MIN_LENGTH) }), source.APP_ENV).toEqual([])
    }
    // The .env.example value a developer starts from stays valid locally, and unset stays allowed.
    expect((example.SEED_DEV_PASSWORD ?? '').length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH)
    expect(issues({ ...local, SEED_DEV_PASSWORD: example.SEED_DEV_PASSWORD ?? '' })).toEqual([])
    expect(issues({ ...local, SEED_DEV_PASSWORD: '' })).toEqual([])
  })
})

describe('[NFR-SEC-07] values published in .env.example never reach a shared environment', () => {
  it('refuses every secret and local address copied from .env.example', () => {
    const copied = [
      'APP_URL',
      'BETTER_AUTH_URL',
      'DATABASE_URL',
      'DIRECT_URL',
      'BETTER_AUTH_SECRET',
      'ENCRYPTION_KEY',
      'SEED_DEV_PASSWORD',
      'SEED_TOTP_KEY',
      'S3_ENDPOINT',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'INNGEST_DEV',
    ]
    for (const APP_ENV of SHARED_ENVS) {
      for (const key of copied) {
        const value = example[key]
        expect(value, `.env.example ${key}`).toBeTruthy()
        expect(issuesFor(key, { ...staging, APP_ENV, [key]: value ?? '' }), `${APP_ENV} ${key}`).not.toEqual([])
      }
    }
  })

  it('refuses the example role passwords even when the database host is real', () => {
    for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
      const moved = new URL(example[key] ?? '')
      moved.host = NEON_HOST
      expect(moved.hostname).toBe(NEON_HOST)
      expect(issuesFor(key, { ...staging, [key]: moved.href }), key).not.toEqual([])
    }
    // pg also reads the password from the query string.
    expect(issuesFor('DATABASE_URL', { ...staging, DATABASE_URL: `postgresql://bcs_app@${NEON_HOST}/neondb?password=bcs_app` })).not.toEqual([])
  })

  it('refuses an example value in any secret variable, whatever its case or surrounding spaces', () => {
    const cases: [string, string][] = [
      ['S3_ACCESS_KEY_ID', 'MINIO'],
      ['S3_SECRET_ACCESS_KEY', ' minio12345 '],
      ['SEED_DEV_PASSWORD', 'minio12345'],
      // Long enough for the password rule, so only the published-value check can refuse it.
      ['SEED_DEV_PASSWORD', ' Paste_BCS_App_Password_Here '],
      ['SEED_TOTP_KEY', 'Change-Me-Dev-Only-TOTP-Key-32chars'],
      ['INNGEST_SIGNING_KEY', 'change-me'],
      ['LINE_MESSAGING_CHANNEL_SECRET', 'minio12345'],
    ]
    for (const [key, value] of cases) {
      expect(issuesFor(key, { ...staging, [key]: value }), `${key}=${JSON.stringify(value)}`).not.toEqual([])
    }
  })

  it('refuses the example bucket whatever its case or surrounding spaces', () => {
    for (const bucket of ['bcs-local', 'BCS-LOCAL', ' bcs-local ']) {
      expect(issuesFor('S3_BUCKET', { ...staging, S3_BUCKET: bucket }), JSON.stringify(bucket)).not.toEqual([])
    }
  })

  it('never repeats the secret in the message', () => {
    const found = issues({
      ...staging,
      S3_SECRET_ACCESS_KEY: 'minio12345',
      DATABASE_URL: `postgresql://bcs_app:bcs_app@${NEON_HOST}/neondb`,
      DIRECT_URL: 'postgresql://bcs_migrator:not-shown-pw@localhost:5432/bcs',
    }).join('\n')
    expect(found).toMatch(/^S3_SECRET_ACCESS_KEY:/m)
    expect(found).toMatch(/^DATABASE_URL:/m)
    expect(found).toMatch(/^DIRECT_URL:/m)
    expect(found).not.toMatch(/minio12345|bcs_app:bcs_app|not-shown-pw|neon\.tech/)
  })

  it('local still starts from .env.example, including the e2e fake LINE server and test switches', () => {
    // The ENCRYPTION_KEY placeholder is the one value a developer must replace even locally (32 random bytes).
    const env = { ...example, ENCRYPTION_KEY: KEY, LINE_API_BASE_URL: 'http://localhost:4010', E2E_TEST_CLOCK: '1', LIFF_MOCK: '1' }
    expect(example.APP_ENV).toBe('local')
    expect(issues(env)).toEqual([])
  })

  it('refuses APP_ENV=local on a Vercel deployment, where it would switch every check off', () => {
    const copied = { ...example, ENCRYPTION_KEY: KEY }
    for (const VERCEL_ENV of ['production', 'preview', 'Production', ' preview ']) {
      expect(issuesFor('APP_ENV', { ...copied, VERCEL_ENV }), VERCEL_ENV).not.toEqual([])
    }
    // `vercel dev` and `vercel env pull` set VERCEL_ENV=development on a developer machine.
    expect(issues({ ...copied, VERCEL_ENV: 'development' })).toEqual([])
    // The staging project deploys with --prod, so it runs as VERCEL_ENV=production (docs/runbooks/p0-08-vercel.md).
    expect(issues({ ...staging, VERCEL_ENV: 'production' })).toEqual([])
  })

  // .env.example values that shared environments really use (docs/runbooks/p0-08-vercel.md B1–B4), with the reason.
  const SHARED_EXAMPLE_VALUES: Record<string, string> = {
    S3_REGION: 'a real region',
    S3_FORCE_PATH_STYLE: 'the staging store accepts path-style only (p0-06)',
    EMAIL_PROVIDER: 'smtp is the only provider built so far (B4)',
    EMAIL_FROM: 'the email sandbox option keeps this sender (B4)',
    REGISTRY_MODE: 'stub is the OQ-37 default (B1)',
    RD_VAT_SERVICE_URL: 'the real Revenue Department service',
    DBD_JURISTIC_API_URL: 'the real DBD service',
    MICROSOFT_TENANT_ID: 'the Microsoft multi-tenant endpoint',
    LOG_LEVEL: 'B1',
    AI_ENABLED: 'stays false until S13',
    AI_MODEL_DEFAULT: 'a model id',
    LINE_API_BASE_URL: 'the real LINE API',
  }

  it('refuses every other .env.example value, so a new local-only example cannot reach a shared environment', () => {
    for (const key of Object.keys(SHARED_EXAMPLE_VALUES)) expect(example[key], `.env.example ${key}`).toBeTruthy()
    for (const [key, value] of Object.entries(example)) {
      if (!value || key === 'APP_ENV') continue
      for (const APP_ENV of SHARED_ENVS) {
        const found = issuesFor(key, { ...staging, APP_ENV, [key]: value })
        const reason = SHARED_EXAMPLE_VALUES[key]
        if (reason) expect(found, `${APP_ENV} ${key}: ${reason}`).toEqual([])
        else expect(found, `${APP_ENV} ${key} copied from .env.example`).not.toEqual([])
      }
    }
  })

  it('refuses credentials published elsewhere: the docker-compose superuser, the runbook placeholder and storage defaults', () => {
    expect(issuesFor('DIRECT_URL', { ...staging, DIRECT_URL: `postgresql://bcs_migrator:postgres@${NEON_HOST}/bcs` })).not.toEqual([])
    const placeholder = `postgresql://bcs_app:PASTE_BCS_APP_PASSWORD_HERE@${NEON_HOST}/bcs` // docs/runbooks/p0-05-neon-staging.md
    expect(issuesFor('DATABASE_URL', { ...staging, DATABASE_URL: placeholder })).not.toEqual([])
    for (const value of ['minioadmin', 'rustfsadmin']) {
      for (const key of ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) expect(issuesFor(key, { ...staging, [key]: value }), `${key}=${value}`).not.toEqual([])
    }
  })

  it('never repeats a value in the messages of the host, origin and role checks', () => {
    const found = issues({
      ...staging,
      BETTER_AUTH_URL: 'https://hidden-origin.example.com',
      EMAIL_SMTP_URL: 'smtp://hidden-mail-user:hidden-mail-pw@localhost:1025',
      SENTRY_DSN: 'http://hiddendsnkey@hidden-sentry.example.com/1',
      DATABASE_URL: `postgresql://hidden_owner:hidden-db-pw@${NEON_HOST}/neondb`,
      DIRECT_URL: `postgresql://hidden_owner2:hidden-db-pw2@${NEON_HOST}/neondb`,
      LINE_API_BASE_URL: 'https://hidden-line.example.com',
      BETTER_AUTH_TRUSTED_ORIGINS: 'http://hidden-trusted.example.com',
      INNGEST_BASE_URL: 'http://hidden-inngest.localhost:8288',
    }).join('\n')
    const keys = ['BETTER_AUTH_URL', 'EMAIL_SMTP_URL', 'SENTRY_DSN', 'DATABASE_URL', 'DIRECT_URL', 'LINE_API_BASE_URL', 'BETTER_AUTH_TRUSTED_ORIGINS', 'INNGEST_BASE_URL']
    for (const key of keys) expect(found).toMatch(new RegExp(`^${key}:`, 'm'))
    expect(found).not.toMatch(/hidden|neon\.tech/)
    const form = issues({ ...staging, APP_URL: 'https://hidden-app.example.com/hidden-path', BETTER_AUTH_URL: 'https://hidden-app.example.com/hidden-path' }).join('\n')
    expect(form).toMatch(/^APP_URL:/m)
    expect(form).not.toMatch(/hidden/)
  })
})
