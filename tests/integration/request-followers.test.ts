import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { addOrRemoveFollower, cancelOwnRequest, followOrUnfollow } from '@/app/(workspace)/_tracking/commands'
import { prisma } from '@/server/db/client'
import { getRequestView, listMyRequests } from '@/server/queries/requests'
import { decideTask } from '@/server/services/approvals/decide'
import { cancelRequest, createDraft, editRequest, submitRequest } from '../support/requests'
import { attachFile } from '@/server/services/requests/attachments'
import { followRequest, getRequestFollowers, manageFollowers, MAX_FOLLOWERS } from '@/server/services/requests/followers'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S16-06 · NEW-29: followers of a request (FR-INT-013 AC1–AC3, §2.4 request.follow and request.followers.manage,
// §10.1 request.follower_added, §10.2) and what a follower sees (FR-INT-008 AC2), through the services and the commands
// behind the request page. Real Postgres (BCS_TEST_DB), an organization from the §7.4 fixtures. A request of req_con
// charged to CON is seen by req_con (OWN), its approver dm_con (ASSIGNED, and head of CON), vp_ops (head of OPS above
// CON) and proc_officer (PROCUREMENT, ORG) — not by asst_con or receiver_con, colleagues in CON with no role.
// Monday 5 Oct 2026 10:00 Thai time.

const NOW = new Date('2026-10-05T03:00:00Z')
const LATER = new Date('2026-10-05T05:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
})

async function draft(title = 'วัสดุสำนักงาน') {
  const made = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title, priceIncludesVat: true, lines: [{ description: 'กระดาษ', quantity: '1', uom: 'รีม', unitPrice: '10000.00' }] }, key())
  if (!made.ok) throw new Error(`draft failed: ${made.error.code}`)
  return made.data.requestId
}

async function submitted(title?: string) {
  const requestId = await draft(title)
  const sent = await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key())
  if (!sent.ok) throw new Error(`submit failed: ${sent.error.code}`)
  return requestId
}

/** n active AUDITOR members of FIN (they view every request), each following `requestId` when given */
async function auditors(n: number, requestId?: string) {
  const { primaryDepartmentId } = await prisma.member.findUniqueOrThrow({ where: { id: org.member.fin_officer! } })
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = randomUUID()
    await prisma.member.create({ data: { id, organizationId: org.organizationId, displayNameTh: 'ผู้ตรวจ', email: `${id}@test.bcs.local`, status: 'ACTIVE', primaryDepartmentId } })
    await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: id, role: 'AUDITOR', grantedAt: NOW } })
    if (requestId) await prisma.requestFollower.create({ data: { organizationId: org.organizationId, requestId, memberId: id } })
    ids.push(id)
  }
  return ids
}

const followerIds = async (requestId: string) => (await prisma.requestFollower.findMany({ where: { requestId }, select: { memberId: true }, orderBy: { createdAt: 'asc' } })).map((f) => f.memberId)
const eventsOf = async (requestId: string, type: string) => prisma.event.findMany({ where: { aggregateId: requestId, type }, select: { data: true, actorMemberId: true }, orderBy: { seq: 'asc' } })
const noticesTo = async (code: string, requestId: string, templateKey: string) => prisma.notification.findMany({ where: { recipientMemberId: org.member[code]!, subjectId: requestId, templateKey } })

