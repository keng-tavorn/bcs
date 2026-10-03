import { randomUUID } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import type { DoaRuleSnapshot } from '@/core/doa'
import { toJsonSafe } from '@/lib/json'
import { OrgSettingsSchema } from '@/lib/org-settings'
import { deriveSeedTotpSecret } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { ruleJson } from '@/server/doa/snapshot'
import { loadOrgSettingsYaml } from '@/server/seed/demo-org'
import { draftDoaCopy, getDoaEditor } from '@/server/services/doa/editor'
import { versionSnapshots } from '../golden/doa-fixtures'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/admin-doa-editor.spec.ts against the e2e database only (S3-09, FR-DOA-001 AC1, FR-DOA-009). Each run
// builds an organization of its own, so the demo organization's DOA never changes under other specs: the departments,
// positions and holders of the §7.4 fixture with Thai names, and version 1 of the fixture in effect since 1 January 2026
// (published as the demo seed publishes it — local e2e data, never a customer's). Its admin signs in with
// SEED_DEV_PASSWORD and the TOTP derived from SEED_TOTP_KEY and the printed code; so does its CEO, who approves on the
// decision page with the tick of the boundary table and a step-up (FR-DOA-009 AC3, BR-DOA-15).
//   org <desktop|mobile>       → the organization; prints its code, the admin's and the CEO's sign-in and the names the
//                                spec reads
//   flat <desktop|mobile>      → the same organization with a version 1 whose bands have no upper end (every purchase
//                                request to the DM, every order to the COO), and version 2 saved through the editor's
//                                service with the VP in place of the DM: neither has a band edge, so no boundary table
//   draft <org code>           → the admin saves version 2 (DM band up to 30,000) through the editor's service
// Prints JSON on the last line.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the DOA editor scene runs in the e2e database only')
const password = process.env.SEED_DEV_PASSWORD
const totpKey = process.env.SEED_TOTP_KEY
if (!password || !totpKey) throw new Error('SEED_DEV_PASSWORD and SEED_TOTP_KEY are needed')

const [mode = 'org', arg = ''] = process.argv.slice(2)
const now = new Date()

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
  req_con: 'รัตนา หน้างาน',
} as const
type Code = keyof typeof NAMES

/** Version 1 without band edges: no amount band has an upper end */
const FLAT: DoaRuleSnapshot[] = [
  { code: 'PR-01', documentType: 'PURCHASE_REQUEST', priority: 100, when: { amount: { gt: 0n } }, steps: [{ approver: { kind: 'POSITION_OF_DEPARTMENT', position: 'DM' }, slaBusinessMinutes: 480, mode: 'SEQUENTIAL' }] },
  { code: 'PO-01', documentType: 'PURCHASE_ORDER', priority: 100, when: { amount: { gt: 0n } }, steps: [{ approver: { kind: 'POSITION_OF_ORG', position: 'COO' }, slaBusinessMinutes: 480, mode: 'SEQUENTIAL' }] },
  { code: 'GRV-01', documentType: 'GR_VARIANCE', priority: 100, when: {}, steps: [{ approver: { kind: 'POSITION_OF_DEPARTMENT', position: 'DM' }, slaBusinessMinutes: 480, mode: 'SEQUENTIAL' }] },
  { code: 'DOA-CHG-01', documentType: 'DOA_CHANGE', priority: 100, when: {}, steps: [{ approver: { kind: 'POSITION_OF_ORG', position: 'CEO' }, slaBusinessMinutes: 960, mode: 'SEQUENTIAL' }] },
  { code: 'ORG-CHG-01', documentType: 'ORG_AUTHORITY_CHANGE', priority: 100, when: {}, steps: [{ approver: { kind: 'POSITION_OF_ORG', position: 'CEO' }, slaBusinessMinutes: 960, mode: 'SEQUENTIAL' }] },
]

