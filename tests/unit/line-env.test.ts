import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'dotenv'
import { describe, expect, it } from 'vitest'
import { EnvError, parseEnv } from '@/lib/env'

// FR-ADM-006 AC2: the channel access token of an organization goes with every rich menu image upload to
// LINE_DATA_API_BASE_URL, so outside local only LINE's own data API (https://api-data.line.me) may be that address — as
// LINE_API_BASE_URL may only be https://api.line.me (BR-LINE-02). Locally the fake LINE server stands in for both.

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const KEY = `base64:${Buffer.alloc(32, 7).toString('base64')}`
const NEON = 'ep-calm-sun-a1b2c3.ap-southeast-1.aws.neon.tech'

const local = {
  APP_ENV: 'local',
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://bcs_app:bcs_app@localhost:5432/bcs',
  DIRECT_URL: 'postgresql://bcs_migrator:bcs_migrator@localhost:5432/bcs',
  BETTER_AUTH_SECRET: 'x'.repeat(40),
  BETTER_AUTH_URL: 'http://localhost:3000',
  ENCRYPTION_KEY: KEY,
  S3_REGION: 'ap-southeast-1',
  S3_BUCKET: 'bcs-local',
  S3_ACCESS_KEY_ID: 'minio',
  S3_SECRET_ACCESS_KEY: 'minio12345',
  EMAIL_PROVIDER: 'smtp',
  EMAIL_SMTP_URL: 'smtp://localhost:1025',
  EMAIL_FROM: 'BCS <no-reply@bcs.local>',
}
const shared = (APP_ENV: string) => ({
  ...local,
  APP_ENV,
  APP_URL: 'https://bcs-staging.example.com',
  BETTER_AUTH_URL: 'https://bcs-staging.example.com',
  DATABASE_URL: `postgresql://bcs_app:test-only-app-pw@${NEON}/neondb?sslmode=require`,
  DIRECT_URL: `postgresql://bcs_migrator:test-only-migrator-pw@${NEON}/neondb?sslmode=require`,
  S3_ENDPOINT: 'https://0123456789abcdef.r2.cloudflarestorage.com',
  S3_BUCKET: 'bcs-staging',
  S3_ACCESS_KEY_ID: 'test-only-staging-access-key',
  S3_SECRET_ACCESS_KEY: 'test-only-staging-secret-key',
  EMAIL_SMTP_URL: 'smtp://user:pass@sandbox.smtp.mailtrap.io:2525',
  INNGEST_EVENT_KEY: 'evt',
  INNGEST_SIGNING_KEY: 'signkey-prod-123',
})
const SHARED = ['preview', 'staging', 'production'].map(shared)

function issuesFor(key: string, source: Record<string, string>): string[] {
  try {
    parseEnv(source)
    return []
  } catch (error) {
    if (error instanceof EnvError) return error.issues.filter((line) => line.startsWith(`${key}:`))
    throw error
  }
}

describe('[FR-ADM-006/AC2] outside local the channel access token is uploaded to LINE data API only', () => {
  it('uses https://api-data.line.me when unset, everywhere, and the shared configurations are valid', () => {
    expect(parseEnv(local).LINE_DATA_API_BASE_URL).toBe('https://api-data.line.me')
    for (const source of SHARED) {
      expect(issuesFor('LINE_DATA_API_BASE_URL', source), source.APP_ENV).toEqual([])
      for (const value of ['', 'https://api-data.line.me']) {
        expect(parseEnv({ ...source, LINE_DATA_API_BASE_URL: value }).LINE_DATA_API_BASE_URL, `${source.APP_ENV} "${value}"`).toBe('https://api-data.line.me')
      }
    }
  })

  it('refuses every other address in a shared environment, without repeating it', () => {
    const others = [
      'https://api-data.line.me.evil.example',
      'https://api-data.line.me@evil.example',
      'https://evil.example/https://api-data.line.me',
      'https://api.line.me',
      'https://api-data.line.me/',
      'https://API-DATA.LINE.ME',
      'https://api-data.line.me:443',
      'http://api-data.line.me',
      'http://127.0.0.1:4100',
      'https://hidden-fake.ngrok-free.app',
    ]
    for (const source of SHARED) {
      for (const url of others) {
        const found = issuesFor('LINE_DATA_API_BASE_URL', { ...source, LINE_DATA_API_BASE_URL: url })
        expect(found, `${source.APP_ENV} ${url}`).not.toEqual([])
        expect(found.join('\n')).not.toMatch(/evil|hidden|127\.0\.0\.1/)
      }
    }
  })

  it('locally accepts the fake LINE server, as one well-formed base, and refuses what cannot be a base anywhere', () => {
    expect(parseEnv({ ...local, LINE_DATA_API_BASE_URL: 'http://127.0.0.1:4100/' }).LINE_DATA_API_BASE_URL).toBe('http://127.0.0.1:4100')
    expect(parseEnv({ ...local, LINE_DATA_API_BASE_URL: 'HTTPS://API-DATA.LINE.ME:443/' }).LINE_DATA_API_BASE_URL).toBe('https://api-data.line.me')
    for (const source of [local, ...SHARED]) {
      for (const url of ['https://api-data.line.me?x=1', 'https://api-data.line.me#f', 'https://user:pw@api-data.line.me', 'ftp://api-data.line.me']) {
        expect(issuesFor('LINE_DATA_API_BASE_URL', { ...source, LINE_DATA_API_BASE_URL: url }), `${source.APP_ENV} ${url}`).not.toEqual([])
      }
    }
  })

  it('.env.example lists the variable in its LINE block, empty so the default applies', () => {
    const text = readFileSync(path.join(ROOT, '.env.example'), 'utf8')
    const example = parse(text)
    expect(example).toHaveProperty('LINE_DATA_API_BASE_URL', '')
    const block = text.slice(text.indexOf('# --- LINE'), text.indexOf('# --- SSO'))
    expect(block).toMatch(/^LINE_DATA_API_BASE_URL=$/m)
  })
})
