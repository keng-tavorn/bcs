import { cardBadge } from '@/core/pricing'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  ACTION_LABEL_MAX_LENGTH,
  approvalCard,
  approvePostbackData,
  approvesInChat,
  clip,
  clipLines,
  decisionConfirmationCard,
  postbackRefusalMessage,
  textNotice,
  type ApprovalCardData,
  type FlexMessage,
  type OutgoingLineMessage,
} from '@/channels/line/flex'
import { liffPathFor, liffTaskPath } from '@/channels/line/links'
import {
  jsonByteLength,
  LINE_ALT_TEXT_MAX_LENGTH,
  LINE_FLEX_BUBBLE_MAX_BYTES,
  LINE_MESSAGES_PER_REQUEST_MAX,
  LINE_POSTBACK_DATA_MAX_LENGTH,
  LINE_POSTBACK_DISPLAY_TEXT_MAX_LENGTH,
  lineMessageProblems,
} from '@/integrations/line'

// S5-05 · the LINE cards of §9.3 built by src/channels/line/flex: the approval card shows the summary only (FR-LINE-002
// AC1, BR-LINE-06, BR-NOTI-01), approves in the chat only below stepUpThreshold with the reader's token (AC2, BR-TOK-02,
// BR-TOK-05), answers an approval with the DOA reference (AC2) and a tap that decided nothing with what happened (AC3);
// every card and text fits LINE's limits of src/integrations/line/limits.ts (§4.7 rule 5, BR-LINE-09).

const TOKEN = '01928c6e-7f3a-7b2c-9d4e-5f6a7b8c9d0e'
const TASK = '01928c6e-7f3a-7b2c-9d4e-000000000001'
const LIFF = 'https://liff.line.me/1650000003-AbCdEfGh'

const base: ApprovalCardData = {
  locale: 'th',
  subjectType: 'REQUEST',
  typeName: 'ซื้อของ',
  label: 'PR-2569-00012',
  requester: { name: 'สมชาย ใจดี', department: 'ฝ่ายก่อสร้าง' },
  amountSatang: 1_284_000n,
  amountBasis: 'GROSS',
  budget: 'RESERVED',
  dueAt: new Date('2026-10-07T10:30:00Z'),
  overdue: false,
  doa: { code: 'DOA-DEMO', versionNo: 1, ruleCode: 'PR-02' },
  acting: false,
  escalated: false,
  stepUp: false,
  tokenId: TOKEN,
  links: { approve: `${LIFF}/tasks/${TASK}?action=approve`, decline: `${LIFF}/tasks/${TASK}?action=reject`, details: `${LIFF}/tasks/${TASK}` },
}

/** Every text of a message, in order: the texts of a Flex card, or the text of a text message */
function textsOf(message: OutgoingLineMessage): string[] {
  if (message.type === 'text') return [message.text]
  const out: string[] = []
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') {
      const node = value as Record<string, unknown>
      if (node.type === 'text' && typeof node.text === 'string') out.push(node.text)
      Object.values(node).forEach(walk)
    }
  }
  walk(message.contents)
  return out
}

/** Every action of the card's buttons */
function actionsOf(message: FlexMessage): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') {
      const node = value as Record<string, unknown>
      if (node.type === 'button') out.push(node.action as Record<string, unknown>)
      Object.values(node).forEach(walk)
    }
  }
  walk(message.contents)
  return out
}

/** Valid UTF-16: no surrogate without its pair (a cut inside an emoji would leave one) */
const wellFormed = (text: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)

/** What LINE checks of one push or reply (src/integrations/line/limits.ts) plus the bubble's size */
function expectWithinLineLimits(message: OutgoingLineMessage) {
  expect(lineMessageProblems([message])).toEqual([])
  if (message.type === 'flex') {
    expect(jsonByteLength(message.contents)).toBeLessThanOrEqual(LINE_FLEX_BUBBLE_MAX_BYTES)
    expect(message.altText.length).toBeGreaterThan(0)
    expect(message.altText.length).toBeLessThanOrEqual(LINE_ALT_TEXT_MAX_LENGTH)
    for (const action of actionsOf(message)) expect((action.label as string).length).toBeLessThanOrEqual(ACTION_LABEL_MAX_LENGTH)
  }
}

