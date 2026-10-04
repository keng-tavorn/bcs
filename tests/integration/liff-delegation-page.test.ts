import { randomUUID } from 'node:crypto'
import { NextIntlClientProvider } from 'next-intl'
import { createElement, type ComponentProps, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The LIFF page's session is what these tests choose: the page and its server actions run with whatever liffPage()
// hands them (src/app/liff/_lib/session.ts reads the cookies of a request, which a test has none of). Next.js's page
// cache is a spy, and the language of the screen is Thai through next-intl's own translator. Everything else — the
// delegation services, their rules and Events — is the real path on real Postgres (BCS_TEST_DB).
const session = vi.hoisted(() => ({ page: { kind: 'signed-out' } as unknown }))
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
vi.mock('@/app/liff/_lib/session', () => ({ liffPage: async () => session.page }))
vi.mock('next/cache', () => ({ revalidatePath: cache.revalidatePath }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, replace: () => undefined, push: () => undefined }) }))
vi.mock('next-intl/server', async () => {
  const intl = await import('next-intl')
  const messages = (await import('../../messages/th.json')).default as Record<string, unknown>
  const translator = (namespace?: string) => intl.createTranslator({ locale: 'th', messages, ...(namespace ? { namespace } : {}) } as Parameters<typeof intl.createTranslator>[0])
  return { getLocale: async () => 'th', getTranslations: async (options?: string | { namespace?: string }) => translator(typeof options === 'string' ? options : options?.namespace) }
})

import { createLiffDelegationAction, revokeLiffDelegationAction } from '@/app/liff/delegation/actions'
import LiffDelegationPage from '@/app/liff/delegation/page'
import { prisma } from '@/server/db/client'
import { LiffProvider } from '@/ui/liff/liff-provider'
import th from '../../messages/th.json'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S5-06 · the server side of /liff/delegation (FR-DOA-006 AC2, the LIFF part; BR-DLG-01 to BR-DLG-04):
//  - the page's server actions (src/app/liff/delegation/actions.ts) take the member from the LIFF page's session and
//    call the workspace's delegation services on channel LIFF, then refresh the page;
//  - a submission key or a delegation id that is not one is refused before the service runs;
//  - without a member session nothing is set or cancelled, whatever the page's state;
//  - the page says what a delegation does in this build: the tasks waiting for the delegator move to the acting
//    approver when the period starts, new ones go there too, and what is left comes back at the end (BR-DLG-04).
// Monday 5 Oct 2026 10:00 Thai time.

const NOW = new Date('2026-10-05T03:00:00Z')
const UNAUTHENTICATED = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_KEY = { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
/** The LIFF page's own opening line (messages/src/th/liffDelegation.json) and the workspace's (delegation.json) */
const INTRO_LIFF = 'ตั้งผู้รักษาการเมื่อคุณลาหรือไม่อยู่ เมื่อเริ่มช่วงนั้น งานอนุมัติที่รอคุณอยู่จะย้ายไปที่ผู้รักษาการ และงานใหม่ที่มาถึงคุณระหว่างช่วงนั้นก็ไปที่ผู้รักษาการด้วย'
const INTRO_WEB = 'ระหว่างช่วงนั้นงานอนุมัติใหม่ที่มาถึงคุณจะไปที่ผู้รักษาการ'

let org: DoaOrg

beforeAll(async () => {
  org = await createDoaOrg()
})

beforeEach(() => {
  session.page = { kind: 'signed-out' }
  cache.revalidatePath.mockClear()
})

/** The LIFF page of a member of the test organization, as liffPage() hands it over (a LINE sign-in, channel LIFF) */
function asMember(code: string) {
  session.page = {
    kind: 'member',
    ctx: org.ctxOf(code, NOW, 'LIFF'),
    member: { id: org.member[code]!, organizationId: org.organizationId, organizationName: 'องค์กรทดสอบ DOA', displayNameTh: `ผู้ใช้ ${code}`, displayNameEn: null, email: `${code}@test.bcs.local` },
    session: 'liff',
  }
}

const twoDays = (reason: string) => ({ delegateMemberId: org.member.asst_con!, firstDay: '2026-10-05', lastDay: '2026-10-06', documentTypes: [], maxAmount: '20,000', reason })
const delegationsOf = (code: string) => prisma.delegation.findMany({ where: { organizationId: org.organizationId, delegatorMemberId: org.member[code]! }, orderBy: { createdAt: 'asc' } })

describe('[FR-DOA-006/AC2] the actions of the LIFF delegation page run with the page’s member, on channel LIFF', () => {
  it('[FR-DOA-006/AC2] dm_con, signed in through LINE, names an acting approver and cancels it through the page’s actions: both Events say LIFF and the page is refreshed', async () => {
    asMember('dm_con')
    expect(await createLiffDelegationAction(twoDays('ลาพักร้อน'), randomUUID())).toEqual({ ok: true })
    const [set] = await delegationsOf('dm_con')
    expect(set).toMatchObject({ delegateMemberId: org.member.asst_con, status: 'ACTIVE', maxAmountSatang: 2_000_000n, createdVia: 'SELF' })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: set!.id, type: 'delegation.created' } })).toMatchObject({ channel: 'LIFF', actorMemberId: org.member.dm_con })
    expect(cache.revalidatePath).toHaveBeenCalledWith('/liff/delegation')

    // Someone else cannot cancel it: the service refuses (delegation.manage, own delegations only)
    asMember('asst_con')
    expect(await revokeLiffDelegationAction(set!.id, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    asMember('dm_con')
    expect(await revokeLiffDelegationAction(set!.id, randomUUID())).toEqual({ ok: true })
    expect(await prisma.delegation.findUniqueOrThrow({ where: { id: set!.id } })).toMatchObject({ status: 'REVOKED' })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: set!.id, type: 'delegation.revoked' } })).toMatchObject({ channel: 'LIFF', actorMemberId: org.member.dm_con })
  })

  it('[FR-DOA-006/AC2] refuses a submission key or a delegation id that is not one before the service runs, and sets nothing', async () => {
    asMember('dm_con')
    const before = (await delegationsOf('dm_con')).length
    expect(await createLiffDelegationAction(twoDays('ประชุมต่างจังหวัด'), 'not-a-key')).toEqual(BAD_KEY)
    expect(await revokeLiffDelegationAction(randomUUID(), 'not-a-key')).toEqual(BAD_KEY)
    expect(await revokeLiffDelegationAction('not-a-delegation', randomUUID())).toEqual({ ok: false, code: 'NOT_FOUND' })
    expect((await delegationsOf('dm_con')).length).toBe(before)
    expect(cache.revalidatePath).not.toHaveBeenCalled()
  })
})

