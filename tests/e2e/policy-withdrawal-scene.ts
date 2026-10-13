import { randomUUID } from 'node:crypto'
import { fund } from '@/core/budget'
import { applyBudget } from '@/server/budget/ledger'
import { makeCtx, systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { seedTaxRates } from '@/server/seed/tax-rates'
import { createDraft, submitRequest } from '@/server/services/requests'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/policy-withdrawal.spec.ts against the e2e database only (S6-07 · FR-DOA-103 · FR-DOA-104 ·
// FR-WF-103 · BR-WF-13), on an organization admin-workflows-scene.ts built (its own per run: version 1 of the
// workflow in effect, the CEO approving DOA_CHANGE). It adds, as local e2e data only (never a customer's):
//   - a budget of 10,000,000.00 baht per department, and two purchase requests rattana (req_con) sent now: a cutter of
//     25,000.00 before VAT and gloves of 500.00 — version 1 sends both straight to the DOA approver;
//   - version 2 of the workflow, the same rules as version 1, approved by the CEO and PUBLISHED for a date 20 days
//     ahead (version 1 then ends there): the version the second admin asks to withdraw;
//   - version 3, a DRAFT that adds RV-10 (purchases above 10,000.00 VAT included are reviewed by the DM of LEG): its
//     backtest moves the cutter to that reviewer and leaves the gloves alone (one task more for the DM of LEG).
//   extras <org code>   → prints the ids of versions 2 and 3, version 2's date, and the requests' numbers
// Prints JSON on the last line.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the withdrawal scene runs in the e2e database only')

const [mode = 'extras', orgCode = ''] = process.argv.slice(2)
const now = new Date()
const DAY_MS = 24 * 60 * 60 * 1000
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

async function extras(code: string) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { code }, select: { id: true } })
  const organizationId = org.id
  const memberOf = async (suffix: string) => (await prisma.member.findFirstOrThrow({ where: { organizationId, employeeCode: { endsWith: `_${suffix}` } }, select: { id: true } })).id
  const [requester, admin, ceo] = await Promise.all([memberOf('req_con'), memberOf('admin2'), memberOf('ceo')])

  // FY2569 with 10,000,000.00 baht on one line per department, so the requests can be sent
  await seedTaxRates()
  const departments = await prisma.department.findMany({ where: { organizationId }, select: { id: true, code: true } })
  const fiscalYear = await prisma.fiscalYear.create({ data: { organizationId, code: 'FY2569', startsOn: new Date('2026-01-01T00:00:00Z'), endsOn: new Date('2026-12-31T00:00:00Z') } })
  const lines: string[] = []
  for (const d of departments) {
    const costCenter = await prisma.costCenter.create({ data: { organizationId, code: `CC-${d.code}`, nameTh: `ศูนย์ต้นทุน ${d.code}`, departmentId: d.id } })
    const line = await prisma.budgetLine.create({ data: { organizationId, fiscalYearId: fiscalYear.id, departmentId: d.id, costCenterId: costCenter.id, code: `${d.code}-OPEX-2569`, nameTh: `ค่าใช้จ่ายดำเนินงาน ${d.code}`, plannedSatang: 0n } })
    await prisma.budgetLineBalance.create({ data: { organizationId, budgetLineId: line.id } })
    lines.push(line.id)
  }
  const importId = randomUUID()
  await forTenant(organizationId).$transaction(async (tx) => {
    const ctx = systemCtx(organizationId, new Date('2026-01-01T00:00:00Z'), 'seed')
    const funded = await applyBudget(tx, ctx, lines.map((id) => ({ budgetLineId: id, document: { type: 'IMPORT' as const, id: importId }, run: (s) => fund(s, 1_000_000_000n, importId) })))
    if (!funded.ok) throw new Error(`funding failed: ${funded.error.code}`)
    await appendEvents(tx, ctx, funded.events)
  })

  // Two purchase requests sent now, through the services
  const ctx = makeCtx({ organizationId, actor: { type: 'USER', memberId: requester }, channel: 'WEB', now })
  const numbers: string[] = []
  for (const [title, price] of [
    ['เครื่องตัดคอนกรีต', '25000.00'],
    ['ถุงมือผ้า', '500.00'],
  ] as const) {
    const draft = await createDraft(ctx, { requestTypeCode: 'BUY_GOODS', title, lines: [{ description: title, quantity: '1', uom: 'ชุด', unitPrice: price }] }, key())
    if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft.error)}`)
    const sent = await submitRequest(ctx, { requestId: draft.data.requestId }, key())
    if (!sent.ok) throw new Error(`submit failed: ${JSON.stringify(sent.error)}`)
    numbers.push(sent.data.number ?? title)
  }

  // Version 2: version 1's rules, approved by the CEO for a date 20 days ahead (Thai midnight); version 1 ends there
  const v1 = await prisma.workflowVersion.findFirstOrThrow({ where: { organizationId, versionNo: 1 }, include: { rules: true } })
  const ahead = new Date(now.getTime() + 20 * DAY_MS)
  ahead.setUTCHours(17, 0, 0, 0)
  await prisma.workflowVersion.update({ where: { id: v1.id }, data: { effectiveTo: ahead } })
  const copyRules = async (versionId: string) => {
    for (const r of v1.rules) {
      await prisma.workflowRule.create({
        data: {
          organizationId,
          workflowVersionId: versionId,
          code: r.code,
          requestTypeCodes: r.requestTypeCodes,
          when: r.when as object,
          reviewers: r.reviewers as object,
          ...(r.fallback ? { fallback: r.fallback as object } : {}),
          mode: r.mode,
          quorumCount: r.quorumCount,
          slaBusinessMinutes: r.slaBusinessMinutes,
          descriptionTh: r.descriptionTh,
          sortOrder: r.sortOrder,
        },
      })
    }
  }
  const v2 = await prisma.workflowVersion.create({
    data: {
      organizationId,
      code: v1.code,
      versionNo: 2,
      status: 'PUBLISHED',
      effectiveFrom: ahead,
      changeReason: 'ปรับผู้ตรวจตามโครงสร้างใหม่',
      submittedById: admin,
      submittedAt: new Date(now.getTime() - 2 * DAY_MS),
      approvedById: ceo,
      approvedAt: new Date(now.getTime() - DAY_MS),
      publishedAt: new Date(now.getTime() - DAY_MS),
    },
    select: { id: true },
  })
  await copyRules(v2.id)

  // Version 3: a draft with RV-10 — purchases above 10,000.00 VAT included are reviewed by the DM of LEG
  const v3 = await prisma.workflowVersion.create({
    data: { organizationId, code: v1.code, versionNo: 3, status: 'DRAFT', effectiveFrom: new Date(ahead.getTime() + 31 * DAY_MS), changeReason: 'เพิ่มผู้ตรวจของการซื้อเกิน 10,000 บาท' },
    select: { id: true },
  })
  await copyRules(v3.id)
  await prisma.workflowRule.create({
    data: {
      organizationId,
      workflowVersionId: v3.id,
      code: 'RV-10',
      requestTypeCodes: ['BUY_GOODS'],
      when: { field: '$amountGross', op: 'gt', value: '10000.00' },
      reviewers: [{ kind: 'POSITION_AT', position: 'DM', department: 'LEG' }],
      fallback: { kind: 'POSITION_AT', position: 'VP', department: 'SUP' },
      mode: 'ALL',
      quorumCount: null,
      slaBusinessMinutes: 480,
      descriptionTh: null,
      sortOrder: v1.rules.length,
    },
  })
  return { v2: v2.id, v3: v3.id, aheadAt: ahead.toISOString(), requests: numbers }
}

if (mode !== 'extras') throw new Error(`unknown mode ${mode}`)
console.log(JSON.stringify(await extras(orgCode)))
await prisma.$disconnect()