describe('[FR-LINE-002/AC1] the approval card shows only the summary of §9.3 (BR-LINE-06, BR-NOTI-01)', () => {
  it('number, type, requester and department, amount on the DOA basis, budget status, due time and the DOA version and rule', () => {
    const card = approvalCard(base)
    expect(textsOf(card)).toEqual([
      'โปรดพิจารณาอนุมัติ',
      'เลขที่',
      'PR-2569-00012',
      'ประเภท',
      'ซื้อของ',
      'ผู้ขอ',
      'สมชาย ใจดี · ฝ่ายก่อสร้าง',
      'ยอดตามฐาน DOA',
      '12,840.00 บาท (รวม VAT)',
      'งบ',
      'จองแล้ว',
      'กำหนด',
      '7 ต.ค. 2569 17:30 น.',
      'DOA',
      'DOA-DEMO ฉบับ 1 ข้อ PR-02',
    ])
    expect(card.altText).toBe('โปรดพิจารณา: ซื้อของ PR-2569-00012')
  })

  it('says in words that a delegate holds the task or that it was escalated (not by colour alone)', () => {
    const texts = textsOf(approvalCard({ ...base, acting: true, escalated: true, overdue: true }))
    expect(texts).toContain('รักษาการแทน')
    expect(texts).toContain('ส่งต่อเพราะเลยกำหนด')
    expect(texts).toContain('7 ต.ค. 2569 17:30 น. · เลยกำหนดแล้ว')
    expect(textsOf(approvalCard(base))).not.toContain('รักษาการแทน')
  })

  it('in English for an English organization, with the Buddhist-era year (BR-NOTI-03, FR-PLT-002 AC3)', () => {
    const card = approvalCard({ ...base, locale: 'en', typeName: 'Buy goods', amountBasis: 'NET' })
    expect(textsOf(card)).toEqual(expect.arrayContaining(['Waiting for your approval', 'Requested by', '12,840.00 baht (before VAT)', 'Reserved', '7 Oct 2569 17:30', 'DOA-DEMO version 1 rule PR-02']))
    expect(actionsOf(card).map((a) => a.label)).toEqual(['Approve', 'Return / Reject', 'View details'])
  })

  it('leaves out what a document does not have: no requester, amount or budget on a policy task', () => {
    const texts = textsOf(approvalCard({ ...base, subjectType: 'DOA_VERSION', typeName: null, label: 'DOA-DEMO ฉบับ 2', requester: null, amountSatang: null, amountBasis: null, budget: null, stepUp: true }))
    expect(texts).toEqual(expect.arrayContaining(['ประเภท', 'DOA ฉบับใหม่', 'DOA-DEMO ฉบับ 2']))
    for (const absent of ['ผู้ขอ', 'ยอดตามฐาน DOA', 'งบ']) expect(texts).not.toContain(absent)
  })
})

