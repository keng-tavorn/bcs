import { randomUUID } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import { toJsonSafe } from '@/lib/json'
import { OrgSettingsSchema } from '@/lib/org-settings'
import { deriveSeedTotpSecret } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { prisma } from '@/server/db/client'
import { ruleJson } from '@/server/doa/snapshot'
import { loadOrgSettingsYaml } from '@/server/seed/demo-org'
import { loadSeedForms } from '@/server/seed/forms'
import { seedDevPins } from '@/server/seed/pins'
import { seedWorkflow } from '@/server/seed/workflow'
import { loadYaml, versionSnapshots } from '../golden/doa-fixtures'
import { workflowFixture } from '../golden/workflow-fixtures'
import { E2E_DB, E2E_PIN } from '../support/e2e-env'

// Run by tests/e2e/admin-workflows.spec.ts against the e2e database only (S6-06, FR-WF-103). Each run builds an
// organization of its own, so no other spec's organization changes: the departments, positions and holders of the S6
// fixture (tests/golden/fixtures/org-s6.yaml) with Thai names, DOA version 1 of doa-versions.yaml in effect (the CEO
// approves DOA_CHANGE), the request types of prisma/seed/forms.yaml and version 1 of the workflow of
// workflow-versions.yaml, published as the phase-1 seed publishes it (local e2e data, never a customer's). Its second
// admin (admin2, ORG_ADMIN) and its CEO sign in with SEED_DEV_PASSWORD and the TOTP derived from SEED_TOTP_KEY and the
// printed code; the CEO decides with the transaction PIN the e2e seed gives every approver (E2E_PIN, FR-AUTH-005).
//   org <desktop|mobile>       → the organization; prints its code, the sign-ins and the names the spec reads
//   task <org code>            → the open approval task of the workflow version waiting for approval
//   status <org code>          → every workflow version of the organization with its status
// Prints JSON on the last line.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the workflow scene runs in the e2e database only')
const password = process.env.SEED_DEV_PASSWORD
const totpKey = process.env.SEED_TOTP_KEY
if (!password || !totpKey) throw new Error('SEED_DEV_PASSWORD and SEED_TOTP_KEY are needed')

const [mode = 'org', arg = ''] = process.argv.slice(2)
const now = new Date()

interface OrgFixture {
  departments: Array<{ code: string; nameTh: string; parent: string | null }>
  positions: Array<{ position: string; department: string; member: string }>
  members: Record<string, string>
}

const NAMES: Readonly<Record<string, string>> = {
  req_con: 'รัตนา หน้างาน',
  asst_con: 'อนันต์ ผู้ช่วย',
  receiver_con: 'รับขวัญ ตรวจรับ',
  dm_con: 'ดนัย ก่อสร้าง',
  proc_officer: 'ปวีณา จัดหา',
  dm_proc: 'ปรีชา จัดซื้อ',
  fin_officer: 'ฟ้าใส การเงิน',
  dm_fin: 'ไพศาล บัญชี',
  auditor: 'อรอุมา ตรวจสอบ',
  dm_it: 'ไอยรา ระบบงาน',
  admin: 'อรุณ ดูแลระบบ',
  admin2: 'อำไพ ดูแลระบบ',
  vp_ops: 'วิชัย สายปฏิบัติ',
  vp_sup: 'วรรณา สายสนับสนุน',
  coo: 'สมใจ ปฏิบัติการ',
  ceo: 'ประเสริฐ ผู้นำ',
  cfo: 'จันทร์เพ็ญ การคลัง',
  dm_leg: 'ลลิตา กฎหมาย',
  dm_qse: 'ศักดิ์ชัย ปลอดภัย',
}
const POSITIONS: Readonly<Record<string, string>> = {
  DM: 'ผู้จัดการฝ่าย',
  VP: 'รองประธานสายงาน',
  PROC_MGR: 'ผู้จัดการจัดซื้อ',
  COO: 'ประธานเจ้าหน้าที่ฝ่ายปฏิบัติการ',
  CFO: 'ประธานเจ้าหน้าที่ฝ่ายการเงิน',
  CEO: 'ประธานเจ้าหน้าที่บริหาร',
  PC1: 'กรรมการจัดซื้อ 1',
  PC2: 'กรรมการจัดซื้อ 2',
  PC3: 'กรรมการจัดซื้อ 3',
}
const TYPES = [
  ['BUY_GOODS', 'ซื้อของ'],
  ['HIRE_SERVICE', 'จ้างบริการ'],
  ['CONTRACT_WORK', 'จ้างเหมา'],
  ['IT_PURCHASE', 'ซื้ออุปกรณ์/ซอฟต์แวร์ไอที'],
] as const
/** The members who sign in: they hold a role or a DOA position, so they use an authenticator */
const SIGN_IN = ['admin2', 'ceo'] as const

