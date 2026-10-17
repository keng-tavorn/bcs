import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { fund } from '@/core/budget'
import { applyBudget } from '@/server/budget/ledger'
import { makeCtx, systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { decideByActionLink, viewActionLink } from '@/server/services/approvals/action-link'
import { decideByLinePostback } from '@/server/services/approvals/line-postback'
import { saveLineChannelSettings } from '@/server/services/line-channel'
import { loadSeedForms } from '@/server/seed/forms'
import { seedWorkflow } from '@/server/seed/workflow'
import { emailLinkSecret } from '@/server/tokens/action-tokens'
import { newLineUserId } from '../../scripts/line-simulate'
import { workflowFixture } from '../golden/workflow-fixtures'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET, withFakeLine } from '../support/fake-line'
import { createDraft, submitRequest } from '../support/requests'

// BR-WF-09 (ADR-073 pre-review): a reviewer needs no step-up whatever the amount — on the web and in LIFF as before,
// and now also from the chat button and the e-mail link, which asked src/core/pin without the step's kind and refused
// a reviewer's pass on a request at or above the version's stepUpThreshold (100,000.00 here). The S6 fixture with the
// reviewers of workflow-versions.yaml: a contract work of 2,470,000.00 goes to the DM of LEG, QSE and FIN at once.

const NOW = new Date('2026-10-06T02:00:00Z')
const LATER = new Date('2026-10-06T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const PROVIDER = '1650000201'
const CHANNEL = { providerId: PROVIDER, messagingChannelId: '1650000202', channelSecret: TEST_CHANNEL_SECRET, channelAccessToken: TEST_ACCESS_TOKEN, liffId: '1650000203-AbCdEfGh', liffChannelId: '1650000203' }

withFakeLine()
let org: DoaOrg

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg({ fixtures: { org: 'fixtures/org-s6.yaml', versions: 'fixtures/doa-versions.yaml' } })
  const organizationId = org.organizationId
  const type = await prisma.requestType.create({ data: { organizationId, code: 'CONTRACT_WORK', nameTh: 'จ้างเหมา', documentType: 'PURCHASE_REQUEST' } })
  const form = await prisma.formVersion.create({ data: { organizationId, requestTypeId: type.id, versionNo: 1, schema: loadSeedForms().get('CONTRACT_WORK')! as object, status: 'PUBLISHED', publishedAt: NOW } })
  await prisma.requestType.update({ where: { id: type.id }, data: { currentFormVersionId: form.id } })
  await prisma.roleAssignment.create({ data: { organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
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
  await saveLineChannelSettings(org.ctxOf('admin', NOW), { ...CHANNEL, active: true }, key())
  await prisma.channelIdentity.create({ data: { organizationId, memberId: org.member.dm_leg!, channel: 'LINE', providerKey: PROVIDER, externalUserId: newLineUserId(), linkedAt: NOW } })
})

async function contractWork() {
  const draft = ok(
    await createDraft(
      org.ctxOf('req_con', NOW),
      { requestTypeCode: 'CONTRACT_WORK', title: 'งานเหมาก่อสร้างอาคารเก็บของ', formData: { scopeOfWork: 'ก่อสร้างอาคารเก็บของ 1 หลัง', milestones: '3 งวด', site: 'ไซต์ P07' }, lines: [{ description: 'งานเหมาก่อสร้าง', quantity: '1', uom: 'งาน', unitPrice: '2470000.00' }] },
      key(),
    ),
  )
  for (let i = 0; i < 3; i++) {
    const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'q.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.req_con! } })
    await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, subjectType: 'Request', subjectId: draft.requestId, kind: 'QUOTATION' } })
  }
  ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
  return draft.requestId
}

describe('[BR-WF-09] a reviewer passes from the chat button and the e-mail link, whatever the amount', () => {
  it('the DM of LEG passes from LINE and the DM of QSE from the e-mail link of a 2,642,900.00 contract work, without a PIN', async () => {
    const requestId = await contractWork()
    const tasks = await prisma.approvalTask.findMany({ where: { status: 'OPEN', step: { kind: 'REVIEW', route: { subjectId: requestId } } } })
    const of = (code: string) => tasks.find((t) => t.assigneeMemberId === org.member[code])!

    const lineToken = await prisma.actionToken.findFirstOrThrow({ where: { taskId: of('dm_leg').id, channel: 'LINE' } })
    const lineCtx = makeCtx({ organizationId: org.organizationId, actor: { type: 'USER', memberId: org.member.dm_leg! }, channel: 'LINE_CHAT', now: LATER })
    expect(await decideByLinePostback(lineCtx, { tokenId: lineToken.id }, key())).toMatchObject({ ok: true })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: of('dm_leg').id } })).toMatchObject({ status: 'APPROVED', channel: 'LINE_CHAT' })

    const emailToken = await prisma.actionToken.findFirstOrThrow({ where: { taskId: of('dm_qse').id, channel: 'EMAIL' } })
    const link = `${emailToken.id}.${emailLinkSecret(emailToken.id)}`
    const emailCtx = org.ctxOf('dm_qse', LATER, 'EMAIL')
    expect(ok(await viewActionLink(emailCtx, link))).toMatchObject({ state: 'OPEN', inWorkspaceOnly: false })
    expect(await decideByActionLink(emailCtx, { link, decision: 'APPROVE' }, key())).toMatchObject({ ok: true })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: of('dm_qse').id } })).toMatchObject({ status: 'APPROVED' })
  })
})