describe('[FR-LINE-002/AC2] the approve button decides in the chat only below stepUpThreshold, with the reader\'s token (BR-TOK-02, BR-TOK-05)', () => {
  it('is a postback of exactly v=1&a=approve&k=<tokenId>, shown in the chat as "อนุมัติ PR-2569-00012"', () => {
    const [approve, decline, details] = actionsOf(approvalCard(base))
    expect(approve).toEqual({ type: 'postback', label: 'อนุมัติ', data: `v=1&a=approve&k=${TOKEN}`, displayText: 'อนุมัติ PR-2569-00012' })
    expect(Object.fromEntries(new URLSearchParams(approve!.data as string))).toEqual({ v: '1', a: 'approve', k: TOKEN })
    expect(approvePostbackData(TOKEN)).toBe(approve!.data)
    // Return or reject needs a reason, typed in LIFF; the details open LIFF too
    expect(decline).toEqual({ type: 'uri', label: 'ตีกลับ / ไม่อนุมัติ', uri: base.links.decline })
    expect(details).toEqual({ type: 'uri', label: 'ดูรายละเอียด', uri: base.links.details })
  })

  it('at or above the threshold, and for every policy task, opens LIFF to approve with the PIN: no postback anywhere on the card', () => {
    const card = approvalCard({ ...base, stepUp: true })
    expect(actionsOf(card).filter((a) => a.type === 'postback')).toEqual([])
    expect(actionsOf(card)[0]).toEqual({ type: 'uri', label: 'อนุมัติ (ยืนยัน PIN)', uri: base.links.approve })
    expect(textsOf(card)).toContain('รายการนี้ต้องยืนยันด้วย PIN')
    expect(approvesInChat({ stepUp: true, tokenId: TOKEN })).toBe(false)
  })

  it('without a live LINE token, or with something that is not a token id, the approve button opens LIFF instead', () => {
    for (const tokenId of [null, 'not-a-token', `${TOKEN}&a=reject`]) {
      const [approve] = actionsOf(approvalCard({ ...base, tokenId }))
      expect(approve).toEqual({ type: 'uri', label: 'อนุมัติ', uri: base.links.approve })
    }
  })

  it('keeps approve and the other choices apart: one filled button, the others not (§9.9)', () => {
    const footer = approvalCard(base).contents.footer!
    expect(footer.spacing).toBe('md')
    expect(footer.contents.map((b) => (b.type === 'button' ? b.style : null))).toEqual(['primary', 'secondary', 'link'])
  })

  it('answers an approval with the DOA reference it was made under and what comes next', () => {
    const card = decisionConfirmationCard({
      locale: 'th',
      subjectType: 'REQUEST',
      typeName: 'ซื้อของ',
      label: 'PR-2569-00012',
      doa: { code: 'DOA-DEMO', versionNo: 1, ruleCode: 'PR-02' },
      decidedAt: new Date('2026-10-06T02:00:00Z'),
      stage: 'DONE',
      detailsUrl: `${LIFF}/requests/${TASK}`,
    })
    expect(textsOf(card)).toEqual(['อนุมัติแล้ว', 'ซื้อของ PR-2569-00012', 'อนุมัติภายใต้ DOA-DEMO ฉบับ 1 ข้อ PR-02', 'เมื่อ 6 ต.ค. 2569 09:00 น.', 'อนุมัติครบทุกขั้นแล้ว'])
    expect(card.altText).toBe('อนุมัติแล้ว: ซื้อของ PR-2569-00012')
    expect(actionsOf(card)).toEqual([{ type: 'uri', label: 'ดูรายละเอียด', uri: `${LIFF}/requests/${TASK}` }])
    const next = decisionConfirmationCard({ locale: 'en', subjectType: 'REQUEST', typeName: null, label: 'PR-2569-00013', doa: { code: 'DOA-DEMO', versionNo: 1, ruleCode: 'PR-01' }, decidedAt: new Date('2026-10-06T02:00:00Z'), stage: 'NEXT_STEP', detailsUrl: LIFF })
    expect(textsOf(next)).toEqual(['Approved', 'Purchase request PR-2569-00013', 'Approved under DOA-DEMO version 1 rule PR-01', 'On 6 Oct 2569 09:00', 'It has gone on to the next approver'])
  })
})

