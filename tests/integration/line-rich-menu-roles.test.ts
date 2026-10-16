import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RICH_MENU_VARIANTS } from '@/core/line-menu'
import { createLineClient, setLineClient } from '@/integrations/line'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { getDefaultOutboxSender, setDefaultOutboxSender, type OutboxMessage, type OutboxSender } from '@/server/events/outbox'
import { lineRichMenuRun } from '@/server/jobs/line-rich-menu'
import { seedWorkflow } from '@/server/seed/workflow'
import { saveLineChannelSettings } from '@/server/services/line-channel'
import { readLineRichMenuImages, replaceLineRichMenus, richMenuInputsOf, syncLineRichMenusOf } from '@/server/services/line-link'
import { grantRole } from '@/server/services/members/roles'
import { newLineUserId } from '../../scripts/line-simulate'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET, withFakeLine } from '../support/fake-line'

// S17-03 · FR-LINE-303 AC1 AC2 AC6 (BR-LINE-16 BR-LINE-17): the rich menu of a linked member is their set by role,
// from flags read at the time of the switch. The organization is the S6 fixture (org-s6.yaml) under the §7.4 DOA, with
// one more rule whose committee names asst_con by MEMBER and PC1 (held by coo) by position — so a member named in a DOA
// counts and a committee's approvers count. The menus of the sets are made at the fake LINE server of the repo and
// stored in LineRichMenuVariant as `pnpm line:richmenu` will (S17-04); job line-rich-menu is run directly with the
// payload the outbox hands Inngest.

const PROVIDER = '1650000031'
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const jobStep = { run: <T>(_id: string, fn: () => Promise<T>) => fn() }
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

const line = withFakeLine()
const toInngest: OutboxMessage[] = []
let senderBefore: OutboxSender | null = null
let org: DoaOrg
const lineUser: Record<string, string> = {}
const menuOf: Record<string, string> = {}

const adminAt = () => org.ctxOf('admin', new Date())
const userMenu = (code: string) => line.fake.userRichMenu(lineUser[code]!)
/** The payload the outbox hands Inngest for the last event of this type and aggregate */
const handed = (type: string, aggregateId: string) => toInngest.filter((m) => m.name === `bcs/${type}` && (m.data as { aggregateId?: string }).aggregateId === aggregateId).at(-1)

beforeAll(async () => {
  senderBefore = getDefaultOutboxSender()
  setDefaultOutboxSender(async (messages) => {
    toInngest.push(...messages)
  })
  org = await createDoaOrg({ fixtures: { org: 'fixtures/org-s6.yaml', versions: 'fixtures/doa-versions.yaml' } })
  const organizationId = org.organizationId
  await prisma.roleAssignment.create({ data: { organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: new Date() } })
  // A committee naming asst_con by MEMBER and PC1 by position, in every version (whichever is in effect today)
  for (const version of await prisma.doaVersion.findMany({ where: { organizationId }, select: { id: true } })) {
    await prisma.doaRule.create({
      data: {
        organizationId,
        doaVersionId: version.id,
        code: 'CPX-01',
        documentType: 'PURCHASE_REQUEST',
        priority: 50,
        when: { amount: { gt: '90000000000' } },
        steps: [{ approvers: [{ kind: 'MEMBER', memberId: org.member.asst_con! }, { kind: 'POSITION_OF_ORG', position: 'PC1' }], mode: 'PARALLEL', quorum: 'ALL', slaBusinessMinutes: 480 }],
      },
    })
  }
  // The channel, its two menus (UNLINKED, LINKED) and a menu of every set by role, as `pnpm line:richmenu` stores them
  const admin = adminAt()
  const saved = ok(
    await saveLineChannelSettings(admin, { providerId: PROVIDER, messagingChannelId: '1650000032', channelSecret: TEST_CHANNEL_SECRET, channelAccessToken: TEST_ACCESS_TOKEN, liffId: '1650000033-RoLeMeNu', liffChannelId: '1650000033', active: true }, key()),
  )
  const images = await readLineRichMenuImages()
  ok(await replaceLineRichMenus(admin, images, key()))
  const config = await prisma.lineChannelConfig.findFirstOrThrow({ where: { organizationId } })
  const api = line.client.channel(TEST_ACCESS_TOKEN)
  for (const variant of RICH_MENU_VARIANTS.filter((v) => v.variant !== 'UNLINKED')) {
    const id = await api.createRichMenu({ size: { width: 2500, height: 843 }, selected: true, name: `bcs:${saved.channelKey}:${variant.variant}:1`, chatBarText: 'เมนู BCS', areas: [{ bounds: { x: 0, y: 0, width: 2500, height: 843 }, action: { type: 'uri', uri: 'https://liff.line.me/1650000033-RoLeMeNu/help' } }] })
    await api.uploadRichMenuImage(id, images.LINKED, 'image/png')
    await prisma.lineRichMenuVariant.create({ data: { organizationId, channelConfigId: config.id, variantKey: variant.variant, richMenuId: id, madeAt: new Date() } })
    menuOf[variant.variant] = id
  }
  // Linked members: a requester, a DM (DOA by position), the member a committee names, a committee member by position, a receiver to be
  for (const code of ['req_con', 'dm_con', 'asst_con', 'coo', 'receiver_con', 'proc_officer', 'vp_sup']) {
    lineUser[code] = newLineUserId()
    await prisma.channelIdentity.create({ data: { organizationId, memberId: org.member[code]!, channel: 'LINE', providerKey: PROVIDER, externalUserId: lineUser[code]!, linkedAt: new Date() } })
  }
})
afterAll(() => {
  setDefaultOutboxSender(senderBefore)
})

