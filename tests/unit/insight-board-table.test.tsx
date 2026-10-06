import { createTranslator } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { boardRowViews, type BoardT } from '@/app/(workspace)/board/pending/_present'
import type { BoardRowDto } from '@/server/services/board'
import { BoardTable, type BoardTableLabels } from '@/ui/insight/board-table'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S4-10 · FR-VIS-001 (spec §11.1, §9.9 "ทุกตัวเลขต้องคลิกไปที่รายการได้"): on the board "เอกสารค้างที่ใคร" every figure of a
// person — how many wait for a decision, how many are past their SLA, how many wait for the requester, and the oldest
// and the average wait in business hours — opens that person's documents with the board's filters kept, in the wide
// table and in the phone list alike, and each link's name says what the figure counts, with its unit and whose it is
// (the figure as shown is part of the name). The page itself runs in tests/e2e/board.spec.ts at 375 and 1440 px.

// The presenter takes only the list of document kinds from the board's service; the service itself opens the database
// client when it loads, which a screen test has no use for (the rows are the service's DTOs, written out below)
vi.mock('@/server/services/board', () => ({ BOARD_SUBJECTS: ['REQUEST', 'PURCHASE_ORDER', 'VARIANCE', 'DOA_VERSION', 'ORG_AUTHORITY_CHANGE'] }))

const ID = '0b9e3a52-6f1e-4d7a-9a51-2f3c4d5e6f70'
const QUERY = '?department=5d1f0c3e-8a4b-4c2d-9e6f-7a8b9c0d1e2f&type=REQUEST'
const HREF = `/board/pending/${ID}${QUERY}`
const NAME = 'วีระ ปฏิบัติการ'

const row: BoardRowDto = { memberId: ID, name: NAME, open: 2, overdue: 1, waitingForRequester: 0, oldestMinutes: 1080, averageMinutes: 540, tasks: [] }

const translator = (locale: 'th' | 'en'): BoardT => createTranslator({ locale, messages: locale === 'th' ? th : en, namespace: 'board' }) as unknown as BoardT

const labelsOf = (t: BoardT): BoardTableLabels => ({
  caption: t('table.caption'),
  person: t('table.person'),
  open: t('table.open'),
  overdue: t('table.overdue'),
  waiting: t('table.waiting'),
  oldest: t('table.oldest'),
  average: t('table.average'),
  overdueWord: t('table.overdueWord'),
  waitingWord: t('table.waitingWord'),
})

const decode = (text: string) => text.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#x27;', "'")

interface Anchor {
  readonly href: string
  readonly name: string
  readonly text: string
}

/** Every link of the markup: where it leads, its accessible name (aria-label) and the text it shows */
function anchors(markup: string): Anchor[] {
  return [...markup.matchAll(/<a (?<attrs>[^>]*)>(?<text>[^<]*)<\/a>/g)].map((m) => {
    const attrs = new Map([...(m.groups?.attrs ?? '').matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key = '', value = '']) => [key, decode(value)]))
    return { href: attrs.get('href') ?? '', name: attrs.get('aria-label') ?? '', text: decode(m.groups?.text ?? '') }
  })
}

function board(locale: 'th' | 'en'): string {
  const t = translator(locale)
  return renderToStaticMarkup(<BoardTable rows={boardRowViews(t, [row], QUERY)} labels={labelsOf(t)} />)
}

describe('[FR-VIS-001/AC1] [FR-VIS-001/AC2] every figure on the board opens the person’s documents, the ages in business hours too', () => {
  it('the five figures and the name are links to the person’s list, in the table and in the phone list, named with what they count', () => {
    const markup = board('th')
    const figures = [
      { name: `รอตัดสิน 2 ฉบับที่ ${NAME}: ดูเอกสาร`, text: '2' },
      { name: `เกินกำหนด 1 ฉบับที่ ${NAME}: ดูเอกสาร`, text: '1' },
      { name: `รอผู้ขอตอบ 0 ฉบับที่ ${NAME}: ดูเอกสาร`, text: '0' },
      { name: `ค้างนานสุด 18.0 ชั่วโมงทำการที่ ${NAME}: ดูเอกสาร`, text: '18.0' },
      { name: `เฉลี่ย 9.0 ชั่วโมงทำการที่ ${NAME}: ดูเอกสาร`, text: '9.0' },
    ]
    const expected = [{ name: `ดูเอกสารที่ค้างที่ ${NAME}`, text: NAME }, ...figures]
    // the wide table first, then the same in the phone list
    expect(anchors(markup)).toEqual([...expected, ...expected].map((a) => ({ href: HREF, ...a })))
    // no figure is left as plain text beside the links
    const outsideLinks = markup.replaceAll(/<a [^>]*>[^<]*<\/a>/g, '')
    for (const { text } of figures) expect(outsideLinks).not.toMatch(new RegExp(`>\\s*${text.replace('.', '\\.')}\\s*<`))
  })

  it('in English the ages’ links say the same, with the unit', () => {
    const named = anchors(board('en')).map((a) => a.name)
    expect(named).toContain(`Oldest 18.0 business hours at ${NAME}: see documents`)
    expect(named).toContain(`Average 9.0 business hours at ${NAME}: see documents`)
    for (const a of anchors(board('en'))) expect(a.name, 'the figure as shown is part of the link’s name').toContain(a.text)
  })
})