describe('[FR-LINE-002/AC3] a tap that decided nothing is answered with what happened (§9.3, §14.2)', () => {
  it('TOKEN_USED says who decided and when: "รายการนี้ดำเนินการแล้วโดย … เมื่อ …"', () => {
    const at = new Date('2026-10-06T02:00:00Z')
    expect(postbackRefusalMessage({ kind: 'TOKEN_USED', name: 'ผู้ใช้ dm_con', time: at }, 'th', `${LIFF}/tasks/${TASK}`)).toEqual({
      type: 'text',
      text: `รายการนี้ดำเนินการแล้วโดย ผู้ใช้ dm_con เมื่อ 6 ต.ค. 2569 09:00 น.\n${LIFF}/tasks/${TASK}`,
    })
    expect(postbackRefusalMessage({ kind: 'TOKEN_USED', name: 'Somchai', time: at }, 'en', null).text).toBe('This was already done by Somchai on 6 Oct 2569 09:00.')
    expect(postbackRefusalMessage({ kind: 'TOKEN_USED', name: null, time: null }, 'th', null).text).toBe('รายการนี้ดำเนินการแล้ว')
  })

  it('an expired button, someone else\'s button and one that needs the PIN each say so, in Thai and English', () => {
    expect(postbackRefusalMessage({ kind: 'TOKEN_EXPIRED' }, 'th', null).text).toBe('ปุ่มนี้หมดอายุแล้ว โปรดเปิดรายการเพื่อพิจารณา')
    expect(postbackRefusalMessage({ kind: 'FORBIDDEN' }, 'th', null).text).toBe('ปุ่มนี้ใช้ได้เฉพาะผู้ที่ได้รับงาน จากบัญชี LINE ที่ผูกไว้')
    expect(postbackRefusalMessage({ kind: 'STEP_UP_REQUIRED' }, 'th', `${LIFF}/tasks/${TASK}?action=approve`).text).toBe(`รายการนี้ต้องยืนยันด้วย PIN โปรดเปิดรายการเพื่อยืนยัน\n${LIFF}/tasks/${TASK}?action=approve`)
    for (const kind of ['TOKEN_EXPIRED', 'TOKEN_INVALID', 'FORBIDDEN', 'STEP_UP_REQUIRED', 'SOD_VIOLATION', 'NOT_OPEN', 'NOT_DECIDED'] as const) {
      const th = postbackRefusalMessage({ kind }, 'th', null).text
      const en = postbackRefusalMessage({ kind }, 'en', null).text
      expect(th).toMatch(/[฀-๿]/)
      expect(en).not.toMatch(/[฀-๿]/)
    }
  })
})

describe('[FR-LINE-002/AC1] every card and answer fits LINE\'s limits, whatever the data (§4.7 rule 5, BR-LINE-09)', () => {
  it('the cards of the demo fit, with room to spare', () => {
    for (const message of [approvalCard(base), approvalCard({ ...base, stepUp: true, acting: true, escalated: true, overdue: true }), approvalCard({ ...base, locale: 'en' })]) {
      expectWithinLineLimits(message)
      expect(jsonByteLength((message as FlexMessage).contents)).toBeLessThan(LINE_FLEX_BUBBLE_MAX_BYTES / 4)
    }
    expect(approvePostbackData(TOKEN).length).toBeLessThanOrEqual(LINE_POSTBACK_DATA_MAX_LENGTH)
    expect(LINE_MESSAGES_PER_REQUEST_MAX).toBeGreaterThanOrEqual(1)
  })

  it('long titles and names in any script are cut at a character, never over a limit and never inside a Thai cluster or an emoji', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 600 }), fc.string({ unit: 'grapheme', maxLength: 300 }), fc.boolean(), (label, name, stepUp) => {
        const card = approvalCard({ ...base, label: `PR ${label}`, typeName: name, requester: { name, department: name }, stepUp })
        expectWithinLineLimits(card)
        const approve = actionsOf(card)[0]!
        if (approve.type === 'postback') expect((approve.displayText as string).length).toBeLessThanOrEqual(LINE_POSTBACK_DISPLAY_TEXT_MAX_LENGTH)
        // No lone surrogate: every text is valid UTF-16
        for (const text of [card.altText, ...textsOf(card)]) expect(wellFormed(text)).toBe(true)
        expectWithinLineLimits(decisionConfirmationCard({ locale: 'th', subjectType: 'REQUEST', typeName: name, label, doa: base.doa, decidedAt: new Date('2026-10-06T02:00:00Z'), stage: 'DONE', detailsUrl: LIFF }))
        expectWithinLineLimits(postbackRefusalMessage({ kind: 'TOKEN_USED', name, time: new Date('2026-10-06T02:00:00Z') }, 'th', LIFF))
      }),
      { numRuns: 200 },
    )
  })

  it('clip cuts at a grapheme and marks the cut; clipLines keeps line breaks within the limit', () => {
    expect(clip('ผู้อำนวยการฝ่าย', 6)).toBe('ผู้อำ…')
    expect(clip('สวัสดี\nครับ', 50)).toBe('สวัสดี ครับ')
    expect(clip('👨‍👩‍👧‍👦👨‍👩‍👧‍👦', 12)).toBe('👨‍👩‍👧‍👦…')
    expect(clipLines('บรรทัดหนึ่ง\nบรรทัดสอง\nบรรทัดสาม', 21)).toBe('บรรทัดหนึ่ง\nบรรทัดสอง')
    expect(clipLines('บรรทัดหนึ่ง\nบรรทัดสองที่ยาวมาก', 16)).toBe('บรรทัดหนึ่ง\nบรร…')
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 400 }), fc.integer({ min: 0, max: 200 }), (text, max) => {
        expect(clip(text, max).length).toBeLessThanOrEqual(max)
        expect(clipLines(text, max).length).toBeLessThanOrEqual(max)
        expect(wellFormed(clip(text, max))).toBe(true)
      }),
    )
  })
})