describe('[FR-INT-013/AC1] whoever views the request follows it themselves; only the requester adds members who already view it', () => {
  it('a head of the department follows and stops following, each with an event and no notice', async () => {
    const requestId = await submitted()
    expect(await followRequest(org.ctxOf('vp_ops', NOW), { requestId, follow: true }, key())).toMatchObject({ ok: true, data: { following: true } })
    expect(await followerIds(requestId)).toEqual([org.member.vp_ops])
    expect(await followRequest(org.ctxOf('vp_ops', NOW), { requestId, follow: true }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'ALREADY_FOLLOWING' } } })
    expect(await followRequest(org.ctxOf('vp_ops', NOW), { requestId, follow: false }, key())).toMatchObject({ ok: true, data: { following: false } })
    expect(await followerIds(requestId)).toEqual([])
    expect(await eventsOf(requestId, 'request.follower_added')).toEqual([{ data: { memberId: org.member.vp_ops, by: 'SELF' }, actorMemberId: org.member.vp_ops }])
    expect(await eventsOf(requestId, 'request.follower_removed')).toEqual([{ data: { memberId: org.member.vp_ops, by: 'SELF' }, actorMemberId: org.member.vp_ops }])
    expect(await noticesTo('vp_ops', requestId, 'request.follower_added')).toEqual([])
  })

  it('refuses a member who cannot view the request, and the requester following their own request', async () => {
    const requestId = await submitted()
    expect(await followRequest(org.ctxOf('asst_con', NOW), { requestId, follow: true }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await followRequest(org.ctxOf('req_con', NOW), { requestId, follow: true }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'REQUESTER' } } })
    expect(await followerIds(requestId)).toEqual([])
    expect(await eventsOf(requestId, 'request.follower_added')).toEqual([])
  })

  it('the requester adds a member who views the request; that member is told; the requester removes them', async () => {
    const requestId = await submitted('กล่องเอกสาร')
    expect(await manageFollowers(org.ctxOf('req_con', NOW), { requestId, memberId: org.member.proc_officer!, follow: true }, key())).toMatchObject({ ok: true })
    expect(await followerIds(requestId)).toEqual([org.member.proc_officer])
    expect(await eventsOf(requestId, 'request.follower_added')).toEqual([{ data: { memberId: org.member.proc_officer, by: 'REQUESTER' }, actorMemberId: org.member.req_con }])
    const [notice] = await noticesTo('proc_officer', requestId, 'request.follower_added')
    expect(notice).toMatchObject({ urgency: 'IMMEDIATE', subjectType: 'REQUEST', data: { requestId, title: 'กล่องเอกสาร' } })

    expect(await manageFollowers(org.ctxOf('req_con', LATER), { requestId, memberId: org.member.proc_officer!, follow: false }, key())).toMatchObject({ ok: true })
    expect(await followerIds(requestId)).toEqual([])
    expect(await eventsOf(requestId, 'request.follower_removed')).toEqual([{ data: { memberId: org.member.proc_officer, by: 'REQUESTER' }, actorMemberId: org.member.req_con }])
    expect(await manageFollowers(org.ctxOf('req_con', LATER), { requestId, memberId: org.member.proc_officer!, follow: false }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'NOT_FOLLOWING' } } })
  })

  it('[OQ-39] refuses to add a member who does not view the request already, so following never widens who sees it', async () => {
    const requestId = await submitted()
    for (const code of ['asst_con', 'receiver_con', 'dm_fin']) {
      expect(await manageFollowers(org.ctxOf('req_con', NOW), { requestId, memberId: org.member[code]!, follow: true }, key()), code).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'CANNOT_VIEW' } } })
    }
    expect(await manageFollowers(org.ctxOf('req_con', NOW), { requestId, memberId: org.member.req_con!, follow: true }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'REQUESTER' } } })
    expect(await followerIds(requestId)).toEqual([])
  })

  it('offers the requester only the active members who view the request, and nobody else a list', async () => {
    const requestId = await submitted()
    ok(await manageFollowers(org.ctxOf('req_con', NOW), { requestId, memberId: org.member.dm_con!, follow: true }, key()))
    const mine = await getRequestFollowers(org.ctxOf('req_con', NOW), requestId)
    expect(mine).toMatchObject({ canManage: true, canFollow: false, following: false })
    expect(mine!.followers.map((f) => f.id)).toEqual([org.member.dm_con])
    const offered = mine!.candidates.map((c) => c.id)
    expect(offered).toEqual(expect.arrayContaining([org.member.vp_ops, org.member.proc_officer]))
    for (const code of ['req_con', 'dm_con', 'asst_con', 'receiver_con', 'dm_fin', 'fin_officer']) expect(offered, code).not.toContain(org.member[code])

    const head = await getRequestFollowers(org.ctxOf('vp_ops', NOW), requestId)
    expect(head).toMatchObject({ canManage: false, canFollow: true, following: false, unfollowEndsAccess: false, candidates: [] })
    expect(await getRequestFollowers(org.ctxOf('dm_con', NOW), requestId)).toMatchObject({ following: true, unfollowEndsAccess: false })
    expect(await getRequestFollowers(org.ctxOf('asst_con', NOW), requestId)).toBeNull()
  })

  it('caps the followers of one request', async () => {
    const requestId = await submitted()
    await auditors(MAX_FOLLOWERS, requestId)
    expect(await followRequest(org.ctxOf('vp_ops', NOW), { requestId, follow: true }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'TOO_MANY' } } })
    expect(await manageFollowers(org.ctxOf('req_con', NOW), { requestId, memberId: org.member.proc_officer!, follow: true }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'TOO_MANY' } } })
  })
})

