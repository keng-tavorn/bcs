import { randomUUID } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import { toJsonSafe } from '@/lib/json'
import { OrgSettingsSchema } from '@/lib/org-settings'
import { fund } from '@/core/budget'
import { makeCtx, systemCtx, type Ctx } from '@/server/context'
import { applyBudget } from '@/server/budget/ledger'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { prisma } from '@/server/db/client'
import { ruleJson } from '@/server/doa/snapshot'
import { loadOrgSettingsYaml } from '@/server/seed/demo-org'
import { loadSeedForms } from '@/server/seed/forms'
import { seedTaxRates } from '@/server/seed/tax-rates'
import { loadYaml, versionSnapshots } from '../golden/doa-fixtures'

// An organization built from the §7.4 fixtures for service tests: the departments and position holders of
// org-demo.yaml, DOA version 1 of doa-versions.yaml as PUBLISHED, the demo settings (calendar, numbering), the VAT
// rates, a BUY_GOODS request type with a published form that carries the ATT-QUOTES rule of forms.yaml, and the
// HIRE_SERVICE and IT_PURCHASE types with the forms of prisma/seed/forms.yaml.

interface OrgFixture {
  departments: Array<{ code: string; nameTh: string; parent: string | null }>
  positions: Array<{ position: string; department: string; member: string }>
  members: Record<string, string>
}

export interface DoaOrg {
  readonly organizationId: string
  readonly member: Readonly<Record<string, string>>
  readonly department: Readonly<Record<string, string>>
  readonly ctxOf: (code: string, now: Date, channel?: Ctx['channel']) => Ctx
}

const FORM_SCHEMA = {
  fields: [{ id: 'singleSourceJustification', type: 'textarea' }],
  visibility: [],
  rules: [
    {
      id: 'ATT-QUOTES',
      when: { field: '$amountGross', op: 'gt', value: '100000.00' },
      require: { any: [{ attachments: 'QUOTATION', min: 3 }, { all: [{ attachments: 'QUOTATION', min: 1 }, { field: 'singleSourceJustification', op: 'notEmpty' }] }] },
    },
  ],
}

/** options.doa false: no DOA version yet, as before an organization's initial package (BR-DOA-19) */
export async function createDoaOrg(options: { doa?: boolean } = {}): Promise<DoaOrg> {
  await seedTaxRates()
  const fixture = loadYaml<OrgFixture>('fixtures/org-demo.yaml')
  const settings = OrgSettingsSchema.parse(parseYaml(loadOrgSettingsYaml()))
  const org = await prisma.organization.create({
    data: { code: `D-${randomUUID().slice(0, 8)}`, legalNameTh: 'องค์กรทดสอบ DOA', taxId: '0999999000055', timezone: 'Asia/Bangkok', settings: toJsonSafe(settings) as object },
  })
  const organizationId = org.id

  const department: Record<string, string> = {}
  const pending = [...fixture.departments]
  while (pending.length) {
    const next = pending.findIndex((d) => d.parent === null || department[d.parent])
    const d = pending.splice(next, 1)[0]!
    department[d.code] = (await prisma.department.create({ data: { organizationId, code: d.code, nameTh: d.nameTh, parentId: d.parent ? department[d.parent]! : null, kind: d.parent ? 'DEPARTMENT' : 'COMPANY' } })).id
  }

  const member: Record<string, string> = {}
  for (const [code, dept] of Object.entries(fixture.members)) {
    member[code] = (
      await prisma.member.create({
        data: { organizationId, displayNameTh: `ผู้ใช้ ${code}`, email: `${code}-${randomUUID()}@test.bcs.local`, employeeCode: code, status: 'ACTIVE', primaryDepartmentId: department[dept]! },
      })
    ).id
  }

  const position: Record<string, string> = {}
  for (const p of fixture.positions) {
    position[p.position] ??= (await prisma.position.create({ data: { organizationId, code: p.position, nameTh: p.position, scope: p.department === 'HQ' ? 'ORG' : 'DEPARTMENT' } })).id
    await prisma.positionAssignment.create({
      data: { organizationId, positionId: position[p.position]!, departmentId: department[p.department]!, memberId: member[p.member]!, validFrom: new Date('2026-01-01T00:00:00+07:00') },
    })
  }

  const v1 = versionSnapshots().find((v) => v.versionNo === 1)!
  if (options.doa !== false) await publishVersion1(organizationId, v1)

  const type = await prisma.requestType.create({ data: { organizationId, code: 'BUY_GOODS', nameTh: 'ซื้อของ', documentType: 'PURCHASE_REQUEST' } })
  const form = await prisma.formVersion.create({ data: { organizationId, requestTypeId: type.id, versionNo: 1, schema: FORM_SCHEMA, status: 'PUBLISHED', publishedAt: v1.effectiveFrom } })
  await prisma.requestType.update({ where: { id: type.id }, data: { currentFormVersionId: form.id } })
  const supplierType = await prisma.requestType.create({ data: { organizationId, code: 'NEW_SUPPLIER', nameTh: 'ขอเพิ่มผู้ขายรายใหม่', documentType: 'SUPPLIER_REQUEST' } })
  const supplierForm = await prisma.formVersion.create({
    data: {
      organizationId,
      requestTypeId: supplierType.id,
      versionNo: 1,
      schema: { fields: [{ id: 'supplierName', type: 'text', required: true }], visibility: [], rules: [] },
      status: 'PUBLISHED',
      publishedAt: v1.effectiveFrom,
    },
  })
  await prisma.requestType.update({ where: { id: supplierType.id }, data: { currentFormVersionId: supplierForm.id } })
  // The service and IT types with the forms the demo seeds (prisma/seed/forms.yaml): screening questions and ATT-DPA
  const seedForms = loadSeedForms()
  for (const [code, nameTh] of [['HIRE_SERVICE', 'จ้างบริการ'], ['IT_PURCHASE', 'ซื้ออุปกรณ์/ซอฟต์แวร์ไอที']] as const) {
    const t = await prisma.requestType.create({ data: { organizationId, code, nameTh, documentType: 'PURCHASE_REQUEST' } })
    const f = await prisma.formVersion.create({ data: { organizationId, requestTypeId: t.id, versionNo: 1, schema: seedForms.get(code)! as object, status: 'PUBLISHED', publishedAt: v1.effectiveFrom } })
    await prisma.requestType.update({ where: { id: t.id }, data: { currentFormVersionId: f.id } })
  }
  await prisma.roleAssignment.create({ data: { organizationId, memberId: member.proc_officer!, role: 'PROCUREMENT', grantedAt: v1.effectiveFrom } })
  await prisma.holiday.createMany({ data: ['2026-10-13', '2026-10-23'].map((d) => ({ organizationId, date: new Date(`${d}T00:00:00Z`), nameTh: 'วันหยุด' })) })
  await fundEveryDepartment(organizationId, department)

  return {
    organizationId,
    member,
    department,
    ctxOf: (code, now, channel = 'WEB') => makeCtx({ organizationId, actor: { type: 'USER', memberId: member[code]! }, channel, now }),
  }
}