describe('[FR-LINE-006/AC1] a notification other than an approval task goes to LINE as a short text with its link (BR-NOTI-02)', () => {
  it('the title, the body line by line, then the link back to the page', () => {
    const notice = textNotice({ title: 'สรุปประจำวัน: มีงานรอคุณพิจารณา 2 งาน', body: 'โปรดพิจารณางานที่รออนุมัติ 2 งาน\n• คำขอ PR-2569-00012 รอ 3 ชม.', url: `${LIFF}/tasks` })
    expect(notice).toEqual({ type: 'text', text: `สรุปประจำวัน: มีงานรอคุณพิจารณา 2 งาน\nโปรดพิจารณางานที่รออนุมัติ 2 งาน\n• คำขอ PR-2569-00012 รอ 3 ชม.\n${LIFF}/tasks` })
    expect(textNotice({ title: 'คำขอ PR-2569-00012 อนุมัติแล้ว', body: null, url: `${LIFF}/requests/${TASK}` }).text).toBe(`คำขอ PR-2569-00012 อนุมัติแล้ว\n${LIFF}/requests/${TASK}`)
    expectWithinLineLimits(textNotice({ title: 'ก'.repeat(5000), body: 'ข\n'.repeat(5000), url: LIFF }))
    expect(textNotice({ title: 'ก'.repeat(5000), body: 'ข\n'.repeat(5000), url: LIFF }).text.endsWith(`\n${LIFF}`)).toBe(true)
  })
})

describe('[FR-LINE-002/AC1] a LINE message opens the LIFF page of the same thing (§9.3, §9.4)', () => {
  it('maps workspace pages to LIFF pages, and leaves the ones LIFF has not to the workspace', () => {
    expect(liffPathFor(`/tasks/${TASK}`)).toBe(`/tasks/${TASK}`)
    expect(liffPathFor('/tasks')).toBe('/tasks')
    expect(liffPathFor(`/requests/${TASK}`)).toBe(`/requests/${TASK}`)
    expect(liffPathFor('/requests/new')).toBe('/requests/new')
    expect(liffPathFor('/settings/delegation')).toBe('/delegation')
    expect(liffPathFor(`/receiving/${TASK}`)).toBe(`/gr/${TASK}`)
    for (const page of ['/admin/doa', '/board/pending', `/procurement/pos/${TASK}`, '/tasks/../admin', `/tasks/${TASK}/x`, 'https://evil.example/tasks']) expect(liffPathFor(page)).toBeNull()
    expect(liffTaskPath(TASK, 'approve')).toBe(`/tasks/${TASK}?action=approve`)
    expect(liffTaskPath(TASK)).toBe(`/tasks/${TASK}`)
  })
})

