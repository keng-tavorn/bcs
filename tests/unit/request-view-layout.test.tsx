import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { editRefusal } from '@/app/(workspace)/_tracking/access'
import { requestBudgetState } from '@/app/(workspace)/_tracking/budget-state'
import { RequestSections } from '@/app/(workspace)/_tracking/request-sections'
import { memberPrincipal } from '@/server/authz'
import type { RequestAccessDto, RequestViewDto } from '@/server/queries/requests'
import { AttachmentList } from '@/ui/request-view/attachments'
import { Facts, FIT_COLUMNS } from '@/ui/request-view/facts'
import { PlaceFacts } from '@/ui/request-view/place'
import { StateLine } from '@/ui/request-view/status'
import { StepApprovers } from '@/ui/request-view/step-approvers'
import th from '../../messages/th.json'

// The parts of a request's page that the workspace and LIFF share (/requests/[id], /tasks/[id], /liff/requests/[id],
// /liff/tasks/[id]) — D-05 round 5:
//  - they lay themselves out by their own width (a container query), never the screen's: a LIFF page's one column is
//    34rem at most at any screen width (§9.9 "LIFF เป็นคอลัมน์เดียว"), so the request's facts, its delivery site and
//    supplier, and its files stack there as on a phone, while the workspace's wider column keeps two or three columns;
//  - budget held for a request is a padlock in --info, not the approved mark of --primary (§9.9 tokens);
//  - so is the quotation the requester chose a bookmark in --info: choosing a supplier is not an approval;
//  - the two sentences of a step waiting for two approvers are content, at the body's size (§9.9: 15 px on the web);
//  - the edit page refuses by who is reading (§9.9 rule 7): never a link to a page that would refuse them again.

// The request's sections are a server component: their words come from the Thai messages, as next-intl/server gives them
vi.mock('next-intl/server', async () => {
  const intl = await import('next-intl')
  const messages = (await import('../../messages/th.json')).default as Record<string, unknown>
  const translator = (namespace?: string) => intl.createTranslator({ locale: 'th', messages, ...(namespace ? { namespace } : {}) } as Parameters<typeof intl.createTranslator>[0])
  return { getLocale: async () => 'th', getTranslations: async (options?: string | { namespace?: string }) => translator(typeof options === 'string' ? options : options?.namespace) }
})

const html = (node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="th" messages={th} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )

/** The classes of the first element of some markup that has `attribute` (an opening tag's text) */
const classesOf = (markup: string, tag: RegExp) => (/class="([^"]*)"/.exec(tag.exec(markup)?.[0] ?? '')?.[1] ?? '').split(/\s+/).filter(Boolean)
/** Classes that split by the screen's width */
const SCREEN = /^(?:sm|md|lg|xl):(?:grid-cols|flex-row|self-|text-right|items-|justify-|gap-)/

const FACTS = [
  { label: 'ประเภทคำขอ', value: 'ซื้อของ' },
  { label: 'ส่งเมื่อ', value: '6 ต.ค. 2569' },
  { label: 'ความเร่งด่วน', value: 'ปกติ' },
]