async function createOrganization(project: string, rules: readonly DoaRuleSnapshot[] = versionSnapshots().find((v) => v.versionNo === 1)!.rules) {
  const run = randomUUID().slice(0, 6)
  const prefix = `doa${project === 'mobile' ? 'm' : 'd'}${run}`
  const settings = OrgSettingsSchema.parse(parseYaml(loadOrgSettingsYaml()))
  const org = await prisma.organization.create({
    data: { code: `ZE2E-DOA-${project === 'mobile' ? 'M' : 'D'}-${run.toUpperCase()}`, legalNameTh: 'บริษัท ทดสอบแก้ DOA จำกัด', displayName: 'ทดสอบแก้ DOA', taxId: '0999999000055', timezone: 'Asia/Bangkok', settings: toJsonSafe(settings) as object },
  })
  const organizationId = org.id
  await prisma.orgModule.create({ data: { organizationId, module: 'CORE', enabled: true, enabledAt: now, contractRef: 'E2E', reason: 'ระบบหลักขององค์กรทดสอบ' } })

  const department: Record<string, string> = {}
  for (const [code, nameTh, parent] of [
    ['HQ', 'สำนักงานใหญ่', null],
    ['OPS', 'สายปฏิบัติการ', 'HQ'],
    ['CON', 'ฝ่ายก่อสร้าง', 'OPS'],
    ['PROC', 'ฝ่ายจัดซื้อ', 'OPS'],
    ['SUP', 'สายสนับสนุน', 'HQ'],
    ['FIN', 'ฝ่ายบัญชีและการเงิน', 'SUP'],
    ['IT', 'ฝ่ายไอที', 'SUP'],
  ] as const) {
    department[code] = (await prisma.department.create({ data: { organizationId, code, nameTh, parentId: parent ? department[parent]! : null, kind: parent ? 'DEPARTMENT' : 'COMPANY' } })).id
  }

  const home: Record<Code, string> = { admin: 'IT', ceo: 'HQ', coo: 'HQ', vp_ops: 'OPS', vp_sup: 'SUP', dm_con: 'CON', dm_proc: 'PROC', dm_fin: 'FIN', dm_it: 'IT', req_con: 'CON' }
  const member = {} as Record<Code, string>
  for (const code of Object.keys(NAMES) as Code[]) {
    member[code] = (
      await prisma.member.create({
        data: { organizationId, displayNameTh: NAMES[code], email: `${prefix}-${code}@e2e.bcs.local`, employeeCode: `${prefix}_${code}`, status: 'ACTIVE', primaryDepartmentId: department[home[code]]! },
      })
    ).id
  }
  // The admin and the CEO sign in with a password and an authenticator (members with a role or a DOA position)
  for (const code of ['admin', 'ceo'] as const) {
    const userId = await upsertUserWithPassword({ email: `${prefix}-${code}@e2e.bcs.local`, name: NAMES[code], password: password! })
    await enableTotpWithSecret(userId, deriveSeedTotpSecret(totpKey!, `${prefix}_${code}`), [])
    await prisma.member.update({ where: { id: member[code] }, data: { userId } })
  }
  await prisma.roleAssignment.create({ data: { organizationId, memberId: member.admin, role: 'ORG_ADMIN', grantedAt: now } })

  const position: Record<string, string> = {}
  for (const [code, nameTh, scope] of [
    ['CEO', 'ประธานเจ้าหน้าที่บริหาร', 'ORG'],
    ['COO', 'ประธานเจ้าหน้าที่ฝ่ายปฏิบัติการ', 'ORG'],
    ['VP', 'รองประธานสายงาน', 'DEPARTMENT'],
    ['DM', 'ผู้จัดการฝ่าย', 'DEPARTMENT'],
  ] as const) {
    position[code] = (await prisma.position.create({ data: { organizationId, code, nameTh, scope } })).id
  }
  const since = new Date('2026-01-01T00:00:00+07:00')
  for (const [code, dept, who] of [
    ['CEO', 'HQ', 'ceo'],
    ['COO', 'HQ', 'coo'],
    ['VP', 'OPS', 'vp_ops'],
    ['VP', 'SUP', 'vp_sup'],
    ['DM', 'CON', 'dm_con'],
    ['DM', 'PROC', 'dm_proc'],
    ['DM', 'FIN', 'dm_fin'],
    ['DM', 'IT', 'dm_it'],
  ] as const) {
    await prisma.positionAssignment.create({ data: { organizationId, positionId: position[code]!, departmentId: department[dept]!, memberId: member[who], validFrom: since } })
  }

  // Version 1 of the §7.4 fixture (or the given rules), in effect since 1 January 2026, as the demo seed publishes the
  // demo organization's
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
  for (const rule of rules) {
    const json = ruleJson(rule)
    await prisma.doaRule.create({ data: { organizationId, doaVersionId: version.id, code: rule.code, documentType: json.documentType, priority: rule.priority, when: json.when, steps: json.steps } })
  }
  return { orgCode: org.code, email: `${prefix}-admin@e2e.bcs.local`, code: `${prefix}_admin`, ceo: { email: `${prefix}-ceo@e2e.bcs.local`, code: `${prefix}_ceo` }, v1: version.id, names: NAMES }
}