describe('[FR-LINE-303/AC1] the flags of a member at the time of the switch (BR-LINE-16)', () => {
  it('DOA by position, by MEMBER and in a committee; roles as stored; a requester none', async () => {
    const ids = ['req_con', 'dm_con', 'asst_con', 'coo', 'receiver_con'].map((c) => org.member[c]!)
    const inputs = await forTenant(org.organizationId).$transaction((tx) => richMenuInputsOf(tx, ids, new Date()))
    const flags = (code: string) => {
      const i = inputs.get(org.member[code]!)!
      return i.linked ? { doa: i.doaApprover, delegate: i.activeDelegate, reviewer: i.workflowReviewer } : null
    }
    expect(flags('req_con')).toEqual({ doa: false, delegate: false, reviewer: false })
    expect(flags('dm_con')).toEqual({ doa: true, delegate: false, reviewer: false })
    expect(flags('asst_con')).toEqual({ doa: true, delegate: false, reviewer: false })
    expect(flags('coo')).toEqual({ doa: true, delegate: false, reviewer: false })
  })
})

describe('[FR-LINE-303/AC2] the menu follows roles, delegations and versions through job line-rich-menu', () => {
  it('every linked member gets the menu of their set; a DOA version run switches them all with bulk calls', async () => {
    const run = await lineRichMenuRun({ data: { organizationId: org.organizationId, aggregateId: randomUUID(), type: 'doa_version.published' } }, jobStep)
    expect(run).toMatchObject({ status: 'APPLIED', users: 7, resynced: 0, refused: 0 })
    expect(userMenu('req_con')).toBe(menuOf.LINKED)
    expect(userMenu('dm_con')).toBe(menuOf['LINKED:APPROVER'])
    expect(userMenu('asst_con')).toBe(menuOf['LINKED:APPROVER'])
    expect(userMenu('coo')).toBe(menuOf['LINKED:APPROVER'])
    expect(userMenu('receiver_con')).toBe(menuOf.LINKED)
    expect(userMenu('proc_officer')).toBe(menuOf['LINKED:PROCUREMENT'])
  })

  it('a RECEIVER role granted switches that member to LINKED:RECEIVER, through the event the grant handed to Inngest', async () => {
    const before = toInngest.length
    // The default sender: the outbox hands the event to Inngest (here, the list) right after the commit
    ok(await grantRole(adminAt(), { memberId: org.member.receiver_con!, role: 'RECEIVER' }, { idempotencyKey: randomUUID() }))
    const message = toInngest.slice(before).find((m) => m.name === 'bcs/member.role_granted')!
    expect(await lineRichMenuRun({ data: message.data }, jobStep)).toMatchObject({ status: 'APPLIED', users: 1 })
    expect(userMenu('receiver_con')).toBe(menuOf['LINKED:RECEIVER'])
  })

  it('a delegation that starts makes its delegate an approver, and LINE failing for a while is thrown for Inngest to retry', async () => {
    const now = new Date()
    const delegation = await prisma.delegation.create({
      data: { organizationId: org.organizationId, delegatorMemberId: org.member.dm_con!, delegateMemberId: org.member.proc_officer!, startsAt: new Date(now.getTime() - 60_000), endsAt: new Date(now.getTime() + 86_400_000), documentTypes: [], reason: 'ลาพักร้อน', status: 'ACTIVE', createdVia: 'SELF' },
    })
    const data = { organizationId: org.organizationId, aggregateId: delegation.id, type: 'delegation.started' }
    setLineClient(createLineClient({ apiBaseUrl: line.fake.url, dataApiBaseUrl: line.fake.url, fetch: async () => new Response('{"message":"busy"}', { status: 503, headers: { 'content-type': 'application/json' } }) }))
    try {
      await expect(lineRichMenuRun({ data }, jobStep)).rejects.toThrow()
    } finally {
      setLineClient(line.client)
    }
    expect(await lineRichMenuRun({ data }, jobStep)).toMatchObject({ status: 'APPLIED', users: 1 })
    expect(userMenu('proc_officer')).toBe(menuOf['LINKED:APPROVER:PROCUREMENT'])
    // Revoked: back to the menu of the role alone
    await prisma.delegation.update({ where: { id: delegation.id }, data: { status: 'REVOKED', revokedAt: new Date() } })
    await lineRichMenuRun({ data: { ...data, type: 'delegation.revoked' } }, jobStep)
    expect(userMenu('proc_officer')).toBe(menuOf['LINKED:PROCUREMENT'])
  })

  it('a workflow version in effect makes its reviewers approvers: vp_sup, the fallback of RV-01, switches with the version run', async () => {
    expect(userMenu('vp_sup')).toBe(menuOf['LINKED:APPROVER']) // VP is a DOA position already
    // A version whose only reviewer is named by MEMBER: req_con, nobody's approver in the DOA
    await seedWorkflow(org.organizationId, { code: `WF-${randomUUID().slice(0, 6)}`, rules: [{ code: 'RV-X1', requestTypeCodes: ['BUY_GOODS'], when: {}, reviewers: [{ kind: 'MEMBER', memberId: org.member.req_con! }], fallback: null, mode: 'ALL', quorumCount: null, slaBusinessMinutes: 480, sortOrder: 1, descriptionTh: null }] }, new Date())
    const version = await prisma.workflowVersion.findFirstOrThrow({ where: { organizationId: org.organizationId }, orderBy: { createdAt: 'desc' } })
    expect(await lineRichMenuRun({ data: { organizationId: org.organizationId, aggregateId: version.id, type: 'workflow_version.published' } }, jobStep)).toMatchObject({ status: 'APPLIED', users: 7 })
    expect(userMenu('req_con')).toBe(menuOf['LINKED:APPROVER'])
  })
})

