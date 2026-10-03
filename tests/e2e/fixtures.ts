import { createHash } from 'node:crypto'
import { test as base } from '@playwright/test'

// Every test gets its own client address (x-forwarded-for, which the app reads behind Vercel's proxy), so sign-in
// lockouts and rate limits counted per IP (NFR-SEC-05) never carry over from one test to the next. Addresses come from
// 198.18.0.0/15, the range reserved for benchmark tests.
export const test = base.extend<{ clientIp: string }>({
  clientIp: [
    async ({ context }, use, testInfo) => {
      const digest = createHash('sha256').update(`${testInfo.testId}:${testInfo.retry}:${testInfo.repeatEachIndex}`).digest()
      const ip = `198.${18 + (digest[0]! & 1)}.${digest[1]!}.${(digest[2]! % 254) + 1}`
      await context.setExtraHTTPHeaders({ 'x-forwarded-for': ip })
      await use(ip)
    },
    { auto: true },
  ],
})

export { expect } from '@playwright/test'
