import { createTranslator, NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { boardDocumentViews, type BoardT } from '@/app/(workspace)/board/pending/_present'
import type { BoardRowDto, BoardTaskDto } from '@/server/services/board'
import { RemindButton } from '@/ui/insight/remind-button'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S4-10 · FR-VIS-001 AC2 (spec §11.1, §9.9 "ห้ามการกระทำที่ย้อนไม่ได้โดยไม่ยืนยัน"): a reminder cannot be taken back — the
// holder is notified at once, an Event records it, and nobody may remind the document again for an hour — so the
// button only asks first, in the document's row and not in a modal: whom it reminds about what and what follows, then
// "ยืนยันส่งเตือน (ชื่อ)" apart from "ยังไม่ส่งเตือน". These are the words and the page as it loads; pressing, that the
// first press sends nothing, and the confirmation that sends run in tests/e2e/board.spec.ts at 375 and 1440 px.

// The presenter takes only the list of document kinds from the board's service; the service itself opens the database
// client when it loads, which a screen test has no use for (the rows are the service's DTOs, written out below)
vi.mock('@/server/services/board', () => ({ BOARD_SUBJECTS: ['REQUEST', 'PURCHASE_ORDER', 'VARIANCE', 'DOA_VERSION', 'ORG_AUTHORITY_CHANGE'] }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

const NOW = new Date('2026-10-06T03:00:00.000Z')
const DOCUMENT = 'PR-2569-00018 ไม้แบบหล่อคอนกรีต'
const RIGHTS = { requests: true, purchaseOrders: false, doaVersions: false, orgAuthorityChanges: false }

const task = (over: Partial<BoardTaskDto> = {}): BoardTaskDto => ({
  taskId: '5d1f0c3e-8a4b-4c2d-9e6f-7a8b9c0d1e2f',
  subjectType: 'REQUEST',
  subjectId: '7c2e1d4f-9b8a-4e3d-8c7b-6a5f4e3d2c1b',
  label: DOCUMENT,
  status: 'OPEN',
  assignedAt: '2026-10-02T01:30:00.000Z',
  dueAt: '2026-10-02T09:30:00.000Z',
  ageMinutes: 1080,
  overdue: true,
  poId: null,
  remindAgainAt: null,
  canRemind: true,
  ...over,
})

const row = (name: string, tasks: readonly BoardTaskDto[]): BoardRowDto => ({
  memberId: '0b9e3a52-6f1e-4d7a-9a51-2f3c4d5e6f70',
  name,
  open: 1,
  overdue: 1,
  waitingForRequester: 1,
  oldestMinutes: 1080,
  averageMinutes: 1080,
  tasks,
})

const translator = (locale: 'th' | 'en'): BoardT => createTranslator({ locale, messages: locale === 'th' ? th : en, namespace: 'board' }) as unknown as BoardT
const views = (locale: 'th' | 'en', name: string, tasks: readonly BoardTaskDto[]) => boardDocumentViews(translator(locale), locale, row(name, tasks), 'a-reader-who-is-not-the-holder', RIGHTS, NOW)

describe('[FR-VIS-001/AC2] a reminder asks before it is sent, in words that say whom, about what and what follows', () => {
  it('words the question and the confirmation with the holder and the document, in Thai and in English', () => {
    const [doc, waiting] = views('th', 'วีระ ปฏิบัติการ', [task(), task({ taskId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', status: 'INFO_REQUESTED', canRemind: false })])
    expect(doc?.remind).toEqual({
      label: 'ส่งเตือน วีระ ปฏิบัติการ',
      ariaLabel: `ส่งเตือน วีระ ปฏิบัติการ เรื่อง ${DOCUMENT}`,
      question: `ส่งเตือน วีระ ปฏิบัติการ เรื่อง ${DOCUMENT} ตอนนี้ ระบบจะแจ้ง วีระ ปฏิบัติการ ทันที ส่งแล้วเรียกคืนไม่ได้ และเอกสารนี้จะส่งเตือนได้อีกครั้งหลัง 1 ชั่วโมง`,
      confirmLabel: 'ยืนยันส่งเตือน วีระ ปฏิบัติการ',
      confirmAriaLabel: `ยืนยันส่งเตือน วีระ ปฏิบัติการ เรื่อง ${DOCUMENT}`,
      hint: null,
      againAt: null,
    })
    // the names screen readers hear begin with the words on the buttons (WCAG 2.5.3)
    const words = doc!.remind!
    expect(words.ariaLabel.startsWith(words.label)).toBe(true)
    expect(words.confirmAriaLabel.startsWith(words.confirmLabel)).toBe(true)
    // a document waiting for the requester's answer has nothing to remind the approver of
    expect(waiting?.remind).toBeNull()

    const [english] = views('en', 'Weera Operations', [task()])
    expect(english?.remind).toMatchObject({
      label: 'Remind Weera Operations',
      question: `Remind Weera Operations about ${DOCUMENT} now? Weera Operations is notified at once, a reminder cannot be called back, and this document can be reminded again after 1 hour.`,
      confirmLabel: 'Confirm reminding Weera Operations',
      confirmAriaLabel: `Confirm reminding Weera Operations about ${DOCUMENT}`,
    })
  })

  it('reminded within the hour, the reminder says from when it may be sent again; once the hour has passed it says nothing', () => {
    const [doc] = views('th', 'วีระ ปฏิบัติการ', [task({ remindAgainAt: '2026-10-06T03:30:00.000Z' })])
    expect(doc?.remind?.hint).toMatch(/^ส่งเตือนแล้วภายในชั่วโมงนี้ ส่งได้อีกครั้งหลัง .+ 10:30 น\.$/)
    // the button knows the time too, so that a press within the hour says it at once instead of asking (§9.9 rule 7)
    expect(doc?.remind?.againAt).toBe('2026-10-06T03:30:00.000Z')
    // an hour that has passed says nothing, and the button asks again
    const [later] = views('th', 'วีระ ปฏิบัติการ', [task({ remindAgainAt: '2026-10-06T02:30:00.000Z' })])
    expect(later?.remind?.hint).toBeNull()
    expect(later?.remind?.againAt).toBeNull()
  })

  it('the page loads with the reminder button only: the confirmation and "not yet" appear after a press, and nothing is sent', () => {
    const [doc] = views('th', 'วีระ ปฏิบัติการ', [task()])
    const remind = vi.fn()
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="th" timeZone="Asia/Bangkok" messages={th}>
        <RemindButton taskId={task().taskId} view={doc!.remind!} locale="th" remind={remind} />
      </NextIntlClientProvider>,
    )
    expect(html).toMatch(new RegExp(`<button [^>]*aria-label="ส่งเตือน วีระ ปฏิบัติการ เรื่อง ${DOCUMENT}"[^>]*>ส่งเตือน วีระ ปฏิบัติการ</button>`))
    expect(html.match(/<button /g)).toHaveLength(1)
    expect(html).not.toContain('ยืนยันส่งเตือน')
    expect(html).not.toContain('ยังไม่ส่งเตือน')
    expect(html).not.toContain('role="group"')
    expect(remind).not.toHaveBeenCalled()
  })
})
