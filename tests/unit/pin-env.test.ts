import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'dotenv'
import { describe, expect, it } from 'vitest'
import { EnvError, parseEnv } from '@/lib/env'

// SEED_DEV_PIN (S5-05, docs/sub-specs/S5.md): the transaction PIN the demo seed gives every approver of the demo
// organization. Like the other seed values it exists only where demo users exist (local and staging), and it is a
// six-digit PIN (FR-AUTH-005 AC1; the seed also refuses an easy one, tests/integration/pin.test.ts). A message never
// repeats the value.

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const KEY = `base64:${Buffer.alloc(32, 7).toString('base64')}`
const NEON = 'ep-calm-sun-a1b2c3.ap-southeast-1.aws.neon.tech'
const PIN = '739164'

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

function issues(source: Record<string, string>): string[] {
  try {
    parseEnv(source)
    return []
  } catch (error) {
    if (error instanceof EnvError) return error.issues
    throw error
  }
}

describe('[FR-AUTH-005/AC1] SEED_DEV_PIN is a six-digit PIN for the demo users of local and staging only', () => {
  it('is read in local and staging, and empty means no PIN', () => {
    expect(parseEnv({ ...local, SEED_DEV_PIN: PIN }).SEED_DEV_PIN).toBe(PIN)
    expect(parseEnv({ ...shared('staging'), SEED_DEV_PIN: PIN }).SEED_DEV_PIN).toBe(PIN)
    expect(parseEnv({ ...local, SEED_DEV_PIN: '' }).SEED_DEV_PIN).toBeUndefined()
    expect(parseEnv(local).SEED_DEV_PIN).toBeUndefined()
  })

  it('is refused in production and preview, where no demo user exists, without repeating it', () => {
    expect(issues(shared('staging'))).toEqual([])
    for (const APP_ENV of ['production', 'preview']) {
      expect(issues(shared(APP_ENV)), `${APP_ENV} without it`).toEqual([])
      const found = issues({ ...shared(APP_ENV), SEED_DEV_PIN: PIN })
      expect(found, APP_ENV).toEqual([expect.stringMatching(/^SEED_DEV_PIN: /)])
      expect(found.join('\n')).not.toContain(PIN)
    }
  })

  it('must be six ASCII digits, locally too, and the message never repeats the value', () => {
    for (const value of ['73916', '7391640', 'abcdef', '๗๓๙๑๖๔', '739-64', '73 916']) {
      const found = issues({ ...local, SEED_DEV_PIN: value })
      expect(found, value).toEqual([expect.stringMatching(/^SEED_DEV_PIN: /)])
      expect(found.join('\n')).not.toContain(value)
    }
  })

  it('.env.example leaves it empty, so no published PIN can reach a shared environment', () => {
    const example = parse(readFileSync(path.join(ROOT, '.env.example'), 'utf8'))
    expect(Object.keys(example)).toContain('SEED_DEV_PIN')
    expect(example.SEED_DEV_PIN).toBe('')
  })
})
