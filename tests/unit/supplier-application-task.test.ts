import fc from 'fast-check'
import { createTranslator } from 'next-intl'
import { describe, expect, it } from 'vitest'
import { approvalCard, type ApprovalCardData, type FlexMessage } from '@/channels/line/flex'
import { documentCountText, duplicateCountText, supplierCardName } from '@/channels/line/flex/labels-supplier'
import { jsonByteLength, LINE_ALT_TEXT_MAX_LENGTH, LINE_FLEX_BUBBLE_MAX_BYTES, lineMessageProblems } from '@/integrations/line'
import { supplierApplicationRows, type SupplierApplicationTaskT, type SupplierApplicationTaskView } from '@/ui/liff/tasks/subjects/supplier-application-rows'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S7-09 · FR-SUP-104 AC5 · BR-NOTI ข้อ 10: the approval task of a supplier application on LINE and on the task pages. The
// card summarizes the supplier — a sole proprietor as "ผู้ขายบุคคลธรรมดา · <เลขใบสมัคร>", never by name — its category,
// its inviter, how many documents and duplicate warnings, and fits LINE's limits whatever the data; the approve button
// follows the adapter's channels like every other subject (in the chat with a token). The task pages' rows mask a sole
// proprietor's tax id and say every fact in Thai and English.

const TOKEN = '01928c6e-7f3a-7b2c-9d4e-5f6a7b8c9d0e'
const LIFF = 'https://liff.line.me/1650000003-AbCdEfGh/tasks/01928c6e-7f3a-7b2c-9d4e-000000000001'

const card: ApprovalCardData = {
  locale: 'th',
  subjectType: 'SUPPLIER_APPLICATION',
  typeName: null,
  label: 'SUP-2569-00001',
  requester: { name: 'สมศรี จัดซื้อ', department: 'ฝ่ายจัดซื้อ' },
  amountSatang: null,
  amountBasis: null,
  budget: null,
  dueAt: new Date('2026-11-10T10:30:00Z'),
  overdue: false,
  doa: { code: 'DOA-P2', versionNo: 1, ruleCode: 'SA-01' },
  acting: false,
  escalated: false,
  stepUp: false,
  tokenId: TOKEN,
  supplierApplication: { individual: false, name: 'บริษัท ก่อสร้างดี จำกัด', number: 'SUP-2569-00001', category: 'ผู้รับเหมาก่อสร้าง', documents: 3, duplicates: 1 },
  links: { approve: `${LIFF}?action=approve`, decline: `${LIFF}?action=reject`, details: LIFF },
}

