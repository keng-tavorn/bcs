import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { TZDate } from '@date-fns/tz'
import { systemClock } from '@/lib/clock'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { importDoaDraft, submitDoaVersion } from '@/server/services/doa'
import { completeUpload, requestUpload } from '@/server/services/files'
import { proposeOrgChange } from '@/server/services/org-authority'
import { createDraft, submitRequest } from '@/server/services/requests'
import { attachFile } from '@/server/services/requests/attachments'
import { E2E_DB } from '../support/e2e-env'
import { ATTACHMENT_NAME, ATTACHMENT_PDF } from './tasks-attachment'

// Activity for the S2-12 screens, created through the services in the e2e database only (like seed-activity.ts) and
// run by tests/e2e/tasks*.spec.ts and request-view*.spec.ts through tasks-support.ts. Each Playwright project uses its own
// people, so desktop and mobile never meet in the shared database. Dates come from today, and requests use the open
// budget line of the requester's department in the current fiscal year, so nothing here ages. Prints one line:
// FIXTURE <json>.
//   requests <requester> <approver> <follower>   a request approved, one returned with a reason, one still waiting
//                                                  (followed by <follower>)
//   request <requester> <gross> <name> [attach]  one request waiting for its approver, with a PDF attached on request
//   policy <proposer> <member> <dept>            an appointment of <member> as DM of <dept>, waiting for the CEO
//   doa <proposer> <versionNo>                    version 2 of the §7.4 fixture as DOA-DEMO <versionNo>, waiting for the CEO
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('e2e fixtures are created in the e2e database only')

const now = systemClock.now()
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const TITLES: Record<string, string> = {
  approved: 'อุปกรณ์สำนักงาน (อนุมัติแล้ว)',
  returned: 'ชุดเครื่องมือช่าง (ตีกลับ)',
  pending: 'วัสดุสิ้นเปลือง (รออนุมัติ)',
  reject: 'โต๊ะประชุม (ทดสอบไม่อนุมัติ)',
  foreign: 'ป้ายความปลอดภัย (ทดสอบสิทธิ์)',
  tabbed: 'เครื่องพิมพ์สำนักงาน (หน้าเอกสาร)',
}
/** Policy changes take effect this many days from today: never in the past (BR-DOA-12), never during the run */
const EFFECTIVE_IN_DAYS = 60

const pad = (n: number) => String(n).padStart(2, '0')
/** A Thai calendar day as "YYYY-MM-DD" */
const thaiDay = (d: TZDate) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const today = new TZDate(now.getTime(), 'Asia/Bangkok')

/** Midnight Thai time, EFFECTIVE_IN_DAYS days from today, as the services take it */
function effectiveFrom(): string {
  return `${thaiDay(new TZDate(today.getFullYear(), today.getMonth(), today.getDate() + EFFECTIVE_IN_DAYS, 0, 0, 'Asia/Bangkok'))}T00:00:00+07:00`
}

async function member(code: string) {
  return prisma.member.findFirstOrThrow({ where: { employeeCode: code }, select: { id: true, organizationId: true, primaryDepartmentId: true } })
}

const ctxOf = (m: { id: string; organizationId: string }) => makeCtx({ organizationId: m.organizationId, actor: { type: 'USER', memberId: m.id }, channel: 'WEB', now })

/** An open budget line of the member's department in the fiscal year of today: operating expenses when there is one */
async function budgetLineOf(m: { organizationId: string; primaryDepartmentId: string | null }) {
  // Fiscal years are calendar days (as the budget service compares them)
  const day = new Date(`${thaiDay(today)}T00:00:00Z`)
  const lines = await prisma.budgetLine.findMany({
    where: { organizationId: m.organizationId, departmentId: m.primaryDepartmentId ?? undefined, status: 'OPEN', fiscalYear: { startsOn: { lte: day }, endsOn: { gte: day } } },
    orderBy: { code: 'asc' },
    select: { id: true, code: true },
  })
  const line = lines.find((l) => l.code.includes('OPEX')) ?? lines[0]
  if (!line) throw new Error(`no open budget line in the fiscal year of ${thaiDay(today)}`)
  return line
}

/** Uploads the fixture PDF as the requester through the presigned flow, then attaches it to their draft */
async function attachPdf(m: { id: string; organizationId: string }, requestId: string) {
  const upload = await requestUpload(ctxOf(m), { fileName: ATTACHMENT_NAME, mimeType: 'application/pdf', sizeBytes: ATTACHMENT_PDF.length })
  if (!upload.ok) throw new Error(`upload refused: ${JSON.stringify(upload.error)}`)
  const put = await fetch(upload.data.uploadUrl, { method: 'PUT', body: ATTACHMENT_PDF, headers: { 'Content-Type': 'application/pdf' } })
  if (!put.ok) throw new Error(`upload failed: ${put.status}`)
  const done = await completeUpload(ctxOf(m), { ticket: upload.data.ticket })
  if (!done.ok) throw new Error(`upload not recorded: ${JSON.stringify(done.error)}`)
  const attached = await attachFile(ctxOf(m), { requestId, fileId: done.data.fileId, kind: 'JUSTIFICATION' }, key())
  if (!attached.ok) throw new Error(`attach failed: ${JSON.stringify(attached.error)}`)
}