describe('[§9.9] shared parts of a request lay themselves out by their own width, so LIFF stays one column at every screen width', () => {
  it('the request’s facts: one column below 36rem — a phone, the LIFF column — two from 36rem, three from 40rem, in a container of their own', () => {
    const markup = renderToStaticMarkup(<Facts items={FACTS} columns={3} />)
    expect(markup).toMatch(/^<div class="@container"><dl /)
    const classes = classesOf(markup, /<dl [^>]*>/)
    expect(classes).toEqual(expect.arrayContaining(['grid', '@min-[36rem]:grid-cols-2', '@min-[40rem]:grid-cols-3']))
    expect(classes.filter((c) => SCREEN.test(c) || /^grid-cols-/.test(c))).toEqual([])
    expect(FIT_COLUMNS[3]).toBe('@min-[36rem]:grid-cols-2 @min-[40rem]:grid-cols-3')
  })

  it('two columns that fit, one column at every width, or — the default the other pages keep — two from the screen’s sm width', () => {
    const two = classesOf(renderToStaticMarkup(<Facts items={FACTS} columns={2} />), /<dl [^>]*>/)
    expect(two).toContain('@min-[36rem]:grid-cols-2')
    expect(two.filter((c) => SCREEN.test(c))).toEqual([])
    const one = classesOf(renderToStaticMarkup(<Facts items={FACTS} columns="one" />), /<dl [^>]*>/)
    expect(one.filter((c) => /grid-cols-/.test(c))).toEqual([])
    expect(renderToStaticMarkup(<Facts items={FACTS} columns="one" />)).toMatch(/^<dl /)
    expect(classesOf(renderToStaticMarkup(<Facts items={FACTS} />), /<dl [^>]*>/)).toContain('sm:grid-cols-2')
  })

  it('the delivery site and the suggested supplier line up with the facts above them: the same columns, by the same width', () => {
    const markup = renderToStaticMarkup(
      <PlaceFacts
        items={[
          { label: 'สถานที่ส่ง', value: 'SITE-A · ไซต์งานตัวอย่าง A', detail: 'ไซต์ก่อสร้างสมมติ A', set: true },
          { label: 'ผู้ขายที่แนะนำ', value: 'ไม่ระบุ ฝ่ายจัดซื้อเป็นผู้เลือก', detail: null, set: false },
        ]}
      />,
    )
    expect(markup).toMatch(/^<div class="@container"><dl /)
    const classes = classesOf(markup, /<dl [^>]*>/)
    expect(classes).toEqual(expect.arrayContaining(FIT_COLUMNS[3].split(' ')))
    expect(classes.filter((c) => SCREEN.test(c) || /^grid-cols-/.test(c))).toEqual([])
  })

  it('a file’s link sits beside it where the list is 36rem wide or more, under it below that', () => {
    const markup = html(<AttachmentList open={async () => null} files={[{ fileId: 'f-1', fileName: 'ใบเสนอราคา.pdf', detail: 'ใบเสนอราคา · 12 KB' }]} />)
    expect(classesOf(markup, /<div [^>]*>/)).toContain('@container')
    const row = classesOf(markup, /<li [^>]*>/)
    expect(row).toEqual(expect.arrayContaining(['flex-col', '@min-[36rem]:flex-row', '@min-[36rem]:items-center', '@min-[36rem]:justify-between']))
    const button = classesOf(markup, /<button [^>]*>/)
    expect(button).toContain('@min-[36rem]:self-center')
    expect([...row, ...button].filter((c) => SCREEN.test(c))).toEqual([])
  })
})

describe('[§9.9] budget held for a request: a padlock in --info, not the mark of an approval', () => {
  const view = (budget: { reservedSatang: bigint; committedSatang: bigint } | null, status: string) =>
    ({ status, budget: budget ? { budgetLineId: 'l-1', code: 'CON-OPEX-2569', name: 'ค่าใช้จ่ายดำเนินงาน', status: 'OPEN', ...budget } : null }) as unknown as Parameters<typeof requestBudgetState>[0]

  it('reserved while it waits for approval, and committed in a purchase order, are held; given back once rejected or cancelled', () => {
    expect(requestBudgetState(view({ reservedSatang: 1_870_000n, committedSatang: 0n }, 'PENDING_APPROVAL'))).toEqual({ kind: 'held', key: 'stateReserved' })
    expect(requestBudgetState(view({ reservedSatang: 0n, committedSatang: 1_870_000n }, 'ORDERED'))).toEqual({ kind: 'held', key: 'stateCommitted' })
    expect(requestBudgetState(view({ reservedSatang: 0n, committedSatang: 0n }, 'REJECTED'))).toEqual({ kind: 'closed', key: 'stateReleased' })
    expect(requestBudgetState(view(null, 'DRAFT'))).toEqual({ kind: 'draft', key: 'stateNone' })
  })

  it('the held mark is a padlock in --info beside the same words; the approved mark stays the check in --primary', () => {
    const held = renderToStaticMarkup(<StateLine kind="held">{th.requestView.budget.stateReserved}</StateLine>)
    const icon = /<svg[^>]*>/.exec(held)?.[0] ?? ''
    expect(icon).toContain('lucide-lock')
    expect(icon).toContain('text-info')
    expect(icon).toContain('aria-hidden="true"')
    expect(held).toContain('<span>จองงบแล้ว</span>')
    expect(held).not.toContain('text-primary')
    expect(/<svg[^>]*>/.exec(renderToStaticMarkup(<StateLine kind="done">อนุมัติแล้ว</StateLine>))?.[0]).toMatch(/lucide-circle-check[\s\S]*text-primary/)
  })
})

