import { randomUUID } from 'node:crypto'
import { createTranslator } from 'next-intl'
import { beforeAll, describe, expect, it } from 'vitest'
import { fund } from '@/core/budget'
import { applyBudget } from '@/server/budget/ledger'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { loadSeedForms } from '@/server/seed/forms'
import { seedWorkflow } from '@/server/seed/workflow'
import { homeApprovals, homeFollowing, homeTodo } from '@/server/services/home'
import type { HomeT } from '@/app/(workspace)/_tracking/home-present'
import type { ViewT } from '@/app/(workspace)/_tracking/present'
import type { TasksT } from '@/app/(workspace)/_tracking/rows'
import { liffApprovals, liffFollowingRows } from '@/app/liff/home/present'
import th from '../../messages/th.json'
import { workflowFixture } from '../golden/workflow-fixtures'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { createDraft, submitRequest } from '../support/requests'

// S17-02 · /liff/home (FR-LINE-302 · BR-LINE-18): the page calls the web home's services, so for every member it shows
// the numbers the web home shows them at the same moment (AC1) — checked here for members of several roles of the S6
// fixture organization, by the services as LIFF calls them (channel LIFF) against the web's (channel WEB). AC5: a
// contract work waiting for the DM of LEG, QSE and FIN at once (RV-03 to RV-05) is in "รอฉันอนุมัติ" of each of the
// three, as on their web home, each row opening that reviewer's own LIFF task page.

const NOW = new Date('2026-10-06T02:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const homeT = createTranslator({ locale: 'th', messages: th, namespace: 'home' }) as unknown as HomeT
const tasksT = createTranslator({ locale: 'th', messages: th, namespace: 'tasks' }) as unknown as TasksT
const viewT = createTranslator({ locale: 'th', messages: th, namespace: 'requestView' }) as unknown as ViewT

let org: DoaOrg
let requestId: string

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg({ fixtures: { org: 'fixtures/org-s6.yaml', versions: 'fixtures/doa-versions.yaml' } })
  const organizationId = org.organizationId
  const type = await prisma.requestType.create({ data: { organizationId, code: 'CONTRACT_WORK', nameTh: 'จ้างเหมา', documentType: 'PURCHASE_REQUEST' } })
  const form = await prisma.formVersion.create({ data: { organizationId, requestTypeId: type.id, versionNo: 1, schema: loadSeedForms().get('CONTRACT_WORK')! as object, status: 'PUBLISHED', publishedAt: NOW } })
  await prisma.requestType.update({ where: { id: type.id }, data: { currentFormVersionId: form.id } })
  const line = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId, departmentId: org.department.CON! } })
  const importId = randomUUID()
  await forTenant(organizationId).$transaction(async (tx) => {
    const ctx = systemCtx(organizationId, NOW, 'seed')
    const funded = await applyBudget(tx, ctx, [{ budgetLineId: line.id, document: { type: 'IMPORT' as const, id: importId }, run: (s) => fund(s, 10_000_000_000n, importId) }])
    if (!funded.ok) throw new Error(funded.error.code)
    await appendEvents(tx, ctx, funded.events)
  })
  const fixture = workflowFixture(['fixtures/workflow-versions.yaml']).versions[0]!
  await seedWorkflow(organizationId, { code: fixture.code, rules: fixture.rules.map((r) => ({ ...r, descriptionTh: null })) }, NOW)
  // pm_p07's contract work of 2,470,000.00 before VAT with the three quotations it needs, sent: LEG, QSE and FIN review it at once
  const draft = ok(
    await createDraft(
      org.ctxOf('req_con', NOW),
      { requestTypeCode: 'CONTRACT_WORK', title: 'งานเหมาก่อสร้างอาคารเก็บของ', formData: { scopeOfWork: 'ก่อสร้างอาคารเก็บของ 1 หลัง', milestones: '3 งวด', site: 'ไซต์ P07' }, lines: [{ description: 'งานเหมาก่อสร้าง', quantity: '1', uom: 'งาน', unitPrice: '2470000.00' }] },
      key(),
    ),
  )
  for (let i = 0; i < 3; i++) {
    const file = await prisma.fileObject.create({ data: { organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'q.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.req_con! } })
    await prisma.fileLink.create({ data: { organizationId, fileId: file.id, subjectType: 'Request', subjectId: draft.requestId, kind: 'QUOTATION' } })
  }
  ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
  requestId = draft.requestId
})

describe('[FR-LINE-302/AC1] the LIFF home shows what the web home shows the same member', () => {
  it('to do, waiting for my approval and following: the same numbers and rows on channel LIFF as on WEB, for members of several roles', async () => {
    const codes = ['req_con', 'dm_leg', 'dm_qse', 'dm_fin', 'ceo', 'dm_con'].filter((c) => org.member[c])
    expect(codes.length).toBeGreaterThanOrEqual(5)
    for (const code of codes) {
      const web = org.ctxOf(code, NOW, 'WEB')
      const liff = org.ctxOf(code, NOW, 'LIFF')
      expect(ok(await homeTodo(liff)), code).toEqual(ok(await homeTodo(web)))
      expect(ok(await homeApprovals(liff)), code).toEqual(ok(await homeApprovals(web)))
      expect(ok(await homeFollowing(liff)), code).toEqual(ok(await homeFollowing(web)))
    }
  })

  it('the requester follows the contract work, its row opening the request\'s LIFF page', async () => {
    const following = ok(await homeFollowing(org.ctxOf('req_con', NOW, 'LIFF')))
    const rows = liffFollowingRows(viewT, 'th', following)
    expect(rows.find((r) => r.id === requestId)).toMatchObject({ to: { href: `/liff/requests/${requestId}`, inLiff: true }, status: 'PENDING_APPROVAL' })
  })
})

describe('[FR-LINE-302/AC5] "รอฉันอนุมัติ" has the REVIEW tasks of S6, as the web home', () => {
  it('each of the three reviewers sees their own task of the contract work, opening their LIFF task page', async () => {
    const tasks = await prisma.approvalTask.findMany({ where: { organizationId: org.organizationId, status: 'OPEN', step: { route: { subjectId: requestId } } }, select: { id: true, assigneeMemberId: true } })
    expect(tasks).toHaveLength(3)
    for (const code of ['dm_leg', 'dm_qse', 'dm_fin']) {
      const own = tasks.find((t) => t.assigneeMemberId === org.member[code])!
      const approvals = ok(await homeApprovals(org.ctxOf(code, NOW, 'LIFF')))
      const view = liffApprovals(homeT, tasksT, viewT, 'th', approvals)
      expect(view.count, code).toBe(approvals.all.count)
      expect(view.rows.find((r) => r.id === own.id), code).toMatchObject({ href: `/liff/tasks/${own.id}` })
      // Only their own: the other reviewers' slots are not theirs to decide
      expect(view.rows.map((r) => r.id).filter((id) => id !== own.id && tasks.some((t) => t.id === id))).toEqual([])
    }
  })
})
