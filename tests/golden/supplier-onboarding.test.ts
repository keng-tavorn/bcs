import { describe, expect, it } from 'vitest'
import type { BusinessCalendar, Weekday } from '@/core/sla'
import {
  applicationSla,
  findSupplierDuplicates,
  g7BusinessDays,
  g7Median,
  normalizeSupplierName,
  verifyOtp,
  type ExistingSupplier,
  type SupplierCandidate,
} from '@/core/supplier-onboarding'
import { loadYaml } from './doa-fixtures'

// tests/golden/supplier-onboarding.yaml (spec §7.22 · S7-03 · BR-SUP-09 BR-SUP-12 BR-SUP-13 BR-PORTAL-02): GC-SUP-09 to
// GC-SUP-33 and GC-SUP-48 to GC-SUP-51. Every result is compared whole (BR-SUP-09: a block carries no warnings). The
// OTP cases pass the code and the attempt as the hashes the server would store and compute (verifyOtp compares hashes).

interface OnboardingCase {
  id: string
  title?: string
  fn: 'normalizeSupplierName' | 'findSupplierDuplicates' | 'verifyOtp' | 'applicationSla' | 'g7BusinessDays' | 'g7Median'
  input: unknown
  expect: unknown
}
interface Suite {
  calendar: { timezone: string; workdays: Weekday[]; start: string; end: string; holidays: string[] }
  settings: { applicationReminderBusinessDays: number; applicationEscalateBusinessDays: number; applicationExpireDays: number; otpMinutes: number; otpMaxAttempts: number; otpLockMinutes: number }
  existing: Array<{ ref: string; taxId: string; branchCode: string; nameTh: string; email: string }>
  cases: OnboardingCase[]
}

const suite = loadYaml<Suite>('supplier-onboarding.yaml')
const calendar: BusinessCalendar = suite.calendar
const existing: ExistingSupplier[] = suite.existing.map((e) => ({ ref: e.ref, taxId: e.taxId, branchCode: e.branchCode, nameTh: e.nameTh, emails: [e.email] }))
const d = (s: string) => new Date(s)
const iso = (t: Date) => t.toISOString().replace('.000Z', 'Z')

function run(c: OnboardingCase): unknown {
  const i = c.input as Record<string, unknown>
  switch (c.fn) {
    case 'normalizeSupplierName':
      return normalizeSupplierName(c.input as string)
    case 'findSupplierDuplicates': {
      const candidate: SupplierCandidate = { taxId: (i.taxId as string | null) ?? null, branchCode: i.branchCode as string, nameTh: i.nameTh as string, email: i.email as string }
      const r = findSupplierDuplicates(candidate, existing)
      if (r.ok) return { warnings: r.warnings.map((w) => ({ code: w.code, matches: [...w.matches] })) }
      return r.code === 'DUPLICATE_SUPPLIER' ? { error: r.code, reason: r.reason, matches: [...r.matches] } : { error: r.code, reason: r.reason }
    }
    case 'verifyOtp': {
      const r = verifyOtp(
        { createdAt: d(i.createdAt as string), codeHash: i.code as string, attempts: i.attempts as number, lockedUntil: i.lockedUntil ? d(i.lockedUntil as string) : null },
        i.attempt as string,
        d(i.now as string),
        suite.settings,
      )
      if (r.ok) return { ok: true }
      if ('lockedUntil' in r) return { error: r.code, attempts: r.attempts, lockedUntil: iso(r.lockedUntil) }
      if ('remaining' in r) return { error: r.code, attempts: r.attempts, remaining: r.remaining }
      return { error: r.code }
    }
    case 'applicationSla': {
      const r = applicationSla({ invitedAt: d(i.invitedAt as string), lastActivityAt: d(i.lastActivityAt as string) }, suite.settings, calendar)
      return { remindAt: iso(r.remindAt), escalateAt: iso(r.escalateAt), expiresAt: iso(r.expiresAt) }
    }
    case 'g7BusinessDays':
      return g7BusinessDays((c.input as Array<{ invitedAt: string; decidedAt: string }>).map((a) => ({ invitedAt: d(a.invitedAt), decidedAt: d(a.decidedAt) })), calendar)
    case 'g7Median':
      return g7Median(c.input as string[])
  }
}

describe('[BR-SUP-09] [BR-SUP-12] [BR-SUP-13] [BR-PORTAL-02] golden supplier-onboarding.yaml', () => {
  it('has the 29 cases of S7-03', () => {
    const ids = suite.cases.map((c) => c.id)
    expect(ids).toHaveLength(29)
    expect(ids[0]).toBe('GC-SUP-09')
    expect(ids.at(-1)).toBe('GC-SUP-51')
  })
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? c.fn}`, () => expect(run(c)).toEqual(c.expect))
  }
})