describe('[FR-WF-101/AC5] a reviewer\'s card: "ผ่าน" in the chat, "ตีกลับ" in LIFF, no rejection (S6 · BR-WF-09)', () => {
  const review = { ...base, review: { ruleCodes: ['RV-03'] } }
  it('says it waits for a review under its rules; passes with the same postback and returns on the LIFF page', () => {
    const card = approvalCard(review)
    const texts = textsOf(card)
    expect(texts).toEqual(expect.arrayContaining(['โปรดตรวจก่อนอนุมัติ', 'ตรวจตามข้อ', 'RV-03']))
    expect(texts).not.toContain('โปรดพิจารณาอนุมัติ')
    expect(actionsOf(card).map((a) => [a.type, a.label])).toEqual([
      ['postback', 'ผ่าน'],
      ['uri', 'ตีกลับ'],
      ['uri', 'ดูรายละเอียด'],
    ])
    expect(actionsOf(card)[0]).toMatchObject({ data: approvePostbackData(TOKEN), displayText: 'ผ่าน PR-2569-00012' })
    expect(actionsOf(approvalCard({ ...review, tokenId: null })).map((a) => [a.type, a.label])[0]).toEqual(['uri', 'ผ่าน'])
    expect(actionsOf(approvalCard({ ...review, locale: 'en' })).map((a) => a.label)).toEqual(['Pass', 'Return', 'View details'])
  })

  it('fits LINE\'s limits with long rule lists and names, by the size of its texts', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ unit: 'grapheme', minLength: 1, maxLength: 40 }), { minLength: 1, maxLength: 20 }), fc.string({ unit: 'grapheme', maxLength: 300 }), (codes, name) => {
        const card = approvalCard({ ...review, review: { ruleCodes: codes }, label: `PR ${name}`, requester: { name, department: name } })
        expectWithinLineLimits(card)
        expect(jsonByteLength(card.contents)).toBeLessThan(LINE_FLEX_BUBBLE_MAX_BYTES / 4)
        for (const text of [card.altText, ...textsOf(card)]) expect(wellFormed(text)).toBe(true)
      }),
      { numRuns: 200 },
    )
  })
})

describe('[FR-WF-101/AC5] the answer to a reviewer\'s pass says passed, not approved (S6 · BR-WF-09)', () => {
  it('"ผ่านแล้ว" and the route it was reviewed on', () => {
    const card = decisionConfirmationCard({ locale: 'th', subjectType: 'REQUEST', typeName: 'จ้างเหมา', label: 'PR-2569-00099', doa: base.doa, decidedAt: new Date('2026-10-06T02:00:00Z'), stage: 'NEXT_STEP', detailsUrl: LIFF, review: true })
    expect(textsOf(card)).toEqual(expect.arrayContaining(['ผ่านแล้ว', 'ตรวจในเส้นทางของ DOA-DEMO ฉบับ 1 ข้อ PR-02']))
    expect(textsOf(card)).not.toContain('อนุมัติแล้ว')
    expectWithinLineLimits(card)
  })
})

describe('[FR-DOA-101/AC2] S6-11: one price badge per card, counts and percents only (BR-PRC-05 · OQ-107)', () => {
  it('a request with lines above and below the past median gets one price row, and none without a badge', () => {
    const texts = textsOf(approvalCard({ ...base, priceBadge: cardBadge([{ deviationBp: 833, alert: 'HIGH' }, { deviationBp: 1250, alert: 'HIGH' }, { deviationBp: -1599, alert: 'LOW' }, { deviationBp: 0, alert: null }]) }))
    const price = texts.filter((t) => t.includes('ค่ากลางย้อนหลัง'))
    expect(price).toEqual(['สูงกว่าค่ากลางย้อนหลัง 2 รายการ สูงสุด +12% · ต่ำกว่าค่ากลางย้อนหลัง 1 รายการ ต่ำสุด -15%'])
    expect(textsOf(approvalCard({ ...base, priceBadge: cardBadge([{ deviationBp: 500, alert: null }]) })).some((t) => t.includes('ค่ากลาง'))).toBe(false)
    expect(textsOf(approvalCard(base)).some((t) => t.includes('ค่ากลาง'))).toBe(false)
  })

  it('in English too', () => {
    expect(textsOf(approvalCard({ ...base, locale: 'en', priceBadge: { high: { lines: 1, maxPct: 8 }, low: null } }))).toContain('Above the past median: 1 line(s), up to +8%')
  })
})
