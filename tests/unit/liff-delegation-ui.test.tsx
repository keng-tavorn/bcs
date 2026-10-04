import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai/date'
import { formatDay } from '@/ui/liff/delegation/day'
import { LiffDelegationForm } from '@/ui/liff/delegation/delegation-form'
import { LiffRevokeDelegationControl } from '@/ui/liff/delegation/revoke'
import { LiffDelegationStateMark } from '@/ui/liff/delegation/state-mark'
import { LiffFrame } from '@/ui/liff/frame'
import { LiffProvider } from '@/ui/liff/liff-provider'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S5-06 · the pieces of /liff/delegation (§9.4 "ตั้งรักษาการ", FR-DOA-006 AC2 LIFF part): the form with its button in the
// bar at the bottom, the period in words as the days are chosen (the workspace's words, without its time-zone library),
// cancelling only what still runs, and the state as an icon and words. Static markup only; the page runs in the
// LINE-sized browser in tests/e2e/liff-delegation.spec.ts with axe, at 375 px and 1440 px.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, replace: () => undefined, push: () => undefined }) }))

const html = (node: ReactNode, locale: 'th' | 'en' = 'th') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'th' ? th : en} timeZone="Asia/Bangkok">
      <LiffProvider config={{ liffId: null, mock: { lineUserId: 'U00000000000000000000000000000000', cookie: 'bcs-liff-mock-user' }, session: 'liff' }}>{node}</LiffProvider>
    </NextIntlClientProvider>,
  )

const never = () => Promise.reject(new Error('not called in markup'))

describe('[FR-DOA-006/AC2] the period of a LIFF delegation reads in the workspace’s words', () => {
  const days = ['2026-10-04', '2026-01-01', '2026-09-30', '2026-12-31', '2027-02-28', '2028-02-29', '2026-05-15', '2026-07-09']
  it.each(days)('%s in Thai and English, with the Buddhist-era year', (day) => {
    expect(formatDay(day, 'th')).toBe(formatThaiDate(day))
    expect(formatDay(day, 'en')).toBe(formatEnglishBeDate(day))
  })

  it('says nothing for a day that does not exist or is not a day', () => {
    expect(formatDay('2026-02-30', 'th')).toBeNull()
    expect(formatDay('2026-13-01', 'en')).toBeNull()
    expect(formatDay('4/10/2026', 'th')).toBeNull()
    expect(formatDay('', 'th')).toBeNull()
  })
})

describe('[FR-DOA-006/AC2] the LIFF delegation form', () => {
  const form = (locale: 'th' | 'en' = 'th') =>
    html(
      <LiffFrame title="รักษาการ">
        <LiffDelegationForm
          candidates={[{ id: 'm1', name: 'สมหญิง รักงาน', label: 'สมหญิง รักงาน · ฝ่ายก่อสร้าง' }]}
          documentTypes={[{ value: 'PURCHASE_REQUEST', label: 'ใบขอซื้อ (PR)' }]}
          today="2026-10-04"
          givenKey=""
          create={never}
          before={<p>คำนำ</p>}
          after={<p>รายการ</p>}
        />
      </LiffFrame>,
      locale,
    )

  it('asks who, from which day to which day, what it covers, a cap and why; the period reads in words from today', () => {
    const page = form()
    expect(page).toMatch(/<label for="([^"]+)-delegate"[^>]*>ผู้รักษาการ<\/label><select id="\1-delegate" name="delegateMemberId"/)
    expect(page).toContain('<option value="m1">สมหญิง รักงาน · ฝ่ายก่อสร้าง</option>')
    expect(page).toMatch(/type="date"[^>]*min="2026-10-04"/)
    expect(page).toContain('รักษาการ 4 ต.ค. 2569 ถึง 4 ต.ค. 2569')
    expect(page).toContain('ทุกประเภทงานอนุมัติของตำแหน่งคุณ')
    expect(page).toContain('วงเงินสูงสุดที่มอบ (บาท)')
    expect(page).toContain('เหตุผล (เช่น ลาพักร้อน)')
    // 44 px fields and 16 px text: no smaller text on a phone
    expect(page).toMatch(/<select[^>]*class="h-11 [^"]*text-base/)
    expect(page).not.toContain('text-sm')
  })

  it('puts its one button in the bar at the bottom, after the content, submitting the form it belongs to', () => {
    const page = form()
    const formId = /<form id="([^"]+)"/.exec(page)?.[1]
    expect(formId).toBeTruthy()
    expect(page).toMatch(new RegExp(`</form>.*<section aria-label="บันทึกการรักษาการ" class="sticky bottom-0[^"]*">.*<button type="submit"[^>]*form="${formId}"[^>]*>ตั้งผู้รักษาการ</button>`))
    expect(page.indexOf('คำนำ')).toBeLessThan(page.indexOf('<form'))
    expect(page.indexOf('รายการ')).toBeGreaterThan(page.indexOf('</form>'))
  })

  it('says it in English too', () => {
    const page = form('en')
    expect(page).toContain('4 Oct 2569')
    expect(page).toContain('Save the delegation')
  })
})

describe('[FR-DOA-006/AC2] cancelling a delegation in LIFF', () => {
  it('offers cancelling only for a delegation that still runs or is still to come', () => {
    expect(html(<LiffRevokeDelegationControl delegationId="d1" delegateName="สมหญิง รักงาน" revocable={false} revoke={never} />)).toBe('')
    const page = html(<LiffRevokeDelegationControl delegationId="d1" delegateName="สมหญิง รักงาน" revocable revoke={never} />)
    expect(page).toMatch(/<button type="button" class="[^"]*h-11[^"]*">ยกเลิกการรักษาการของ สมหญิง รักงาน<\/button>/)
  })

  it.each([
    ['ACTIVE', 'กำลังรักษาการ', 'text-primary'],
    ['SCHEDULED', 'รอเริ่ม', 'text-warn'],
    ['ENDED', 'สิ้นสุดแล้ว', 'text-ink-muted'],
    ['REVOKED', 'ยกเลิกแล้ว', 'text-ink-muted'],
  ] as const)('shows %s as an icon and words, never colour alone', (state, label, tone) => {
    const page = html(<LiffDelegationStateMark state={state} label={label} />)
    expect(page).toMatch(new RegExp(`<svg[^>]*class="[^"]*${tone}[^"]*" aria-hidden="true"[^>]*>.*</svg><span>${label}</span>`))
  })
})
