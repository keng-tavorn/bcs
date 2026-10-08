import { beforeEach, describe, expect, it, vi } from 'vitest'

// §9.10 · S16-02: /dev/ui (src/app/(workspace)/dev/ui/page.tsx), the component sheet of the workspace, exists on developer
// machines only: on preview, staging and production it is a 404 (notFound()) before it reads anything.

const env = vi.hoisted(() => ({ appEnv: 'local' }))
vi.mock('@/lib/env', () => ({ getEnv: () => ({ APP_ENV: env.appEnv }) }))
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }))
const { default: UiShowcasePage } = await import('@/app/(workspace)/dev/ui/page')

const NOT_FOUND_DIGEST = 'NEXT_HTTP_ERROR_FALLBACK;404'

describe('[§9.10] /dev/ui shows the component sheet on a developer machine only', () => {
  beforeEach(() => {
    env.appEnv = 'local'
  })

  it.each(['preview', 'staging', 'production'])('APP_ENV=%s: a 404', async (appEnv) => {
    env.appEnv = appEnv
    const thrown = await UiShowcasePage().then(
      () => null,
      (error: unknown) => error as Error & { digest?: string },
    )
    expect(thrown?.digest).toBe(NOT_FOUND_DIGEST)
  })

  it('APP_ENV=local: the page, with its title and the sheet', async () => {
    const page = await UiShowcasePage()
    expect(JSON.stringify(page, (_key, value: unknown) => (typeof value === 'function' ? value.name : value))).toMatch(/"title".*UiShowcase/)
  })
})
