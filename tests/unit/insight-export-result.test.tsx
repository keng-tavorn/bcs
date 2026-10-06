import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ExportOutcome } from '@/ui/insight/outcome'
import { ExportResult } from '@/ui/insight/export-panel'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// FR-VIS-004 AC2 (the audit's export, and the KPI and report exports that share the panel) · §9.9 rule 7: once the server
// made the file, the page asks for its short-lived address and the download starts there. When that address does not
// come (the session ended, a refusal, no answer), the success says only how many rows were exported — never "the download
// has started" beside the notice that it did not open. Static markup; the export itself runs in tests/e2e/audit.spec.ts
// and demo scene 9.

const DONE: ExportOutcome = { ok: true, exportJobId: 'job-1', fileId: 'file-1', rowCount: 7, checksum: 'a'.repeat(64) }

const html = (openFailed: boolean, locale: 'th' | 'en' = 'th') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : th} timeZone="Asia/Bangkok">
      <ExportResult outcome={DONE} openFailed={openFailed} onAgain={() => undefined} />
    </NextIntlClientProvider>,
  )

const words = (markup: string) => markup.replace(/<[^>]+>/g, '')

/** The words of the notice of a role (src/ui/form/notice.tsx: its icon, then its words in a div of their own) */
function notice(markup: string, role: 'status' | 'alert'): string {
  const start = markup.indexOf(`<div role="${role}"`)
  expect(start, `a notice of role ${role}`).toBeGreaterThanOrEqual(0)
  return words(markup.slice(start, markup.indexOf('</div></div>', start)))
}

describe('[FR-VIS-004/AC2] the export’s answer says the download started only when it did', () => {
  it('opened: the rows, and that the download started; nothing else', () => {
    const page = html(false)
    expect(notice(page, 'status')).toContain('ส่งออกแล้ว 7 แถว และเริ่มดาวน์โหลดไฟล์ให้แล้ว')
    expect(page).not.toContain('role="alert"')
  })

  it('not opened: the rows only, beside the notice that the download did not open and how to try again', () => {
    const page = html(true)
    const success = notice(page, 'status')
    expect(success).toContain('ส่งออกแล้ว 7 แถว')
    expect(success).not.toContain('เริ่มดาวน์โหลด')
    expect(words(page)).not.toContain('เริ่มดาวน์โหลด')
    expect(notice(page, 'alert')).toContain(th.reports.export.openFailed)
    // the way to try again is still there, in the words the danger notice names
    expect(page).toContain(`>${th.reports.export.again}</button>`)
  })

  it('in English as well', () => {
    expect(words(html(false, 'en'))).toContain('Exported 7 rows; the download has started.')
    const page = words(html(true, 'en'))
    expect(page).toContain('Exported 7 rows.')
    expect(page).not.toContain('the download has started')
    expect(page).toContain(en.reports.export.openFailed)
  })
})