describe('[§9.9] the quotation the requester chose: a mark of its own, not the mark of an approval', () => {
  // A request that still waits for the CEO's decision, with the requester's choice among its quotations (scene 3)
  const view = {
    documentType: 'PURCHASE_REQUEST',
    status: 'PENDING_APPROVAL',
    fields: [],
    totals: null,
    lines: [],
    budget: null,
    budgetLines: [],
    route: null,
    quotations: [
      { supplierName: 'ร้านปั๊มบาดาลท้องถิ่น', amountSatang: 14_980_000n, includesVat: true, netSatang: 14_000_000n, isSelected: true },
      { supplierName: 'บริษัท ปั๊มน้ำทดสอบ จำกัด', amountSatang: 15_515_000n, includesVat: true, netSatang: 14_500_000n, isSelected: false },
    ],
    nonLowestQuoteReason: null,
    attachments: [],
    infoRequests: [],
  } as unknown as RequestViewDto
  /** The row of a quotation in the request's sections, by its supplier */
  const quoteRow = (markup: string, supplier: string) => [...markup.matchAll(/<li [^>]*>[\s\S]*?<\/li>/g)].map((m) => m[0]).find((row) => row.includes(`>${supplier}</p>`)) ?? ''

  it('the chosen mark is a bookmark in --info beside the same words; never the check in --primary', () => {
    const chosen = renderToStaticMarkup(<StateLine kind="chosen">{th.requestView.quotes.selected}</StateLine>)
    const icon = /<svg[^>]*>/.exec(chosen)?.[0] ?? ''
    expect(icon).toContain('lucide-bookmark')
    expect(icon).toContain('text-info')
    expect(icon).toContain('aria-hidden="true"')
    expect(icon).not.toContain('lucide-circle-check')
    expect(chosen).toContain('<span>รายที่เลือก</span>')
    expect(chosen).not.toContain('text-primary')
  })

  it('the request’s sections — the request and decision pages, on the web and in LIFF — mark the chosen quotation with it, and only that one', async () => {
    const markup = html(await RequestSections({ view, locale: 'th', openFile: async () => null, doaLinks: false }))
    const chosen = quoteRow(markup, 'ร้านปั๊มบาดาลท้องถิ่น')
    expect(chosen).toContain('<span>รายที่เลือก</span>')
    expect(/<svg[^>]*>/.exec(chosen)?.[0]).toMatch(/lucide-bookmark[\s\S]*text-info/)
    expect(chosen).not.toContain('lucide-circle-check')
    expect(chosen).not.toContain('text-primary')
    const other = quoteRow(markup, 'บริษัท ปั๊มน้ำทดสอบ จำกัด')
    expect(other).not.toBe('')
    expect(other).not.toContain('รายที่เลือก')
    expect(other).not.toContain('<svg')
  })
})

describe('[§9.9] a step waiting for two approvers: its sentences are content, at the body’s size', () => {
  it('why there are two and who decides read at the size of the step’s other lines (15 px on the web), not the small size', () => {
    const markup = renderToStaticMarkup(<StepApprovers title="ขั้นที่ 1" approvers={[{ key: 'a', name: 'ดำรง ก่อสร้างไทย' }, { key: 'b', name: 'หรือ ชัยวัฒน์ ปฏิบัติการใหญ่' }]} mark="ส่งต่อเมื่อเลยกำหนด ผู้อนุมัติระดับถัดไปร่วมพิจารณา" note="ผู้ที่ตัดสินก่อนเป็นผู้ตัดสินขั้นนี้" />)
    expect(markup).toContain('<p class="text-ink-muted">ส่งต่อเมื่อเลยกำหนด ผู้อนุมัติระดับถัดไปร่วมพิจารณา</p>')
    expect(markup).toContain('<p class="text-ink-muted">ผู้ที่ตัดสินก่อนเป็นผู้ตัดสินขั้นนี้</p>')
    expect(markup).not.toMatch(/text-sm/)
  })
})

describe('[§9.9] the edit page refuses by who is reading, and never links to a page that would refuse them again', () => {
  const access: RequestAccessDto = { requestId: 'r-1', number: 'PR-2569-00001', requesterMemberId: 'm-req', followerMemberIds: ['m-follow'], taskMemberIds: ['m-approver'], chargedDepartmentId: 'd-con' }

  it('the requester whose account may no longer edit it: said so, with their request’s page', () => {
    expect(editRefusal(memberPrincipal('m-req', []), access)).toEqual({ who: 'REQUESTER', canOpen: true })
  })

  it('someone else who may open the request — a follower, an approver, an organization-wide role — is led to it', () => {
    expect(editRefusal(memberPrincipal('m-follow', []), access)).toEqual({ who: 'VIEWER', canOpen: true })
    expect(editRefusal(memberPrincipal('m-approver', []), access)).toEqual({ who: 'VIEWER', canOpen: true })
    expect(editRefusal(memberPrincipal('m-ceo', ['EXECUTIVE']), access)).toEqual({ who: 'VIEWER', canOpen: true })
  })

  it('someone who may not open it gets no link to it', () => {
    expect(editRefusal(memberPrincipal('m-other', []), access)).toEqual({ who: 'NONE', canOpen: false })
  })

  it('each case has words of its own, none of them a guess at what the reader may see', () => {
    const page = th.requestForm.page
    expect(new Set([page.lostEdit, page.viewOnly, page.noAccess]).size).toBe(3)
    for (const text of [page.lostEdit, page.viewOnly, page.noAccess]) expect(text).not.toContain('ถ้าคุณมีสิทธิ์ดู')
    expect(page.noAccess).toContain('ไม่มีสิทธิ์ดูคำขอนี้')
    expect(page.lostEdit).toContain('ติดต่อผู้ดูแลระบบขององค์กร')
  })
})
