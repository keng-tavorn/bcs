import { randomUUID } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import { fund } from '@/core/budget'
import { toJsonSafe } from '@/lib/json'
import { OrgSettingsSchema } from '@/lib/org-settings'
import { deriveSeedTotpSecret } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { applyBudget } from '@/server/budget/ledger'
import { makeCtx, systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { ruleJson } from '@/server/doa/snapshot'
import { appendEvents } from '@/server/events/append'
import { loadOrgSettingsYaml } from '@/server/seed/demo-org'
import { loadSeedForms } from '@/server/seed/forms'
import { seedDevPins } from '@/server/seed/pins'
import { seedTaxRates } from '@/server/seed/tax-rates'
import { seedWorkflow } from '@/server/seed/workflow'
import { decideTask } from '@/server/services/approvals/decide'
import { createDraft, submitRequest } from '../support/requests'
import { versionSnapshots } from '../golden/doa-fixtures'
import { workflowFixture } from '../golden/workflow-fixtures'
import { E2E_DB, E2E_PIN } from '../support/e2e-env'

// Run by tests/e2e/review-step.spec.ts against the e2e database only (S6-06, FR-WF-101): an organization of its own
// with the departments of the S6 fixture (org-s6.yaml: LEG and QSE beside the §7.4 ones), version 1 of the §7.4 DOA
// (above 100,000.00 VAT included the CEO approves) and the reviewers of workflow-versions.yaml, seeded as the phase-1
// seed stores them — local e2e data, never a customer's. pm_p07 of CON has sent a contract work of 2,470,000.00 before
// VAT (2,642,900.00 with it): the DM of LEG, QSE and FIN review it at once (RV-03 to RV-05), then the CEO approves.
// pm_p07, the three DMs and the CEO sign in with SEED_DEV_PASSWORD and the TOTP derived from SEED_TOTP_KEY and the
// printed code.
//   org <desktop|mobile>      → the organization and the sent request; prints the sign-ins, names and ids
//   pass <org code> <member>  → that reviewer passes their slot through the service (on the web, now)
// Prints JSON on the last line.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the review step scene runs in the e2e database only')
const password = process.env.SEED_DEV_PASSWORD
const totpKey = process.env.SEED_TOTP_KEY
if (!password || !totpKey) throw new Error('SEED_DEV_PASSWORD and SEED_TOTP_KEY are needed')

const [mode = 'org', arg = '', who = ''] = process.argv.slice(2)
const now = new Date()
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

const NAMES = {
  admin: 'อรุณ ดูแลระบบ',
  ceo: 'ประเสริฐ ผู้นำ',
  coo: 'สมใจ ปฏิบัติการ',
  vp_ops: 'วิชัย สายปฏิบัติ',
  vp_sup: 'วรรณา สายสนับสนุน',
  dm_con: 'ดนัย ก่อสร้าง',
  dm_proc: 'ปรีชา จัดซื้อ',
  dm_fin: 'ฟ้าใส บัญชี',
  dm_it: 'ไอยรา ระบบงาน',
  dm_leg: 'ลลิตา กฎหมาย',
  dm_qse: 'ศักดิ์ชัย ความปลอดภัย',
  pm_p07: 'พงศ์ศักดิ์ ผู้จัดการโครงการ',
} as const
type Code = keyof typeof NAMES
const HOME: Record<Code, string> = { admin: 'IT', ceo: 'HQ', coo: 'HQ', vp_ops: 'OPS', vp_sup: 'SUP', dm_con: 'CON', dm_proc: 'PROC', dm_fin: 'FIN', dm_it: 'IT', dm_leg: 'LEG', dm_qse: 'QSE', pm_p07: 'CON' }
const SIGN_IN: readonly Code[] = ['pm_p07', 'dm_leg', 'dm_qse', 'dm_fin', 'ceo']

async function createOrganization(project: string) {
  const run = randomUUID().slice(0, 6)
  const prefix = `rvw${project === 'mobile' ? 'm' : 'd'}${run}`
  const settings = OrgSettingsSchema.parse(parseYaml(loadOrgSettingsYaml()))
  const org = await prisma.organization.create({
    data: { code: `ZE2E-RVW-${project === 'mobile' ? 'M' : 'D'}-${run.toUpperCase()}`, legalNameTh: 'บริษัท ทดสอบผู้ตรวจคู่ขนาน จำกัด', displayName: 'ทดสอบผู้ตรวจคู่ขนาน', taxId: '0999999000063', timezone: 'Asia/Bangkok', settings: toJsonSafe(settings) as object },
  })
  const organizationId = org.id
  await prisma.orgModule.create({ data: { organizationId, module: 'CORE', enabled: true, enabledAt: now, contractRef: 'E2E', reason: 'ระบบหลักขององค์กรทดสอบ' } })
  await seedTaxRates()

  const department: Record<string, string> = {}
  for (const [code, nameTh, parent] of [
    ['HQ', 'สำนักงานใหญ่', null],
    ['OPS', 'สายปฏิบัติการ', 'HQ'],
    ['CON', 'ฝ่ายก่อสร้าง', 'OPS'],
    ['PROC', 'ฝ่ายจัดซื้อ', 'OPS'],
    ['QSE', 'ฝ่ายความปลอดภัย', 'OPS'],
    ['SUP', 'สายสนับสนุน', 'HQ'],
    ['FIN', 'ฝ่ายบัญชีและการเงิน', 'SUP'],
    ['IT', 'ฝ่ายไอที', 'SUP'],
    ['LEG', 'ฝ่ายกฎหมาย', 'SUP'],
  ] as const) {
    department[code] = (await prisma.department.create({ data: { organizationId, code, nameTh, parentId: parent ? department[parent]! : null, kind: parent ? 'DEPARTMENT' : 'COMPANY' } })).id
  }
  const member = {} as Record<Code, string>
  for (const code of Object.keys(NAMES) as Code[]) {
    member[code] = (
      await prisma.member.create({
        data: { organizationId, displayNameTh: NAMES[code], email: `${prefix}-${code}@e2e.bcs.local`, employeeCode: `${prefix}_${code}`, status: 'ACTIVE', primaryDepartmentId: department[HOME[code]]! },
      })
    ).id
  }
  for (const code of SIGN_IN) {
    const userId = await upsertUserWithPassword({ email: `${prefix}-${code}@e2e.bcs.local`, name: NAMES[code], password: password! })
    await enableTotpWithSecret(userId, deriveSeedTotpSecret(totpKey!, `${prefix}_${code}`), [])
    await prisma.member.update({ where: { id: member[code] }, data: { userId } })
  }
  await prisma.roleAssignment.create({ data: { organizationId, memberId: member.admin, role: 'ORG_ADMIN', grantedAt: now } })

  const position: Record<string, string> = {}
  for (const [code, nameTh, scope] of [
    ['CEO', 'ประธานเจ้าหน้าที่บริหาร', 'ORG'],
    ['COO', 'ประธานเจ้าหน้าที่ฝ่ายปฏิบัติการ', 'ORG'],
    ['CFO', 'ประธานเจ้าหน้าที่ฝ่ายการเงิน', 'ORG'],
    ['VP', 'รองประธานสายงาน', 'DEPARTMENT'],
    ['DM', 'ผู้จัดการฝ่าย', 'DEPARTMENT'],
  ] as const) {
    position[code] = (await prisma.position.create({ data: { organizationId, code, nameTh, scope } })).id
  }
  const since = new Date('2026-01-01T00:00:00+07:00')
  for (const [code, dept, holder] of [
    ['CEO', 'HQ', 'ceo'],
    ['COO', 'HQ', 'coo'],
    ['CFO', 'HQ', 'dm_fin'],
    ['VP', 'OPS', 'vp_ops'],
    ['VP', 'SUP', 'vp_sup'],
    ['DM', 'CON', 'dm_con'],
    ['DM', 'PROC', 'dm_proc'],
    ['DM', 'FIN', 'dm_fin'],
    ['DM', 'IT', 'dm_it'],
    ['DM', 'LEG', 'dm_leg'],
    ['DM', 'QSE', 'dm_qse'],
  ] as const) {
    await prisma.positionAssignment.create({ data: { organizationId, positionId: position[code]!, departmentId: department[dept]!, memberId: member[holder], validFrom: since } })
  }

  // Version 1 of the §7.4 fixture, in effect since 1 January 2026, as the demo seed publishes the demo organization's
  const v1 = versionSnapshots().find((v) => v.versionNo === 1)!
  const version = await prisma.doaVersion.create({
    data: {
      organizationId,
      code: v1.code,
      versionNo: 1,
      status: 'PUBLISHED',
      effectiveFrom: since,
      amountBasis: v1.amountBasis,
      selfApprovalPolicy: v1.selfApprovalPolicy,
      collapseDuplicateApprovers: v1.collapseDuplicateApprovers,
      stepUpThresholdSatang: 10_000_000n,
      escalationPolicy: { remindPct: 0.5, escalateAfterBusinessHours: 8 },
      sodPolicy: { approverMayReceive: false, requesterMayReceive: true },
      changeReason: 'DOA ฉบับแรกตามข้อเสนอ',
      publishedAt: since,
    },
  })
  for (const rule of v1.rules) {
    const json = ruleJson(rule)
    await prisma.doaRule.create({ data: { organizationId, doaVersionId: version.id, code: rule.code, documentType: json.documentType, priority: rule.priority, when: json.when, steps: json.steps } })
  }
  await seedDevPins(organizationId, E2E_PIN, now)

  // The request types of the demo with their forms (prisma/seed/forms.yaml), which the reviewer rules read
  const forms = loadSeedForms()
  for (const [code, nameTh] of [
    ['BUY_GOODS', 'ซื้อของ'],
    ['HIRE_SERVICE', 'จ้างบริการ'],
    ['IT_PURCHASE', 'ซื้ออุปกรณ์/ซอฟต์แวร์ไอที'],
    ['CONTRACT_WORK', 'จ้างเหมา'],
  ] as const) {
    const type = await prisma.requestType.create({ data: { organizationId, code, nameTh, documentType: 'PURCHASE_REQUEST' } })
    const form = await prisma.formVersion.create({ data: { organizationId, requestTypeId: type.id, versionNo: 1, schema: forms.get(code)! as object, status: 'PUBLISHED', publishedAt: since } })
    await prisma.requestType.update({ where: { id: type.id }, data: { currentFormVersionId: form.id } })
  }

  // FY2569 with 10,000,000.00 baht on one line per department
  const fiscalYear = await prisma.fiscalYear.create({ data: { organizationId, code: 'FY2569', startsOn: new Date('2026-01-01T00:00:00Z'), endsOn: new Date('2026-12-31T00:00:00Z') } })
  const lines: string[] = []
  for (const [code, departmentId] of Object.entries(department)) {
    const costCenter = await prisma.costCenter.create({ data: { organizationId, code: `CC-${code}`, nameTh: `ศูนย์ต้นทุน ${code}`, departmentId } })
    const line = await prisma.budgetLine.create({ data: { organizationId, fiscalYearId: fiscalYear.id, departmentId, costCenterId: costCenter.id, code: `${code}-OPEX-2569`, nameTh: `ค่าใช้จ่ายดำเนินงาน ${code}`, plannedSatang: 0n } })
    await prisma.budgetLineBalance.create({ data: { organizationId, budgetLineId: line.id } })
    lines.push(line.id)
  }
  const importId = randomUUID()
  await forTenant(organizationId).$transaction(async (tx) => {
    const ctx = systemCtx(organizationId, since, 'seed')
    const funded = await applyBudget(tx, ctx, lines.map((id) => ({ budgetLineId: id, document: { type: 'IMPORT' as const, id: importId }, run: (s) => fund(s, 1_000_000_000n, importId) })))
    if (!funded.ok) throw new Error(`funding failed: ${funded.error.code}`)
    await appendEvents(tx, ctx, funded.events)
  })

  // The reviewers of workflow-versions.yaml, as the phase-1 seed stores WF-SIMEC
  const workflow = workflowFixture(['fixtures/workflow-versions.yaml']).versions[0]!
  await seedWorkflow(organizationId, { code: workflow.code, rules: workflow.rules.map((r) => ({ ...r, descriptionTh: null })) }, now)

  // pm_p07 sends the contract work with the three quotations ATT-QUOTES asks
  const ctx = makeCtx({ organizationId, actor: { type: 'USER', memberId: member.pm_p07 }, channel: 'WEB', now })
  const draft = await createDraft(
    ctx,
    {
      requestTypeCode: 'CONTRACT_WORK',
      title: 'งานเหมาก่อสร้างอาคารเก็บวัสดุไซต์ P07',
      formData: { scopeOfWork: 'ก่อสร้างอาคารเก็บวัสดุ 1 หลัง พร้อมระบบไฟฟ้า', milestones: '3 งวด ตามความคืบหน้าของงาน', site: 'ไซต์ P07' },
      lines: [{ description: 'งานเหมาก่อสร้างอาคารเก็บวัสดุ', quantity: '1', uom: 'งาน', unitPrice: '2470000.00' }],
    },
    key(),
  )
  if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft.error)}`)
  for (let i = 0; i < 3; i++) {
    const file = await prisma.fileObject.create({ data: { organizationId, storageKey: `e2e/${randomUUID()}.pdf`, fileName: `ใบเสนอราคา-${i + 1}.pdf`, mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: member.pm_p07 } })
    await prisma.fileLink.create({ data: { organizationId, fileId: file.id, subjectType: 'Request', subjectId: draft.data.requestId, kind: 'QUOTATION' } })
  }
  const sent = await submitRequest(ctx, { requestId: draft.data.requestId }, key())
  if (!sent.ok) throw new Error(`submit failed: ${JSON.stringify(sent.error)}`)
  const tasks = await prisma.approvalTask.findMany({ where: { organizationId, step: { route: { subjectId: draft.data.requestId } } }, select: { id: true, assigneeMemberId: true } })
  const taskOf = (code: Code) => tasks.find((t) => t.assigneeMemberId === member[code])!.id
  const signIn = Object.fromEntries(SIGN_IN.map((c) => [c, { email: `${prefix}-${c}@e2e.bcs.local`, code: `${prefix}_${c}` }]))
  return { orgCode: org.code, requestId: draft.data.requestId, number: sent.data.number, signIn, names: NAMES, tasks: { dm_leg: taskOf('dm_leg'), dm_qse: taskOf('dm_qse'), dm_fin: taskOf('dm_fin') } }
}

/** A reviewer passes their open task of the organization's request through the service */
async function pass(orgCode: string, code: Code) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { code: orgCode }, select: { id: true } })
  const holder = await prisma.member.findFirstOrThrow({ where: { organizationId: org.id, employeeCode: { endsWith: `_${code}` } }, select: { id: true } })
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { organizationId: org.id, assigneeMemberId: holder.id, status: 'OPEN' }, select: { id: true } })
  const decided = await decideTask(makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: holder.id }, channel: 'WEB', now }), { taskId: task.id, decision: 'APPROVE' }, key())
  if (!decided.ok) throw new Error(`pass failed: ${JSON.stringify(decided.error)}`)
  return { taskId: task.id, documentStatus: decided.data.documentStatus }
}

const result = mode === 'pass' ? await pass(arg, who as Code) : await createOrganization(arg)
console.log(JSON.stringify(result))
await prisma.$disconnect()