describe('[FR-DOA-006/AC2] without a member session of the LIFF page nothing is set or cancelled', () => {
  for (const page of [{ kind: 'signed-out' }, { kind: 'needs-2fa-setup', session: 'liff' }, { kind: 'no-membership', session: 'web' }] as const) {
    it(`[FR-DOA-006/AC2] a page that is ${page.kind}`, async () => {
      asMember('dm_con')
      expect(await createLiffDelegationAction({ ...twoDays('ไปอบรม'), firstDay: '2026-10-20', lastDay: '2026-10-21' }, randomUUID())).toEqual({ ok: true })
      const running = (await delegationsOf('dm_con')).at(-1)!
      const events = await prisma.event.count({ where: { organizationId: org.organizationId } })
      const count = (await delegationsOf('dm_con')).length

      session.page = page
      expect(await createLiffDelegationAction({ ...twoDays('ลากิจ'), firstDay: '2026-11-02', lastDay: '2026-11-03' }, randomUUID())).toEqual(UNAUTHENTICATED)
      expect(await revokeLiffDelegationAction(running.id, randomUUID())).toEqual(UNAUTHENTICATED)
      expect((await delegationsOf('dm_con')).length).toBe(count)
      expect(await prisma.delegation.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({ status: running.status })
      expect(await prisma.event.count({ where: { organizationId: org.organizationId } })).toBe(events)
      // Tidy: the delegation set above stops, so the next case sets its own without overlapping (BR-DLG-03)
      asMember('dm_con')
      expect(await revokeLiffDelegationAction(running.id, randomUUID())).toEqual({ ok: true })
    })
  }
})

describe('[FR-DOA-006/AC2] the LIFF delegation page says what a delegation does in this build', () => {
  it('[FR-DOA-006/AC2] the opening line says the tasks waiting for the approver move to the acting approver when the period starts, not only new ones', async () => {
    asMember('dm_con')
    const intl = { locale: 'th', messages: th, timeZone: 'Asia/Bangkok' } as ComponentProps<typeof NextIntlClientProvider>
    const liffProps = { config: { liffId: null, mock: { lineUserId: `U${'0'.repeat(32)}`, cookie: 'bcs-liff-mock-user' }, session: 'liff' } } as ComponentProps<typeof LiffProvider>
    const page: ReactNode = await LiffDelegationPage()
    const html = renderToStaticMarkup(createElement(NextIntlClientProvider, intl, createElement(LiffProvider, liffProps, page)))
    expect(html).toContain(INTRO_LIFF)
    expect(html).toContain('เมื่อจบช่วง งานที่ยังค้างจะกลับมาที่คุณ')
    expect(html).not.toContain(INTRO_WEB)
    // The form is there, for an approver who holds a position
    expect(html).toContain('ตั้งผู้รักษาการ')
  })
})
