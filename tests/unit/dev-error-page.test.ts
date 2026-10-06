import { beforeEach, describe, expect, it, vi } from 'vitest'

// §14.2 · §9.9: /dev/error (src/app/(auth)/dev/error/page.tsx) throws on purpose so that the error page of the app can
// be checked in Thai and English (tests/e2e/error-page.spec.ts runs with APP_ENV=local). It is a signed-out route, so the
// environment is its only guard: on preview, staging and production it is a 404 (notFound()) and its error is never
// thrown; only APP_ENV=local throws it.

const env = vi.hoisted(() => ({ appEnv: 'local' }))
vi.mock('@/lib/env', () => ({ getEnv: () => ({ APP_ENV: env.appEnv }) }))
const { default: ErrorOnPurposePage } = await import('@/app/(auth)/dev/error/page')

/** What rendering the page throws (it never returns) */
function thrownBy(render: () => unknown): Error & { digest?: string } {
  try {
    render()
  } catch (error) {
    return error as Error & { digest?: string }
  }
  throw new Error('the page rendered without throwing')
}

const NOT_FOUND_DIGEST = 'NEXT_HTTP_ERROR_FALLBACK;404'

describe('[§14.2] /dev/error fails on purpose on a developer machine only', () => {
  beforeEach(() => {
    env.appEnv = 'local'
  })

  it.each(['preview', 'staging', 'production'])('APP_ENV=%s: a 404, and the error on purpose is never thrown', (appEnv) => {
    env.appEnv = appEnv
    const thrown = thrownBy(() => ErrorOnPurposePage())
    expect(thrown.digest).toBe(NOT_FOUND_DIGEST)
    expect(thrown.message).not.toMatch(/on purpose/)
  })

  it('APP_ENV=local: the error on purpose, which the error page of the app shows', () => {
    const thrown = thrownBy(() => ErrorOnPurposePage())
    expect(thrown.digest).toBeUndefined()
    expect(thrown.message).toMatch(/on purpose/)
  })
})
