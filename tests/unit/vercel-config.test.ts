import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Staging deploys with `vercel deploy --prod` from a work machine (ADR-032). Vercel CLI reads .vercelignore but not
// .gitignore and skips only .env.local by its own defaults, so the upload must be fenced here.

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const rules = (file: string) =>
  readFileSync(path.join(ROOT, file), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))

describe('Vercel staging deploy config (ADR-032)', () => {
  it('[EG-3] .vercelignore repeats every .gitignore rule, so a deploy uploads what git holds and never .env', () => {
    const vercel = new Set(rules('.vercelignore'))
    expect(rules('.gitignore').filter((rule) => !vercel.has(rule))).toEqual([])
    for (const rule of ['.env', '.env.*', '.e2e-runs/', 'scratch/', 'src/server/db/generated/']) expect(vercel.has(rule), rule).toBe(true)
  })

  it('[EG-3] vercel.json builds Next.js in Singapore and migrates before the build', () => {
    const config = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')) as Record<string, unknown>
    expect(config.framework).toBe('nextjs')
    expect(config.regions).toEqual(['sin1'])
    expect(config.buildCommand).toBe('pnpm db:migrate && pnpm build')
  })
})