describe('[FR-LINE-303/AC2] a version run never leaves the menu of an old state (review of S17-03)', () => {
  it('a member whose set changes while the bulk calls are on their way gets the menu of now, one by one', async () => {
    let changed = false
    const through: typeof fetch = async (input, init) => {
      if (!changed && String(input).endsWith('/v2/bot/richmenu/bulk/link')) {
        // A role granted (and switched by function line-rich-menu) after the run worked out its menus, before LINE got them
        changed = true
        await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.asst_con!, role: 'RECEIVER', grantedAt: new Date() } })
      }
      return fetch(input, init)
    }
    setLineClient(createLineClient({ apiBaseUrl: line.fake.url, dataApiBaseUrl: line.fake.url, fetch: through }))
    let run: Awaited<ReturnType<typeof syncLineRichMenusOf>>
    try {
      run = await syncLineRichMenusOf(org.organizationId, 'ALL')
    } finally {
      setLineClient(line.client)
    }
    expect(changed).toBe(true)
    expect(run).toMatchObject({ status: 'APPLIED', users: 7, resynced: 1 })
    expect(userMenu('asst_con')).toBe(menuOf['LINKED:APPROVER:RECEIVER'])
  })
})

describe('[FR-LINE-303/AC6] unlinked or deactivated: UNLINKED as before (FR-LINE-004 AC3)', () => {
  it('a deactivated member\'s link gets no menu of its own in a version run; an ended link is not touched', async () => {
    await prisma.member.update({ where: { id: org.member.coo! }, data: { status: 'DEACTIVATED' } })
    await prisma.channelIdentity.updateMany({ where: { organizationId: org.organizationId, memberId: org.member.dm_con! }, data: { unlinkedAt: new Date() } })
    const run = await syncLineRichMenusOf(org.organizationId, 'ALL')
    expect(run).toMatchObject({ status: 'APPLIED', users: 6 })
    expect(userMenu('coo')).toBeNull()
    // dm_con's ended link keeps what the unlink set; this run does not reach it
    expect(userMenu('dm_con')).toBe(menuOf['LINKED:APPROVER'])
  })

  it('a member event without a link, or of another type, changes nothing', async () => {
    expect(await lineRichMenuRun({ data: { organizationId: org.organizationId, aggregateId: org.member.ceo!, type: 'member.role_granted' } }, jobStep)).toMatchObject({ status: 'APPLIED', users: 0 })
    expect(await lineRichMenuRun({ data: { organizationId: org.organizationId, aggregateId: randomUUID(), type: 'request.submitted' } }, jobStep)).toEqual({ ignored: 'NOT_A_MENU_EVENT' })
    expect(handed('member.role_granted', org.member.receiver_con!)).toBeDefined()
  })
})