/** An organization whose versions have no band edge: version 1 flat, version 2 saved from it with the VP for purchase requests */
async function flatOrganization(project: string) {
  const org = await createOrganization(project, FLAT)
  const { organizationId, memberOf } = await organization(org.orgCode)
  const ctx = makeCtx({ organizationId, actor: { type: 'USER', memberId: memberOf('admin').id }, channel: 'WEB', now })
  const editor = await getDoaEditor(ctx, org.v1)
  if (!editor.ok) throw new Error(`editor failed: ${JSON.stringify(editor.error)}`)
  const view = editor.data
  const saved = await draftDoaCopy(
    ctx,
    {
      sourceVersionId: org.v1,
      effectiveDate: view.defaultEffectiveDate,
      changeReason: 'ให้รองประธานสายงานอนุมัติคำขอซื้อทุกยอด',
      policy: { ...view.policy },
      rules: view.rules.map((r) => ({
        code: r.code,
        documentType: r.documentType,
        band: r.band,
        steps: r.steps.map((s) => ({ approver: r.code === 'PR-01' ? { kind: 'POSITION_OF_DEPARTMENT' as const, position: 'VP' } : s.approver, slaMinutes: s.slaMinutes })),
      })),
    },
    { idempotencyKey: randomUUID(), sender: null },
  )
  if (!saved.ok) throw new Error(`draft failed: ${JSON.stringify(saved.error)}`)
  return { ...org, draftId: saved.data.versionId, draftNo: saved.data.versionNo }
}

async function organization(code: string) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { code }, select: { id: true } })
  const members = await prisma.member.findMany({ where: { organizationId: org.id }, select: { id: true, employeeCode: true } })
  const memberOf = (suffix: Code) => members.find((m) => m.employeeCode?.endsWith(`_${suffix}`))!
  return { organizationId: org.id, memberOf }
}

/** The demo's draft: version 1 with the DM band of purchase requests up to 30,000 baht, saved as the admin would */
async function saveDraft(orgCode: string) {
  const { organizationId, memberOf } = await organization(orgCode)
  const ctx = makeCtx({ organizationId, actor: { type: 'USER', memberId: memberOf('admin').id }, channel: 'WEB', now })
  const v1 = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId, versionNo: 1 }, select: { id: true } })
  const editor = await getDoaEditor(ctx, v1.id)
  if (!editor.ok) throw new Error(`editor failed: ${JSON.stringify(editor.error)}`)
  const view = editor.data
  const saved = await draftDoaCopy(
    ctx,
    {
      sourceVersionId: v1.id,
      effectiveDate: view.defaultEffectiveDate,
      changeReason: 'ขยายวงเงิน DM เป็น 30,000 บาท',
      policy: { ...view.policy },
      rules: view.rules.map((r) => ({
        code: r.code,
        documentType: r.documentType,
        band: r.band && r.code === 'PR-01' ? { ...r.band, upper: '3000000' } : r.band && r.code === 'PR-02' ? { ...r.band, lower: '3000000' } : r.band,
        steps: r.steps.map((s) => ({ approver: s.approver, slaMinutes: s.slaMinutes })),
      })),
    },
    { idempotencyKey: randomUUID(), sender: null },
  )
  if (!saved.ok) throw new Error(`draft failed: ${JSON.stringify(saved.error)}`)
  return saved.data
}

const out = mode === 'draft' ? await saveDraft(arg) : mode === 'flat' ? await flatOrganization(arg) : await createOrganization(arg)
console.log(JSON.stringify(out))
await prisma.$disconnect()