function textsOf(message: FlexMessage): string[] {
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

const actionsOf = (message: FlexMessage) => {
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

function expectWithinLineLimits(message: FlexMessage) {
  expect(lineMessageProblems([message])).toEqual([])
  expect(jsonByteLength(message.contents)).toBeLessThanOrEqual(LINE_FLEX_BUBBLE_MAX_BYTES)
  expect(message.altText.length).toBeLessThanOrEqual(LINE_ALT_TEXT_MAX_LENGTH)
}

describe('[FR-SUP-104/AC5] the LINE approval card of a supplier application (BR-NOTI ข้อ 10)', () => {
  it('a juristic supplier: legal name, category, inviter, documents and duplicate warnings; approve in the chat with the token', () => {
    const message = approvalCard(card)
    const texts = textsOf(message)
    for (const text of ['SUP-2569-00001', 'ใบสมัครผู้ขาย', 'ผู้ขาย', 'บริษัท ก่อสร้างดี จำกัด', 'หมวด', 'ผู้รับเหมาก่อสร้าง', 'ผู้เชิญ', 'สมศรี จัดซื้อ · ฝ่ายจัดซื้อ', 'เอกสาร', '3 ฉบับ', 'เตือนซ้ำ', '1 รายการ', 'DOA-P2 ฉบับ 1 ข้อ SA-01']) expect(texts).toContain(text)
    // no amount and no budget row: SUPPLIER_APPROVAL has none (BR-DOA-26)
    expect(texts).not.toContain('ยอดตามฐาน DOA')
    expect(texts).not.toContain('ผู้ขอ')
    const [approve] = actionsOf(message)
    expect(approve).toMatchObject({ type: 'postback', data: `v=1&a=approve&k=${TOKEN}` })
    expectWithinLineLimits(message)
  })

  it('a sole proprietor is "ผู้ขายบุคคลธรรมดา · <number>", never named, even if a name were passed', () => {
    const message = approvalCard({ ...card, supplierApplication: { ...card.supplierApplication!, individual: true, name: 'นายสมชาย ใจดี' } })
    const texts = textsOf(message)
    expect(texts).toContain('ผู้ขายบุคคลธรรมดา · SUP-2569-00001')
    expect(JSON.stringify(message)).not.toContain('สมชาย')
    const english = approvalCard({ ...card, locale: 'en', supplierApplication: { ...card.supplierApplication!, individual: true, name: null, duplicates: 0, category: null } })
    expect(textsOf(english)).toEqual(expect.arrayContaining(['Individual supplier · SUP-2569-00001', 'Supplier application', 'Invited by', 'Not given', 'None', '3 documents']))
  })

  it('no duplicate warning says so in words; a warning is in the warning colour as well as in words', () => {
    expect(textsOf(approvalCard({ ...card, supplierApplication: { ...card.supplierApplication!, duplicates: 0 } }))).toContain('ไม่มี')
    expect(duplicateCountText(2, 'th')).toBe('2 รายการ')
    expect(duplicateCountText(1, 'en')).toBe('1 warning')
    expect(documentCountText(1, 'en')).toBe('1 document')
    expect(documentCountText(0, 'th')).toBe('0 ฉบับ')
  })

  it('without a token the approve button opens the LIFF page; other subjects keep their rows', () => {
    expect(actionsOf(approvalCard({ ...card, tokenId: null }))[0]).toMatchObject({ type: 'uri', label: 'อนุมัติ', uri: `${LIFF}?action=approve` })
    const request = approvalCard({ ...card, subjectType: 'REQUEST', supplierApplication: null })
    expect(textsOf(request)).toContain('ผู้ขอ')
    expect(textsOf(request)).not.toContain('ผู้เชิญ')
  })

  it('fits LINE\'s limits whatever the names and category, and never names a sole proprietor', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 400 }), fc.string({ unit: 'grapheme', maxLength: 300 }), fc.boolean(), fc.nat(500), fc.nat(50), fc.constantFrom('th' as const, 'en' as const), (name, category, individual, documents, duplicates, locale) => {
        const message = approvalCard({ ...card, locale, requester: { name: category, department: category }, supplierApplication: { individual, name: `ZZ${name}`, number: 'SUP-2569-00001', category, documents, duplicates } })
        expectWithinLineLimits(message)
        if (individual) expect(textsOf(message).some((t) => t.startsWith('ZZ'))).toBe(false)
      }),
      { numRuns: 200 },
    )
  })

  it('supplierCardName: the legal name, else the individual words with the number', () => {
    expect(supplierCardName({ individual: false, name: 'บริษัท เอ จำกัด', number: 'SUP-1' }, 'th')).toBe('บริษัท เอ จำกัด')
    expect(supplierCardName({ individual: true, name: 'นาย ก', number: 'SUP-1' }, 'th')).toBe('ผู้ขายบุคคลธรรมดา · SUP-1')
    expect(supplierCardName({ individual: true, name: null, number: null }, 'en')).toBe('Individual supplier')
  })
})

