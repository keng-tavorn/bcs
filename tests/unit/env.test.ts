import { describe, expect, it } from 'vitest'
import { EnvError, parseEnv } from '@/lib/env'

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

const staging = {
  ...local,
  APP_ENV: 'staging',
  APP_URL: 'https://bcs-staging.example.com',
  SEED_DEV_PASSWORD: 'a-real-random-password',
  INNGEST_DEV: '',
  INNGEST_EVENT_KEY: 'evt',
  INNGEST_SIGNING_KEY: 'signkey-prod-123',
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