describe('[FR-INT-013/AC1] the cap holds when members follow at the same moment', () => {
  it('lets one of two simultaneous follows take the last place and refuses the other', async () => {
    const requestId = await submitted()
    await auditors(MAX_FOLLOWERS - 1, requestId)
    const results = await Promise.all([
      followRequest(org.ctxOf('vp_ops', NOW), { requestId, follow: true }, key()),
      followRequest(org.ctxOf('proc_officer', NOW), { requestId, follow: true }, key()),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok)).toMatchObject([{ error: { code: 'VALIDATION_FAILED', details: { reason: 'TOO_MANY' } } }])
    expect(await prisma.requestFollower.count({ where: { requestId } })).toBe(MAX_FOLLOWERS)
  })
})

describe('[FR-INT-013/AC2] followers are told with the requester; the member added is told; the request is in their list', () => {
  it('approval, return and rejection reach the followers, never the member who decided', async () => {
    const approved = await submitted('อนุมัติ')
    const returned = await submitted('ตีกลับ')
    const rejected = await submitted('ไม่อนุมัติ')
    for (const requestId of [approved, returned, rejected]) {
      ok(await manageFollowers(org.ctxOf('req_con', NOW), { requestId, memberId: org.member.vp_ops!, follow: true }, key()))
      ok(await followRequest(org.ctxOf('dm_con', NOW), { requestId, follow: true }, key())) // the approver follows too
    }
    const decide = async (requestId: string, decision: 'APPROVE' | 'RETURN' | 'REJECT') => {
      const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: requestId } } } })
      ok(await decideTask(org.ctxOf('dm_con', LATER), { taskId: task.id, decision, ...(decision === 'APPROVE' ? {} : { reason: 'ขอใบเสนอราคาเพิ่ม' }) }, key()))
    }
    await decide(approved, 'APPROVE')
    await decide(returned, 'RETURN')
    await decide(rejected, 'REJECT')
    expect((await prisma.request.findUniqueOrThrow({ where: { id: approved } })).status).toBe('APPROVED')

    for (const code of ['req_con', 'vp_ops']) {
      expect(await noticesTo(code, approved, 'request.approved'), code).toHaveLength(1)
      expect((await noticesTo(code, returned, 'request.decided'))[0], code).toMatchObject({ urgency: 'IMMEDIATE', data: { decision: 'RETURN' } })
      expect((await noticesTo(code, rejected, 'request.decided'))[0], code).toMatchObject({ data: { decision: 'REJECT' } })
    }
    expect((await noticesTo('vp_ops', approved, 'request.approved'))[0]!.data).toMatchObject({ asFollower: true })
    // dm_con follows but decided it: not told of their own decision
    for (const [requestId, template] of [[approved, 'request.approved'], [returned, 'request.decided'], [rejected, 'request.decided']] as const) expect(await noticesTo('dm_con', requestId, template)).toEqual([])
  })

  it('a follower who is no longer active, or may no longer view the request, is not told', async () => {
    const requestId = await submitted('ผู้ติดตามที่ออกไปแล้ว')
    const [gone, roleless] = await auditors(2, requestId)
    await prisma.member.update({ where: { id: gone! }, data: { status: 'DEACTIVATED' } })
    await prisma.roleAssignment.updateMany({ where: { memberId: roleless! }, data: { revokedAt: NOW } })
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: requestId } } } })
    ok(await decideTask(org.ctxOf('dm_con', LATER), { taskId: task.id, decision: 'REJECT', reason: 'ขอใบเสนอราคาเพิ่ม' }, key()))
    const told = await prisma.notification.findMany({ where: { subjectId: requestId, templateKey: 'request.decided' }, select: { recipientMemberId: true } })
    // the roleless one still follows, and §2.4 counts a follower as OWN for request.view (NEW-74): told as a viewer
    expect(told.map((n) => n.recipientMemberId).sort()).toEqual([org.member.req_con!, roleless!].sort())
  })

  it('[FR-INT-008/AC2] a follower added through the service sees the same status and current step as the requester, and lists it as followed', async () => {
    const requestId = await submitted('ถุงมือนิรภัย')
    ok(await manageFollowers(org.ctxOf('req_con', NOW), { requestId, memberId: org.member.proc_officer!, follow: true }, key()))
    const follower = await getRequestView(org.ctxOf('proc_officer', LATER), requestId)
    const requester = await getRequestView(org.ctxOf('req_con', LATER), requestId)
    expect(follower!.status).toBe('PENDING_APPROVAL')
    expect(follower!.stage).toEqual(requester!.stage)
    expect(follower!.track.filter((t) => t.state !== 'done')).toEqual(requester!.track.filter((t) => t.state !== 'done'))
    const row = (await listMyRequests(org.ctxOf('proc_officer', LATER))).rows.find((r) => r.id === requestId)
    expect(row).toMatchObject({ relation: 'FOLLOWER', status: 'PENDING_APPROVAL', stage: requester!.stage })
  })
})