async function publishVersion1(organizationId: string, v1: ReturnType<typeof versionSnapshots>[number]) {
  const version = await prisma.doaVersion.create({
    data: {
      organizationId,
      code: v1.code,
      versionNo: 1,
      status: 'PUBLISHED',
      effectiveFrom: v1.effectiveFrom,
      amountBasis: v1.amountBasis,
      selfApprovalPolicy: v1.selfApprovalPolicy,
      collapseDuplicateApprovers: v1.collapseDuplicateApprovers,
      stepUpThresholdSatang: 10_000_000n,
      escalationPolicy: { remindPct: 0.5, escalateAfterBusinessHours: 8 },
      sodPolicy: { approverMayReceive: false, requesterMayReceive: true },
      publishedAt: v1.effectiveFrom,
    },
  })
  for (const rule of v1.rules) {
    const json = ruleJson(rule)
    await prisma.doaRule.create({ data: { organizationId, doaVersionId: version.id, code: rule.code, documentType: json.documentType, priority: rule.priority, when: json.when, steps: json.steps } })
  }
}

/** FY2569 with one open budget line of 10,000,000.00 baht per department, so a request finds its line (S3-05) */
async function fundEveryDepartment(organizationId: string, department: Record<string, string>) {
  const fiscalYear = await prisma.fiscalYear.create({ data: { organizationId, code: 'FY2569', startsOn: new Date('2026-01-01T00:00:00Z'), endsOn: new Date('2026-12-31T00:00:00Z') } })
  const lines: string[] = []
  for (const [code, departmentId] of Object.entries(department)) {
    const costCenter = await prisma.costCenter.create({ data: { organizationId, code: `CC-${code}`, nameTh: `ศูนย์ต้นทุน ${code}`, departmentId } })
    const line = await prisma.budgetLine.create({ data: { organizationId, fiscalYearId: fiscalYear.id, departmentId, costCenterId: costCenter.id, code: `${code}-OPEX-2569`, nameTh: `ค่าใช้จ่ายดำเนินงาน ${code}`, plannedSatang: 0n } })
    await prisma.budgetLineBalance.create({ data: { organizationId, budgetLineId: line.id } })
    lines.push(line.id)
  }
  const ctx = systemCtx(organizationId, new Date('2026-01-01T00:00:00Z'), 'seed')
  const importId = randomUUID()
  await forTenant(organizationId).$transaction(async (tx) => {
    const funded = await applyBudget(tx, ctx, lines.map((id) => ({ budgetLineId: id, event: 'budget.imported' as const, document: { type: 'IMPORT' as const, id: importId }, run: (s) => fund(s, 1_000_000_000n, importId) })))
    if (!funded.ok) throw new Error(`funding failed: ${funded.error.code}`)
    await appendEvents(tx, ctx, funded.events)
  })
}