const view: SupplierApplicationTaskView = {
  number: 'SUP-2569-00002',
  kind: 'NEW',
  payeeType: 'INDIVIDUAL',
  nameTh: 'นายสมชาย ใจดี',
  nameEn: null,
  category: 'งานไฟฟ้า',
  taxId: 'XXXXXXXXX0121',
  taxIdMasked: true,
  branchCode: '00000',
  isVatRegistered: false,
  registry: { source: 'MANUAL', juristicStatus: null, vatCancelled: false },
  duplicates: [{ code: 'DUPLICATE_EMAIL', matches: ['V-0012'], reason: 'อีเมลของพี่ชายที่เป็นผู้ขายอีกราย' }],
  documents: [{ id: 'd1', typeCode: 'ID_CARD', typeName: { th: 'บัตรประชาชน', en: 'ID card' }, status: 'VERIFIED', expiresOn: '2030-01-01', verifiedBy: { th: 'วิภา ตรวจเอกสาร', en: 'Wipa' } }],
  invitedBy: { th: 'สมศรี จัดซื้อ', en: 'Somsri' },
  filledOnBehalfBy: null,
  routedBy: { th: 'อนันต์ ส่งเรื่อง', en: null },
}

describe('[FR-SUP-104/AC5] the task pages\' rows of a supplier application', () => {
  const tTh = createTranslator({ locale: 'th', messages: th, namespace: 'supplierApplicationTask' }) as unknown as SupplierApplicationTaskT
  const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'supplierApplicationTask' }) as unknown as SupplierApplicationTaskT

  it('a sole proprietor\'s tax id shows its last four digits only; the registry, duplicates with their reason, documents and people', () => {
    const rows = supplierApplicationRows(tTh, 'th', view)
    const facts = Object.fromEntries(rows.facts.map((r) => [r.label, r.value]))
    expect(facts['เลขผู้เสียภาษี']).toBe('XXXXXXXXX0121 (แสดงเฉพาะ 4 หลักท้าย)')
    expect(facts['ประเภทผู้ขาย']).toBe('บุคคลธรรมดา')
    expect(facts['หมวด']).toBe('งานไฟฟ้า')
    expect(facts['สาขา']).toBe('สำนักงานใหญ่ (00000)')
    expect(rows.registry[0]).toMatchObject({ title: 'ไม่พบในทะเบียน จัดซื้อยืนยันด้วยหลักฐานที่แนบ', warn: true })
    expect(rows.duplicates[0]).toMatchObject({ title: 'อีเมลซ้ำกับผู้ขายหรือใบสมัครอื่น', detail: ['ตรงกับ V-0012', 'เหตุผลของจัดซื้อ: อีเมลของพี่ชายที่เป็นผู้ขายอีกราย'], warn: true })
    expect(rows.documents[0]).toMatchObject({ title: 'บัตรประชาชน', warn: false })
    expect(rows.documents[0]!.detail[1]).toBe('ยืนยันโดย วิภา ตรวจเอกสาร')
    expect(rows.people.map((p) => p.value)).toEqual(['สมศรี จัดซื้อ', 'อนันต์ ส่งเรื่อง'])
  })

  it('every row has its words in English too, names in English where there are some', () => {
    const rows = supplierApplicationRows(tEn, 'en', { ...view, payeeType: 'JURISTIC', taxId: '0105551234567', taxIdMasked: false, registry: { source: 'DBD', juristicStatus: 'ยังดำเนินกิจการอยู่', vatCancelled: true }, duplicates: [] })
    const facts = Object.fromEntries(rows.facts.map((r) => [r.label, r.value]))
    expect(facts['Tax ID']).toBe('0105551234567')
    expect(facts['Supplier type']).toBe('Juristic person')
    expect(rows.registry.map((r) => r.title)).toEqual(['Found at the Department of Business Development', 'The registry says its VAT registration was cancelled'])
    expect(rows.registry[0]!.detail).toEqual(['Registry status: ยังดำเนินกิจการอยู่'])
    expect(rows.documents[0]!.title).toBe('ID card')
    expect(rows.people[0]!.value).toBe('Somsri')
    expect(rows.people[1]!.value).toBe('อนันต์ ส่งเรื่อง')
  })
})