describe('[FR-INT-013/AC3] a follower who is not the requester never sends, edits, cancels or adds followers', () => {
  it('refuses every command of the requester to a follower whose only tie to the request is following it', async () => {
    // asst_con follows while PROCUREMENT (so they view it), then loses the role: following is now their only tie (OWN)
    const requestId = await draft('ร่างที่ติดตาม')
    const role = await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.asst_con!, role: 'PROCUREMENT', grantedAt: NOW } })
    ok(await followRequest(org.ctxOf('asst_con', NOW), { requestId, follow: true }, key()))
    await prisma.roleAssignment.update({ where: { id: role.id }, data: { revokedAt: NOW } })
    const asFollower = org.ctxOf('asst_con', LATER)
    const before = await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { status: true, version: true, title: true } })

    expect(await editRequest(asFollower, { requestId, title: 'แก้โดยผู้ติดตาม', priceIncludesVat: true, lines: [{ description: 'กระดาษ', quantity: '2', uom: 'รีม', unitPrice: '10000.00' }] }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await submitRequest(asFollower, { requestId }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await cancelRequest(asFollower, { requestId, reason: 'ไม่ใช้แล้ว' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await attachFile(asFollower, { requestId, fileId: randomUUID(), kind: 'QUOTATION' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await manageFollowers(asFollower, { requestId, memberId: org.member.dm_con!, follow: true }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await manageFollowers(asFollower, { requestId, memberId: org.member.asst_con!, follow: false }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // …and the page's commands refuse the same
    expect(await cancelOwnRequest(asFollower, { requestId, reason: 'ไม่ใช้แล้ว' }, randomUUID())).toEqual({ ok: false, code: 'FORBIDDEN' })
    expect(await addOrRemoveFollower(asFollower, { requestId, memberId: org.member.dm_con!, follow: true }, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })

    expect(await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { status: true, version: true, title: true } })).toEqual(before)
    // a malformed call names the field that is wrong
    expect(await addOrRemoveFollower(asFollower, { requestId: 'x', memberId: org.member.dm_con!, follow: true }, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'requestId' })
    expect(await followOrUnfollow(asFollower, { requestId, follow: 'yes' }, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'follow' })
    expect(await followerIds(requestId)).toEqual([org.member.asst_con])
    // They still see it and may stop following it themselves
    // …and the page asks before they stop, because stopping ends their access; someone with access of their own is not asked
    expect(await getRequestFollowers(asFollower, requestId)).toMatchObject({ following: true, canFollow: true, canManage: false, unfollowEndsAccess: true })
    expect(await followOrUnfollow(asFollower, { requestId, follow: false }, randomUUID())).toEqual({ ok: true })
    expect(await followerIds(requestId)).toEqual([])
  })
})

function ok<T extends { ok: boolean }>(result: T): T {
  if (!result.ok) throw new Error(`expected ok: ${JSON.stringify(result)}`)
  return result
}