async function request(requesterCode: string, gross: string, title: string, withFile = false) {
  const m = await member(requesterCode)
  const line = await budgetLineOf(m)
  const draft = await createDraft(
    ctxOf(m),
    { requestTypeCode: 'BUY_GOODS', title, priceIncludesVat: true, budgetLineId: line.id, lines: [{ description: 'วัสดุและอุปกรณ์', quantity: '1', uom: 'ชุด', unitPrice: gross }] },
    key(),
  )
  if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft.error)}`)
  if (withFile) await attachPdf(m, draft.data.requestId)
  const sent = await submitRequest(ctxOf(m), { requestId: draft.data.requestId }, key())
  if (!sent.ok) throw new Error(`submit failed: ${JSON.stringify(sent.error)}`)
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'REQUEST', subjectId: draft.data.requestId } } }, select: { id: true } })
  return { requestId: draft.data.requestId, number: sent.data.number, taskId: task.id, ...(withFile ? { fileName: ATTACHMENT_NAME } : {}) }
}

async function decide(approverCode: string, taskId: string, decision: 'APPROVE' | 'RETURN', reason?: string) {
  const m = await member(approverCode)
  const r = await decideTask(ctxOf(m), { taskId, decision, ...(reason ? { reason } : {}) }, key())
  if (!r.ok) throw new Error(`decide failed: ${JSON.stringify(r.error)}`)
}

const [scenario, ...args] = process.argv.slice(2)
let out: unknown
switch (scenario) {
  case 'requests': {
    const [requester, approver, followerCode] = args as [string, string, string]
    // Just above the 20,000 baht DM band, so the VP of the division decides (PR-02) and the budget line keeps room
    const approved = await request(requester, '21000.00', TITLES.approved!)
    await decide(approver, approved.taskId, 'APPROVE')
    const returned = await request(requester, '22000.00', TITLES.returned!)
    await decide(approver, returned.taskId, 'RETURN', 'แยกรายการให้ชัดเจนก่อนส่งอีกครั้ง')
    const pending = await request(requester, '23000.00', TITLES.pending!)
    // A colleague follows the waiting request (FR-INT-008 AC2); no screen adds followers yet, so the row is written here
    const follower = await member(followerCode)
    await prisma.requestFollower.create({ data: { organizationId: follower.organizationId, requestId: pending.requestId, memberId: follower.id } })
    out = { approved, returned, pending }
    break
  }
  case 'request': {
    const [requester, gross, name, attach] = args as [string, string, string, string | undefined]
    out = await request(requester, gross, TITLES[name] ?? name, attach === 'attach')
    break
  }
  case 'policy': {
    const [proposer, appointee, department] = args as [string, string, string]
    const by = await member(proposer)
    const who = await member(appointee)
    const dept = await prisma.department.findFirstOrThrow({ where: { organizationId: by.organizationId, code: department }, select: { id: true } })
    const from = effectiveFrom()
    const proposed = await proposeOrgChange(ctxOf(by), { kind: 'POSITION_ASSIGN', payload: { positionCode: 'DM', departmentId: dept.id, memberId: who.id }, effectiveFrom: from, reason: 'แต่งตั้งตามคำสั่งบริษัท' }, key())
    if (!proposed.ok) throw new Error(`propose failed: ${JSON.stringify(proposed.error)}`)
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'ORG_AUTHORITY_CHANGE', subjectId: proposed.data.changeId } } }, select: { id: true } })
    out = { changeId: proposed.data.changeId, taskId: task.id, effectiveFrom: from }
    break
  }
  case 'doa': {
    // Version 2 of the §7.4 fixture moves the DM band up to 30,000 baht (PR-01, PR-02 change); its own number per project
    const [proposer, versionNo] = args as [string, string]
    const by = await member(proposer)
    const fixture = readFileSync(path.resolve(import.meta.dirname, '../golden/fixtures/doa-versions.yaml'), 'utf8')
    const from = effectiveFrom()
    const yaml = `versions:\n${fixture.slice(fixture.indexOf('  - code: DOA-DEMO\n    version: 2')).replace('version: 2', `version: ${versionNo}`).replace('"2026-11-01T00:00:00+07:00"', `"${from}"`)}`
    const imported = await importDoaDraft(ctxOf(by), { yaml, changeReason: 'ขยายวงเงินผู้จัดการฝ่ายเป็น 30,000 บาท' }, key())
    if (!imported.ok) throw new Error(`import failed: ${JSON.stringify(imported.error)}`)
    const versionId = imported.data.versionIds[0]!
    const sent = await submitDoaVersion(ctxOf(by), { versionId, boundaryTableConfirmed: true }, key())
    if (!sent.ok) throw new Error(`submit failed: ${JSON.stringify(sent.error)}`)
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'DOA_VERSION', subjectId: versionId } } }, select: { id: true } })
    out = { versionId, taskId: task.id, effectiveFrom: from }
    break
  }
  default:
    throw new Error(`unknown scenario ${scenario}`)
}
await prisma.$disconnect()
console.log(`FIXTURE ${JSON.stringify(out)}`)
