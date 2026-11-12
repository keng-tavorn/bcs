import { stepUpNeeded } from '@/core/pin'
import type { LintDocumentType } from '@/core/risk'
import { systemClock } from '@/lib/clock'
import { MS_PER_MINUTE } from '@/lib/constants'
import { grantStepUp } from '@/server/auth/step-up'
import { makeCtx, type Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { parseApProfile, registryFlagOf } from '@/server/seed/ap-profile'
import { giveOneTimePins, randomDemoPin, takeBackOneTimePins, type OneTimePins } from '@/server/seed/pins'
import { addDays, dayIn } from '@/server/seed/supplier-portal'
import { daysBefore, type RiskAssessmentRow, type RiskOverrideRow, type RiskSheets } from '@/server/seed/risk'
import { holdRegistryFlags, seedRiskConfigRows, setRegistryFlag } from '@/server/seed/risk-rows'
import type { InputWorkbook } from '@/server/seed/workbook'
import type { RunOptions } from '../_pipeline'
import { decideTask } from '../approvals/decide'
import {
  answerRiskAssessment,
  applyRiskRegistryFlag,
  cancelRiskAssessment,
  decideRiskReview,
  fillRiskAssessmentOnBehalf,
  openRiskAssessment,
  requestRiskOverride,
  runRiskReviewDaily,
  submitRiskAssessment,
  submitRiskOverride,
} from '../risk'
import { questionnaireChecksum } from '../risk/questionnaire'
import { riskNotConfigured } from '../risk/usage'

// Supplier risk of the phase-1 organization (S11-12 · docs/sub-specs/S11.md "การอ่านชีตของไฟล์ระยะ 1"), in three steps
// around the other seeds:
//   seedRiskConfig       (base · before the modules) the tiers, gate policy and questionnaire version 1 in effect, as
//                        the organization's two ORG_ADMINs leave them after the 4-eyes of BR-RSK-02; RISK can then be on
//   seedRiskBeforeHistory (before Request_History) the completed assessments and the overrides, played with the real
//                        commands back in time, so the gate of every PO of the history finds what the sheets say (G-9 of
//                        the history: 3 of 4 · BR-RSK-15); the registry flags of sheet SupplierPayment are held back
//   seedRiskAfterHistory (after the history and the portal) the overrides expired by the daily job on their day, the
//                        assessments still open (they name nothing a PO of the history needed), and the registry flags
//                        set again and handed to job risk-status-changed's command (a RiskReview STATUS_CHANGED each)
// The flags wait because a flag blocks the gate for any date (BR-RSK-12) while the history's POs of a flagged supplier
// came before the registry said so (SP0031's H065). Nothing is sent for the past (suppressOutbox). A second run adds
// nothing: each step checks what it made.

const KEY = 'seed-risk'
const TIMEZONE = 'Asia/Bangkok'
const opts = (ref: string, step: string): RunOptions => ({ idempotencyKey: `${KEY}:${ref}:${step}`, sender: null, suppressOutbox: true })
const must = <T>(where: string, step: string, r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`${where} ขั้น ${step}: ${JSON.stringify(r.error)}`)
  return r.data
}
/** hh:mm of a day in Thai time */
const at = (day: string, hh: number, mm = 0) => new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+07:00`)

/** BR-RSK-16 in words for the seed: why RISK cannot be switched on yet, null when it can */
export async function riskReady(tx: TenantTx, now: Date): Promise<string | null> {
  const error = await riskNotConfigured(tx, now)
  return error ? `${error.code} ${error.message}` : null
}

/**
 * The tiers, policy and questionnaire version 1 of the organization in effect (what organization.set_module asks before
 * RISK is on), once (src/server/seed/risk.ts writes them; the questionnaire's checksum is the one admin.riskQuestionnaire
 * publishes with)
 */
export const seedRiskConfig = (organizationId: string, sheets: RiskSheets, orgCode: string, documentTypes: readonly LintDocumentType[], now: Date) =>
  seedRiskConfigRows(organizationId, sheets, orgCode, documentTypes, now, async (tx, id) =>
    questionnaireChecksum(await tx.riskQuestionnaire.findFirstOrThrow({ where: { id }, include: { questions: { orderBy: { sortOrder: 'asc' } } } })),
  )

// ---------- the history ----------

interface Played {
  readonly organizationId: string
  readonly now: Date
  readonly today: string
  readonly member: (code: string, where: string) => string
  readonly codeOf: ReadonlyMap<string, string>
  readonly supplierOf: (code: string, where: string) => string
}

async function playedContext(organizationId: string, now: Date): Promise<Played> {
  const db = forTenant(organizationId)
  const members = await db.member.findMany({ where: { employeeCode: { not: null } }, select: { id: true, employeeCode: true } })
  const byCode = new Map(members.map((m) => [m.employeeCode!, m.id]))
  const suppliers = new Map((await db.supplier.findMany({ select: { id: true, code: true } })).map((s) => [s.code, s.id]))
  return {
    organizationId,
    now,
    today: dayIn(now, TIMEZONE),
    member: (code, where) => {
      const id = byCode.get(code)
      if (!id) throw new Error(`${where}: ไม่มีผู้ใช้ ${code}`)
      return id
    },
    codeOf: new Map(members.map((m) => [m.id, m.employeeCode!])),
    supplierOf: (code, where) => {
      const id = suppliers.get(code)
      if (!id) throw new Error(`${where}: ไม่มีผู้ขาย ${code}`)
      return id
    },
  }
}

const memberCtx = (p: Played, code: string, now: Date, where: string): Ctx => makeCtx({ organizationId: p.organizationId, actor: { type: 'USER', memberId: p.member(code, where) }, channel: 'WEB', now })

export interface RiskHistoryReport {
  readonly seeded: boolean
  readonly assessments: Readonly<Record<string, number>>
  readonly overrides: number
  readonly registryReviews: number
}

/**
 * Before Request_History: the COMPLETED rows of Risk_Assessments (in the order they open) and the rows of Risk_Overrides
 * (in the order they are asked), with the registry flags of the suppliers held back until seedRiskAfterHistory.
 * `pin`: SEED_DEV_PIN when it is set; otherwise the approvers without a PIN hold a one-time PIN for the step-up of an
 * override's cap (FR-AUTH-005 AC2) until this returns, as the history does.
 */
export async function seedRiskBeforeHistory(organizationId: string, sheets: RiskSheets, now: Date, pin: string | null): Promise<RiskHistoryReport> {
  const db = forTenant(organizationId)
  const none: RiskHistoryReport = { seeded: false, assessments: {}, overrides: 0, registryReviews: 0 }
  if (!sheets.assessments.length && !sheets.overrides.length) return none
  if (await db.riskAssessment.findFirst({ select: { id: true } })) return none
  const p = await playedContext(organizationId, now)
  // the flag waits for the registry's own time, after the history (seedRiskAfterHistory sets it again)
  await holdRegistryFlags(organizationId)

  const assessments: Record<string, number> = {}
  const done = sheets.assessments.filter((a) => a.status === 'COMPLETED')
  for (const row of [...done].sort((a, b) => (openDay(a, p.today) < openDay(b, p.today) ? -1 : 1))) {
    await playAssessment(p, row)
    assessments[row.status] = (assessments[row.status] ?? 0) + 1
  }
  const stepUpPin = pin ?? randomDemoPin()
  let oneTime: OneTimePins = new Map()
  try {
    if (pin === null) oneTime = await giveOneTimePins(organizationId, stepUpPin, now)
    for (const row of [...sheets.overrides].sort((a, b) => b.requestedDaysAgo - a.requestedDaysAgo)) await playOverride(p, row, stepUpPin)
  } finally {
    await takeBackOneTimePins(organizationId, oneTime)
  }
  return { seeded: true, assessments, overrides: sheets.overrides.length, registryReviews: 0 }
}

/**
 * After the history and the supplier portal: the daily job of each day an override of the seed ended (EXPIRED · BR-RSK-10),
 * the assessments still open (IN_REVIEW RETURNED DRAFT CANCELLED) in the order they open, then the registry flags of
 * sheet SupplierPayment set again today with job risk-status-changed's command (BR-RSK-12 · FR-RSK-205 AC3)
 */
export async function seedRiskAfterHistory(organizationId: string, sheets: RiskSheets, workbook: InputWorkbook, now: Date): Promise<RiskHistoryReport> {
  const db = forTenant(organizationId)
  const none: RiskHistoryReport = { seeded: false, assessments: {}, overrides: 0, registryReviews: 0 }
  if (await db.riskReview.findFirst({ where: { reason: 'STATUS_CHANGED' }, select: { id: true } })) return none
  const p = await playedContext(organizationId, now)
  const open = sheets.assessments.filter((a) => a.status !== 'COMPLETED')
  if (open.length && (await db.riskAssessment.findFirst({ where: { supplierId: p.supplierOf(open[0]!.supplierCode, 'ชีต Risk_Assessments'), status: { not: 'COMPLETED' } }, select: { id: true } }))) return none

  // the morning after each override's last day, the daily job marks it EXPIRED (and what follows from that)
  const expiryDays = [...new Set(sheets.overrides.map((o) => addDays(daysBefore(p.today, o.requestedDaysAgo - o.expiresDaysAhead), 1)))].sort()
  for (const day of expiryDays) if (at(day, 6) < now) await runRiskReviewDaily(organizationId, at(day, 6), { sender: null })

  const assessments: Record<string, number> = {}
  for (const row of [...open].sort((a, b) => b.openedDaysAgo - a.openedDaysAgo)) {
    await playAssessment(p, row)
    assessments[row.status] = (assessments[row.status] ?? 0) + 1
  }

  // the registry's flags of today, each a reassessment to do (STATUS_CHANGED)
  let registryReviews = 0
  const supplierIds = new Map((await db.supplier.findMany({ select: { id: true, code: true, registryFlag: true } })).map((s) => [s.code, s]))
  for (const row of parseApProfile(workbook).payments) {
    const flag = registryFlagOf(row.registryStatus)
    const supplier = supplierIds.get(row.supplierCode)
    if (flag === 'NONE' || !supplier) continue
    if (supplier.registryFlag === 'NONE') await setRegistryFlag(organizationId, supplier.id, flag, now)
    const applied = must(`ชีต SupplierPayment ${row.supplierCode}`, 'registry flag', await applyRiskRegistryFlag(organizationId, supplier.id, flag, now, opts(row.supplierCode, 'registry')))
    if (applied.reviewId) registryReviews++
  }
  return { seeded: true, assessments, overrides: 0, registryReviews }
}

/** The day the row's assessment opens: openedDaysAgo before the seed, or before completedOn when it has one */
const openDay = (row: RiskAssessmentRow, today: string) => daysBefore(row.completedOn ?? today, row.openedDaysAgo)

/** One row of Risk_Assessments with the real commands: opened 09:00, answered 09:30, sent, decided on its day */
async function playAssessment(p: Played, row: RiskAssessmentRow): Promise<void> {
  const db = forTenant(p.organizationId)
  const where = `ชีต Risk_Assessments ${row.ref} (${row.supplierCode})`
  const supplierId = p.supplierOf(row.supplierCode, where)
  const opened = openDay(row, p.today)
  const doneDay = row.completedOn ?? (row.completedDaysAgo !== null ? daysBefore(p.today, row.completedDaysAgo) : opened)
  const openAt = at(opened, 9)
  if (openAt >= p.now) throw new Error(`${where}: วันเปิดใบต้องอยู่ก่อนวัน seed`)
  const version = async (id: string) => (await db.riskAssessment.findUniqueOrThrow({ where: { id }, select: { version: true } })).version
  const a = must(
    where,
    'open',
    await openRiskAssessment(memberCtx(p, row.openedBy, openAt, where), { supplierId, screening: row.screening, categoryCodes: [...row.categoryCodes], workScopes: [...row.workScopes] }, opts(row.ref, 'open')),
  )
  if (row.status === 'DRAFT') return
  if (row.status === 'CANCELLED') {
    must(where, 'cancel', await cancelRiskAssessment(memberCtx(p, row.openedBy, at(opened, 11), where), { assessmentId: a.assessmentId, expectedVersion: await version(a.assessmentId), reason: 'ผู้ขายไม่ได้รับงานนี้แล้ว' }, opts(row.ref, 'cancel')))
    return
  }

  // who answers: PROCUREMENT for the supplier, or the supplier's contact in the portal (BR-RSK-17)
  const contact = row.filledOnBehalf ? null : await db.supplierContact.findFirst({ where: { supplierId, status: 'ACTIVE' }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], select: { id: true } })
  if (!row.filledOnBehalf && !contact) throw new Error(`${where}: ผู้ขายไม่มีผู้ติดต่อในชีต Supplier_Contacts ให้ตอบในพอร์ทัล (ใส่ filledOnBehalf หรือเพิ่มผู้ติดต่อ)`)
  const noReviewers = row.status === 'COMPLETED' && row.reviewers.length === 0
  const sendAt = noReviewers ? at(doneDay, 9, 30) : at(opened, 9, 30)
  const answerer = (t: Date): Ctx =>
    contact ? makeCtx({ organizationId: p.organizationId, actor: { type: 'SUPPLIER', supplierContactId: contact.id, supplierId }, channel: 'PORTAL', now: t }) : memberCtx(p, row.filledOnBehalf!, t, where)
  const answers = Object.entries(row.answers).map(([questionCode, optionCode]) => ({ questionCode, optionCode }))
  const answer = contact ? answerRiskAssessment : fillRiskAssessmentOnBehalf
  must(where, 'answer', await answer(answerer(sendAt), { assessmentId: a.assessmentId, expectedVersion: await version(a.assessmentId), answers }, opts(row.ref, 'answer')))
  const sent = must(where, 'submit', await submitRiskAssessment(answerer(new Date(sendAt.getTime() + 10 * MS_PER_MINUTE)), { assessmentId: a.assessmentId, expectedVersion: await version(a.assessmentId) }, opts(row.ref, 'submit')))

  if (sent.status === 'IN_REVIEW') {
    const tasks = await db.reviewTask.findMany({ where: { assessmentId: a.assessmentId, status: 'OPEN' }, orderBy: { slotNo: 'asc' }, select: { id: true, assigneeMemberId: true } })
    const assignees = tasks.map((t) => p.codeOf.get(t.assigneeMemberId ?? '') ?? '?')
    if ([...assignees].sort().join(' ') !== [...row.reviewers].sort().join(' ')) throw new Error(`${where}: ผู้ตรวจตาม workflow คือ ${assignees.join(' · ')} ไม่ตรงคอลัมน์ reviewers (${row.reviewers.join(' · ')}) · แก้ชีต Risk_Reviewers หรือแถวนี้`)
    if (row.status === 'IN_REVIEW') return
    const decideDay = row.status === 'COMPLETED' ? doneDay : addDays(opened, 1)
    for (const [i, t] of tasks.entries()) {
      const code = assignees[i]!
      const decideAt = at(decideDay, 10, 30 * i)
      const returning = row.status === 'RETURNED' && i === 0
      must(
        where,
        `review ${code}`,
        await decideRiskReview(memberCtx(p, code, decideAt, where), { taskId: t.id, decision: returning ? 'RETURN' : 'PASS', ...(returning ? { reason: 'ขอสำเนาบัตรผ่านเข้าพื้นที่และหลักฐานการอบรมความปลอดภัยของพนักงาน', shareWithSupplier: true } : {}) }, opts(row.ref, `review-${i}`)),
      )
      if (returning) break
    }
  }
  const final = await db.riskAssessment.findUniqueOrThrow({ where: { id: a.assessmentId }, select: { status: true, pointsTotal: true, tier: true, completedAt: true } })
  if (final.status !== row.status) throw new Error(`${where}: เล่นแล้วได้สถานะ ${final.status} ไม่ใช่ ${row.status}`)
  if (row.status === 'COMPLETED') {
    if (final.pointsTotal !== row.expectedPoints || final.tier !== row.expectedTier) throw new Error(`${where}: ได้ ${final.pointsTotal} คะแนน ระดับ ${final.tier} ไม่ตรงที่คาด ${row.expectedPoints} ${row.expectedTier}`)
    if (!final.completedAt || dayIn(final.completedAt, TIMEZONE) !== doneDay) throw new Error(`${where}: เสร็จวันที่ ${final.completedAt ? dayIn(final.completedAt, TIMEZONE) : '-'} ไม่ใช่ ${doneDay}`)
  }
}

/** One row of Risk_Overrides: asked 09:00, sent 09:30, approved by its DOA approver at 14:00 with the PIN when the cap asks */
async function playOverride(p: Played, row: RiskOverrideRow, pin: string): Promise<void> {
  const db = forTenant(p.organizationId)
  const where = `ชีต Risk_Overrides ${row.ref} (${row.supplierCode})`
  const asked = daysBefore(p.today, row.requestedDaysAgo)
  const supplierId = p.supplierOf(row.supplierCode, where)
  const requester = (t: Date) => memberCtx(p, row.requestedBy, t, where)
  const { overrideId } = must(
    where,
    'request',
    await requestRiskOverride(requester(at(asked, 9)), { supplierId, reason: row.reason, capGross: row.capGross, expiresOn: addDays(asked, row.expiresDaysAhead) }, opts(row.ref, 'request')),
  )
  const version = async () => (await db.riskOverride.findUniqueOrThrow({ where: { id: overrideId }, select: { version: true } })).version
  must(where, 'submit', await submitRiskOverride(requester(at(asked, 9, 30)), { overrideId, expectedVersion: await version() }, opts(row.ref, 'submit')))
  const task = await db.approvalTask.findFirstOrThrow({
    where: { status: 'OPEN', step: { route: { subjectType: 'RISK_OVERRIDE', subjectId: overrideId } } },
    select: { id: true, assignee: { select: { id: true, employeeCode: true } }, step: { select: { route: { select: { amountSatang: true, doaVersion: { select: { stepUpThresholdSatang: true } } } } } } },
  })
  if (task.assignee.employeeCode !== row.approver) throw new Error(`${where}: DOA ส่งให้ ${task.assignee.employeeCode} อนุมัติ ไม่ใช่ ${row.approver} · แก้คอลัมน์ approver หรือข้อ RO ในชีต DOA`)
  if (stepUpNeeded({ subjectType: 'RISK_OVERRIDE', amountSatang: task.step.route.amountSatang, stepUpThresholdSatang: task.step.route.doaVersion.stepUpThresholdSatang })) {
    const granted = await grantStepUp({ organizationId: p.organizationId, memberId: task.assignee.id, subjectType: 'RISK_OVERRIDE', subjectId: overrideId, method: 'PIN', pin, channel: 'WEB' }, systemClock.now(), { sender: null })
    if (!granted.ok) throw new Error(`${where}: ${row.approver} ยืนยัน PIN ไม่ผ่าน (${granted.reason})`)
  }
  must(where, 'approve', await decideTask(memberCtx(p, row.approver, at(asked, 14), where), { taskId: task.id, decision: 'APPROVE' }, opts(row.ref, 'approve')))
  const made = await db.riskOverride.findUniqueOrThrow({ where: { id: overrideId }, select: { status: true, number: true } })
  if (made.status !== 'APPROVED') throw new Error(`${where}: อนุมัติแล้วได้สถานะ ${made.status}`)
  // the running number is the sheet's; its year is the Buddhist year of the day it was asked (BR-RSK-10 · numbering.RO)
  if (made.number?.slice(-5) !== row.ref.slice(-5)) throw new Error(`${where}: ได้เลข ${made.number} ไม่ตรงลำดับของชีต (${row.ref})`)
}
