import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { auditQuery } from '@/app/(workspace)/audit/_present'
import { AuditPeriod } from '@/ui/insight/audit-period'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// FR-VIS-004 AC1 (spec §9.9 rules 7 and 8): a period of the audit search whose "ถึงวันที่" is before its "ตั้งแต่วันที่"
// holds no event, so it is never searched: the page answers no "ไม่พบบันทึก…" for it, but says at the field "ถึงวันที่",
// with an icon and words, which day comes before which and how to fix it. These are the address's side (checked on the
// server) and the words as the page draws them; that the browser holds such a search before it goes, the focus, and the
// export refused run in tests/e2e/audit.spec.ts at 375 and 1440 px.

// The search's services are read for their list of channels only; the services open the database client when they load
vi.mock('@/server/services/audit', () => ({ AUDIT_CHANNELS: ['WEB', 'LIFF', 'LINE_CHAT', 'PWA', 'EMAIL', 'PORTAL', 'SYSTEM', 'API', 'MCP'] }))

describe('[FR-VIS-004/AC1] a period that ends before it starts is not searched, and the page says how to fix it', () => {
  it('reads a period of the address as reversed only when both days are there and "to" is before "from"', () => {
    expect(auditQuery({ from: '2026-10-06', to: '2026-10-01' })).toMatchObject({ reversed: true, searched: true, form: { from: '2026-10-06', to: '2026-10-01' } })
    // one day, or the same day at both ends, is a period like any other
    expect(auditQuery({ from: '2026-10-06', to: '2026-10-06' }).reversed).toBe(false)
    expect(auditQuery({ from: '2026-10-01', to: '2026-10-06' }).reversed).toBe(false)
    expect(auditQuery({ from: '2026-10-06' }).reversed).toBe(false)
    expect(auditQuery({ to: '2026-10-01' }).reversed).toBe(false)
    expect(auditQuery({}).reversed).toBe(false)
    // a day that is not a day is left out, as before, and leaves nothing to compare
    expect(auditQuery({ from: '2026-13-06', to: '2026-10-01' }).reversed).toBe(false)
  })

  const draw = (locale: 'th' | 'en', props: { from: string; to: string; reversed: boolean }) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} timeZone="Asia/Bangkok" messages={locale === 'th' ? th : en}>
        <form>
          <AuditPeriod fromLabel={locale === 'th' ? 'ตั้งแต่วันที่' : 'From'} toLabel={locale === 'th' ? 'ถึงวันที่' : 'To'} {...props} />
        </form>
      </NextIntlClientProvider>,
    )

  it('says at "ถึงวันที่", with an icon and words, which day is before which and what to choose, in Thai and in English', () => {
    const html = draw('th', { from: '2026-10-06', to: '2026-10-01', reversed: true })
    const error = /<p id="audit-period-error" role="alert" class="[^"]*text-danger[^"]*"><svg[^>]*aria-hidden="true"[^>]*>(?:(?!<\/svg>)[\s\S])*<\/svg><span>([^<]+)<\/span><\/p>/.exec(html)
    expect(error?.[1]).toBe('ยังไม่ได้ค้นหา เพราะ “ถึงวันที่” (1 ต.ค. 2569) อยู่ก่อน “ตั้งแต่วันที่” (6 ต.ค. 2569) เลือก “ถึงวันที่” เป็น 6 ต.ค. 2569 หรือหลังจากนั้น แล้วกดค้นหาบันทึกอีกครั้ง')
    // it sits with the field "ถึงวันที่", after its lists
    expect(html.indexOf('id="audit-period-error"')).toBeGreaterThan(html.indexOf('id="audit-to-year"'))
    // the field's three lists are marked invalid and described by the words, as a field with an error is; "ตั้งแต่วันที่" is not
    for (const part of ['day', 'month', 'year']) {
      const to = new RegExp(`<select id="audit-to-${part}"[^>]*>`).exec(html)?.[0] ?? ''
      expect(to, part).toContain('aria-invalid="true"')
      expect(to, part).toMatch(/aria-describedby="(?:[^"]* )?audit-period-error(?: [^"]*)?"/)
      const from = new RegExp(`<select id="audit-from-${part}"[^>]*>`).exec(html)?.[0] ?? ''
      expect(from, part).toMatch(/^<select id="audit-from-/)
      expect(from, part).not.toContain('aria-invalid')
      expect(from, part).not.toContain('audit-period-error')
    }
    // the days stay as chosen, for the reader to fix the one that is wrong
    expect(html).toMatch(/<input type="hidden" id="audit-from" name="from" value="2026-10-06"\/>/)
    expect(html).toMatch(/<input type="hidden" id="audit-to" name="to" value="2026-10-01"\/>/)
    const english = draw('en', { from: '2026-10-06', to: '2026-10-01', reversed: true })
    expect(english).toContain('Not searched: “To” (1 Oct 2569) is before “From” (6 Oct 2569). Choose a “To” day of 6 Oct 2569 or later, then press Search the trail again.')
  })

  it('says nothing of the kind for a period in order, or for none', () => {
    for (const props of [
      { from: '2026-10-01', to: '2026-10-06', reversed: false },
      { from: '', to: '', reversed: false },
    ]) {
      const html = draw('th', props)
      expect(html).not.toContain('audit-period-error')
      expect(html).not.toContain('role="alert"')
      expect(html).not.toContain('aria-invalid')
    }
  })
})