async function createOrganization(project: string) {
  const run = randomUUID().slice(0, 6)
  const prefix = `wf${project === 'mobile' ? 'm' : 'd'}${run}`
  const fixture = loadYaml<OrgFixture>('fixtures/org-s6.yaml')
  const settings = OrgSettingsSchema.parse(parseYaml(loadOrgSettingsYaml()))
  const org = await prisma.organization.create({
    data: { code: `ZE2E-WF-${project === 'mobile' ? 'M' : 'D'}-${run.toUpperCase()}`, legalNameTh: 'บริษัท ทดสอบผู้ตรวจคู่ขนาน จำกัด', displayName: 'ทดสอบผู้ตรวจ', taxId: '0999999000055', timezone: 'Asia/Bangkok', settings: toJsonSafe(settings) as object },
  })
  const organizationId = org.id
  await prisma.orgModule.create({ data: { organizationId, module: 'CORE', enabled: true, enabledAt: now, contractRef: 'E2E', reason: 'ระบบหลักขององค์กรทดสอบ' } })

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
        data: { organizationId, displayNameTh: NAMES[code] ?? code, email: `${prefix}-${code}@e2e.bcs.local`, employeeCode: `${prefix}_${code}`, status: 'ACTIVE', primaryDepartmentId: department[dept]! },
      })
    ).id
  }
  for (const code of SIGN_IN) {
    const userId = await upsertUserWithPassword({ email: `${prefix}-${code}@e2e.bcs.local`, name: NAMES[code]!, password: password! })
    await enableTotpWithSecret(userId, deriveSeedTotpSecret(totpKey!, `${prefix}_${code}`), [])
    await prisma.member.update({ where: { id: member[code] }, data: { userId } })
  }
  await prisma.roleAssignment.create({ data: { organizationId, memberId: member.admin2!, role: 'ORG_ADMIN', grantedAt: now } })

  const since = new Date('2026-01-01T00:00:00+07:00')
  const position: Record<string, string> = {}
  for (const p of fixture.positions) {
    position[p.position] ??= (await prisma.position.create({ data: { organizationId, code: p.position, nameTh: POSITIONS[p.position] ?? p.position, scope: p.department === 'HQ' ? 'ORG' : 'DEPARTMENT' } })).id
    await prisma.positionAssignment.create({ data: { organizationId, positionId: position[p.position]!, departmentId: department[p.department]!, memberId: member[p.member]!, validFrom: since } })
  }

  // DOA version 1 of the fixture in effect since 1 January 2026, as the demo seed publishes the demo organization's
  const v1 = versionSnapshots('fixtures/doa-versions.yaml').find((v) => v.versionNo === 1)!
  const doa = await prisma.doaVersion.create({
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
    await prisma.doaRule.create({ data: { organizationId, doaVersionId: doa.id, code: rule.code, documentType: json.documentType, priority: rule.priority, when: json.when, steps: json.steps } })
  }

  // The request types with the forms the demo seeds: the workflow's conditions name their fields (BR-WF-11)
  const forms = loadSeedForms()
  for (const [code, nameTh] of TYPES) {
    const type = await prisma.requestType.create({ data: { organizationId, code, nameTh, documentType: 'PURCHASE_REQUEST' } })
    const form = await prisma.formVersion.create({ data: { organizationId, requestTypeId: type.id, versionNo: 1, schema: forms.get(code)! as object, status: 'PUBLISHED', publishedAt: since } })
    await prisma.requestType.update({ where: { id: type.id }, data: { currentFormVersionId: form.id } })
  }

  // Workflow version 1 of the fixture, published from DOA version 1's start (as the phase-1 seed does)
  const workflow = workflowFixture(['fixtures/workflow-versions.yaml']).versions[0]!
  await seedWorkflow(organizationId, { code: workflow.code, rules: workflow.rules.map((r) => ({ ...r, descriptionTh: null })) }, now)
  // The approvers of DOA version 1 (the CEO among them) decide with the PIN of the e2e seed
  await seedDevPins(organizationId, E2E_PIN, now)
  return {
    orgCode: org.code,
    admin: { email: `${prefix}-admin2@e2e.bcs.local`, code: `${prefix}_admin2` },
    ceo: { email: `${prefix}-ceo@e2e.bcs.local`, code: `${prefix}_ceo` },
    workflowCode: workflow.code,
    rules: workflow.rules.length,
    names: NAMES,
  }
}

async function organizationId(code: string) {
  return (await prisma.organization.findUniqueOrThrow({ where: { code }, select: { id: true } })).id
}

/** The open task of the workflow version waiting for approval: the CEO opens it on the web */
async function openTask(orgCode: string) {
  const id = await organizationId(orgCode)
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { organizationId: id, status: 'OPEN', step: { route: { subjectType: 'WORKFLOW_VERSION' } } }, select: { id: true, step: { select: { route: { select: { subjectId: true } } } } } })
  return { taskId: task.id, versionId: task.step.route.subjectId }
}

async function statuses(orgCode: string) {
  const id = await organizationId(orgCode)
  const versions = await prisma.workflowVersion.findMany({ where: { organizationId: id }, select: { versionNo: true, status: true, effectiveFrom: true, approvedById: true }, orderBy: { versionNo: 'asc' } })
  return { versions: versions.map((v) => ({ versionNo: v.versionNo, status: v.status, effectiveFrom: v.effectiveFrom.toISOString(), approved: v.approvedById !== null })) }
}

const out = mode === 'task' ? await openTask(arg) : mode === 'status' ? await statuses(arg) : await createOrganization(arg)
console.log(JSON.stringify(out))
await prisma.$disconnect()
