import { TZDate } from '@date-fns/tz'
import { stepUpNeeded } from '@/core/pin'
import { WEEKDAYS, type BusinessCalendar } from '@/core/sla'
import { setEmailProvider } from '@/integrations/email-provider'
import { systemClock } from '@/lib/clock'
import { MS_PER_MINUTE } from '@/lib/constants'
import { grantStepUp } from '@/server/auth/step-up'
import { makeCtx, type Ctx } from '@/server/context'
import { loadBusinessCalendar } from '@/server/doa/policy'
import { forTenant } from '@/server/db/tenant'
import { sendSupplierNotice } from '@/server/notifications/supplier-notices'
import { giveOneTimePins, randomDemoPin, takeBackOneTimePins, type OneTimePins } from '@/server/seed/pins'
import type { SourcingScenarioRow, SourcingSheets, SourcingSupplierRow } from '@/server/seed/sourcing'
import { addDays, dayIn } from '@/server/seed/supplier-portal'
import type { RunOptions } from '../_pipeline'
import { decideTask } from '../approvals/decide'
import { answerQuestion, askQuestion, closeRfxAt, concludeRfx, createAward, createRfx, inviteToRfx, openRfx, rankingOf, setScorecard, submitAward, submitBid, submitScores } from '../sourcing'
import { playApplication, type ApplicationPlayRow } from './supplier-portal'

// The sourcing of the phase-1 organization (S10-14 · docs/sub-specs/S10.md "การอ่านชีตของไฟล์ระยะ 1"), after the history
// of requests and of the supplier portal: the foreign supplier of sheet RFx_Suppliers through S7's application commands
// (playApplication), then the RFx of sheet RFx_Scenarios with the real commands back in time, in the order they open so
// their numbers come out in that order (BR-NUM-01): created, invited, scored and opened by procurement, asked and bid by
// the suppliers' contacts in the portal, closed by the job, scored by the evaluators, awarded and sent, approved by the
// holder of the RA rule with a PIN step-up as on the screen (FR-AUTH-005 AC2), or an RFI concluded. An RFx played live
// (demoLive) stops at OPEN on the seed's business day, its invitations left for the job to e-mail; the e-mails of the
// past go out through a sender that sends nothing, at the time of their step, so no supplier hears of them. Times are
// business days after the opening, which opens some business days before the seed's (scripts/inputs_p1/p1_sourcing.py).
// A second run adds nothing.

export interface SourcingHistoryReport {
  readonly seeded: boolean
  readonly foreignSuppliers: number
  /** RFx ref → number and status after the seed */
  readonly rfx: Readonly<Record<string, string>>
}

const KEY = 'seed-sourcing'
const opts = (ref: string, step: string): RunOptions => ({ idempotencyKey: `${KEY}:${ref}:${step}`, sender: null, suppressOutbox: true })
/** A time of day the RFx are counted from: the seed's business day is the latest one whose 10:00 has passed */
const ANCHOR_TIME = '10:00'

export interface SourcingHistoryOptions {
  /** The PIN the seed gave the approvers (SEED_DEV_PIN), or null: then they hold a one-time PIN while it runs */
  readonly pin: string | null
  /** Request_History ref → title: the history makes each request under its row's title (src/server/services/demo-history) */
  readonly historyTitles: ReadonlyMap<string, string>
}

export async function seedSourcingHistory(organizationId: string, sheets: SourcingSheets, now: Date, options: SourcingHistoryOptions): Promise<SourcingHistoryReport> {
  const db = forTenant(organizationId)
  if (!(await db.orgModule.findFirst({ where: { module: 'SOURCING', enabled: true }, select: { id: true } }))) throw new Error('ชีต RFx_Scenarios: องค์กรยังไม่ได้เปิดโมดูล SOURCING (P1_SEED_MODULES · ต้องมีข้อ RA ในชีต DOA)')
  if ((await db.rfxEvent.count()) > 0) return { seeded: false, foreignSuppliers: 0, rfx: {} }
  const calendar = await db.$transaction((tx) => loadBusinessCalendar(tx, organizationId))
  const members = new Map((await db.member.findMany({ select: { id: true, employeeCode: true } })).filter((m) => m.employeeCode).map((m) => [m.employeeCode!, m.id]))
  const memberOf = (code: string | null, where: string) => {
    const id = code ? members.get(code) : undefined
    if (!id) throw new Error(`${where}: ไม่มีผู้ใช้ ${code ?? '(ว่าง)'} · แก้ scripts/inputs_p1/p1_sourcing.py`)
    return id
  }

  // 1. the foreign supplier, approved through S7's application (FR-INT-201 · BR-SUP-02)
  const foreign = new Map<string, string>()
  for (const row of sheets.suppliers) {
    if (!(await db.supplierContact.findFirst({ where: { email: row.contactEmail }, select: { id: true } }))) await playApplication(organizationId, applicationOf(row), now, calendar, memberOf, 'RFx_Suppliers')
    const contact = await db.supplierContact.findFirst({ where: { email: row.contactEmail }, select: { supplierId: true } })
    if (!contact?.supplierId) throw new Error(`ชีต RFx_Suppliers ${row.ref}: เล่นใบสมัครแล้วยังไม่เป็นผู้ขาย`)
    foreign.set(row.ref, contact.supplierId)
  }

  // 2. the RFx in the order they open, with the approvers holding the PIN they step up with
  const pin = options.pin ?? randomDemoPin()
  let oneTime: OneTimePins = new Map()
  const rfx: Record<string, string> = {}
  try {
    if (options.pin === null) oneTime = await giveOneTimePins(organizationId, pin, now)
    const play = new RfxPlayer(organizationId, sheets, calendar, now, memberOf, foreign, pin, options.historyTitles)
    const ordered = [...sheets.scenarios].sort((a, b) => b.openBusinessDaysAgo - a.openBusinessDaysAgo || a.ref.localeCompare(b.ref))
    for (const row of ordered) rfx[row.ref] = await play.scenario(row)
    // BR-NUM-01: the numbers of the year come out in the order of opening, as the sheet expects (a seed whose RFx open in
    // two Buddhist years starts the second year's numbers again, so only one year's are compared)
    const numbers = ordered.map((r) => ({ want: r.expectedNumber, got: rfx[r.ref]!.split(' ')[0]! }))
    if (new Set(numbers.map((n) => n.got.split('-')[1])).size === 1) {
      const wrong = numbers.filter((n) => n.got.slice(-5) !== n.want.slice(-5))
      if (wrong.length) throw new Error(`ชีต RFx_Scenarios: เลข RFx ${wrong.map((n) => `${n.got} (คาด ${n.want})`).join(', ')} ไม่ตรงลำดับที่คาด`)
    }
  } finally {
    await takeBackOneTimePins(organizationId, oneTime)
  }
  return { seeded: true, foreignSuppliers: foreign.size, rfx }
}

/** A row of RFx_Suppliers as a row of S7's applications, approved by the holder of SA-01 */
function applicationOf(row: SourcingSupplierRow): ApplicationPlayRow {
  return {
    ref: row.ref,
    kind: 'NEW',
    nameTh: row.nameTh ?? row.nameEn,
    nameEn: row.nameEn,
    taxId: null,
    branchCode: '00000',
    payeeType: 'FOREIGN',
    category: row.category,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    contactLocale: row.contactLocale,
    inviterPhone: null,
    invitedBy: row.invitedBy,
    routedBy: row.routedBy,
    verifiedBy: row.verifiedBy,
    invitedDaysAgo: row.invitedDaysAgo,
    lastActivityDaysAgo: null,
    status: 'APPROVED',
    filledOnBehalf: null,
    missingDocs: [],
    expectedApprover: row.expectedApprover,
    expectedG7Days: row.expectedG7Days,
  }
}

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; details?: unknown } }

class RfxPlayer {
  private readonly db
  private readonly anchor: string

  constructor(
    private readonly organizationId: string,
    private readonly sheets: SourcingSheets,
    private readonly calendar: BusinessCalendar,
    private readonly now: Date,
    private readonly memberOf: (code: string | null, where: string) => string,
    private readonly foreign: ReadonlyMap<string, string>,
    private readonly pin: string,
    private readonly historyTitles: ReadonlyMap<string, string>,
  ) {
    this.db = forTenant(organizationId)
    // the seed's business day: the latest one whose ANCHOR_TIME has passed, so an RFx opened that day opened already
    let day = dayIn(now, calendar.timezone)
    for (let guard = 0; !this.isBusinessDay(day) || this.at(day, ANCHOR_TIME) > now; guard++) {
      if (guard > 366) throw new Error('ปฏิทินขององค์กรไม่มีวันทำการในหนึ่งปีก่อนวัน seed')
      day = addDays(day, -1)
    }
    this.anchor = day
  }

  private isBusinessDay(day: string): boolean {
    return this.calendar.workdays.includes(WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()]!) && !this.calendar.holidays.includes(day)
  }

  /** The business day `k` business days after (or before, k < 0) a business day */
  private shift(day: string, k: number): string {
    let d = day
    for (let left = Math.abs(k); left > 0; ) {
      d = addDays(d, Math.sign(k))
      if (this.isBusinessDay(d)) left--
    }
    return d
  }

  private at(day: string, hhmm: string): Date {
    const [y, m, d] = day.split('-').map(Number) as [number, number, number]
    const [h, min] = hhmm.split(':').map(Number) as [number, number]
    return new Date(new TZDate(y, m - 1, d, h, min, this.calendar.timezone).getTime())
  }

  private member(code: string, at: Date, where: string): Ctx {
    return makeCtx({ organizationId: this.organizationId, actor: { type: 'USER', memberId: this.memberOf(code, where) }, channel: 'WEB', now: at })
  }

  private supplierId(code: string, where: string): Promise<string> {
    const known = this.foreign.get(code)
    if (known) return Promise.resolve(known)
    return this.db.supplier.findFirst({ where: { code }, select: { id: true } }).then((s) => {
      if (!s) throw new Error(`${where}: ไม่มีผู้ขาย ${code}`)
      return s.id
    })
  }

  private async contactOf(supplierId: string, at: Date, where: string): Promise<Ctx> {
    const contact = await this.db.supplierContact.findFirst({ where: { supplierId, isPrimary: true, portalEnabled: true }, select: { id: true, supplierId: true, applicationId: true } })
    if (!contact) throw new Error(`${where}: ผู้ขายไม่มีผู้ติดต่อหลักที่เข้าพอร์ทัลได้ (ชีต Supplier_Contacts)`)
    // the contact as a portal request makes it (src/server/portal/session.ts portalCtx, which services do not import)
    return makeCtx({ organizationId: this.organizationId, actor: { type: 'SUPPLIER', supplierContactId: contact.id, ...(contact.supplierId ? { supplierId: contact.supplierId } : {}) }, channel: 'PORTAL', now: at })
  }

  private must<T>(where: string, step: string, r: Result<T>): T {
    if (!r.ok) throw new Error(`${where} ขั้น ${step}: ${r.error.code} ${JSON.stringify(r.error.details ?? {})}`)
    return r.data
  }

  private version(rfxEventId: string): Promise<number> {
    return this.db.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId }, select: { version: true } }).then((r) => r.version)
  }

  /**
   * The e-mails to the suppliers a step of the past wrote, sent at that step's time through a sender that sends nothing,
   * so the job finds none PENDING and no supplier of the demo hears of an RFx of the past (as the history's invoices)
   */
  private async sendPast(subjectIds: readonly string[], at: Date): Promise<void> {
    const pending = await this.db.supplierNotice.findMany({ where: { status: 'PENDING', subjectId: { in: [...subjectIds] } }, orderBy: { createdAt: 'asc' }, select: { id: true } })
    if (!pending.length) return
    setEmailProvider({ send: async () => ({ messageId: KEY }) })
    try {
      for (const n of pending) await sendSupplierNotice(this.organizationId, n.id, at)
    } finally {
      setEmailProvider(null)
    }
  }

  /** Plays one RFx; returns its number and status */
  async scenario(row: SourcingScenarioRow): Promise<string> {
    const where = `ชีต RFx_Scenarios ${row.ref}`
    const ref = row.ref
    const openDay = this.shift(this.anchor, -row.openBusinessDaysAgo)
    const openedAt = this.at(openDay, row.openTime)
    const closesAt = this.at(this.shift(openDay, row.closeAfterBusinessDays), row.closeTime)
    const creator = (at: Date) => this.member(row.creator, at, where)
    const before = (minutes: number) => new Date(openedAt.getTime() - minutes * MS_PER_MINUTE)

    // created, invited and scored by procurement before it opens
    const source = row.sourceKind === 'REQUEST_LINES' ? { kind: 'REQUEST_LINES' as const, requestLineIds: await this.requestLines(row, where) } : { kind: 'NEED' as const, categoryCode: row.categoryCode, lines: await this.needLines(row, where) }
    const { rfxEventId } = this.must(where, 'create', await createRfx(creator(before(90)), { kind: row.kind, title: row.title, ...(row.titleEn ? { titleEn: row.titleEn } : {}), description: row.description, source, allowVatInclusiveBids: row.allowVatInclusiveBids }, opts(ref, 'create')))
    const subjects = [rfxEventId]
    const invited = new Map<string, string>()
    for (const code of row.invitedSuppliers) {
      const supplierId = await this.supplierId(code, where)
      this.must(where, `invite ${code}`, await inviteToRfx(creator(before(60)), { rfxEventId, expectedVersion: await this.version(rfxEventId), supplierId }, opts(ref, `invite-${code}`)))
      invited.set(code, supplierId)
    }
    if (row.kind !== 'RFI') {
      const criteria = (row.weightsJson ?? []).map((w) => ({ code: w.code, nameTh: w.nameTh, weightBp: w.weightBp, kind: w.code === 'PRICE' ? ('PRICE' as const) : ('QUALITY' as const) }))
      const evaluatorMemberIds = row.evaluators.map((c) => this.memberOf(c, where))
      this.must(where, 'scorecard', await setScorecard(creator(before(30)), { rfxEventId, expectedVersion: await this.version(rfxEventId), criteria, evaluatorMemberIds }, opts(ref, 'scorecard')))
    }
    const opened = this.must(where, 'open', await openRfx(creator(openedAt), { rfxEventId, expectedVersion: await this.version(rfxEventId), closesAt: closesAt.toISOString() }, opts(ref, 'open')))
    void opened
    const number = (await this.db.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId }, select: { number: true } })).number ?? '-'
    // played live in the demo: its invitations go out with the job, to the suppliers' contacts (scene 9)
    if (row.demoLive) return this.finish(row, rfxEventId, number)
    await this.sendPast(subjects, openedAt)

    // questions answered to everyone before the cutoff (BR-RFX-04)
    for (const [i, q] of (row.questionsJson ?? []).entries()) {
      const askedAt = this.at(this.shift(openDay, q.afterBusinessDays), '10:00')
      const supplierId = invited.get(q.supplier)
      if (!supplierId) throw new Error(`${where}: คำถามจาก ${q.supplier} ที่ไม่ได้เชิญ`)
      const { questionId } = this.must(where, `ask ${i + 1}`, await askQuestion(await this.contactOf(supplierId, askedAt, where), { rfxEventId, question: q.question }, opts(ref, `ask-${i + 1}`)))
      const answeredAt = new Date(askedAt.getTime() + 180 * MS_PER_MINUTE)
      this.must(where, `answer ${i + 1}`, await answerQuestion(creator(answeredAt), { rfxEventId, questionId, answer: q.answer }, opts(ref, `answer-${i + 1}`)))
      await this.sendPast(subjects, answeredAt)
    }

    // the bids, in the portal by each supplier's contact, in the order they came
    const lines = await this.db.rfxLine.findMany({ where: { rfxEventId }, orderBy: { lineNo: 'asc' }, select: { id: true, lineNo: true } })
    const bySupplier = new Map<string, { at: Date; includesVat: boolean; deliveryDays: number | null; prices: Map<number, string> }>()
    for (const b of this.sheets.bids.filter((x) => x.rfxRef === ref)) {
      const e = bySupplier.get(b.supplier) ?? { at: this.at(this.shift(openDay, b.submitAfterBusinessDays), b.submitTime), includesVat: b.includesVat, deliveryDays: b.deliveryDays, prices: new Map() }
      e.prices.set(b.lineNo, b.unitPrice)
      bySupplier.set(b.supplier, e)
    }
    const bids = new Map<string, string>()
    for (const [code, b] of [...bySupplier.entries()].sort((x, y) => x[1].at.getTime() - y[1].at.getTime())) {
      const supplierId = invited.get(code)
      if (!supplierId) throw new Error(`${where}: ข้อเสนอของ ${code} ที่ไม่ได้เชิญ`)
      const bidLines = lines.map((l) => {
        const unitPrice = b.prices.get(l.lineNo)
        if (!unitPrice) throw new Error(`${where}: ข้อเสนอของ ${code} ไม่มีบรรทัดที่ ${l.lineNo}`)
        return { rfxLineId: l.id, offered: true, unitPrice }
      })
      const { bidId } = this.must(where, `bid ${code}`, await submitBid(await this.contactOf(supplierId, b.at, where), { rfxEventId, priceIncludesVat: b.includesVat, ...(b.deliveryDays !== null ? { deliveryDays: b.deliveryDays } : {}), lines: bidLines }, opts(ref, `bid-${code}`)))
      bids.set(code, bidId)
      subjects.push(bidId)
      await this.sendPast(subjects, b.at)
    }

    // closed by the job at closesAt (the scores of a price-only RFQ revealed with it · BR-RFX-09)
    const closed = await closeRfxAt(this.organizationId, rfxEventId, closesAt.toISOString(), new Date(closesAt.getTime() + MS_PER_MINUTE))
    if (!closed.closed) throw new Error(`${where} ขั้น close: ${closed.reason ?? 'ไม่ปิด'}`)
    await this.sendPast(subjects, closesAt)
    if (row.decideAfterBusinessDays === null || !row.decideTime) throw new Error(`${where}: ต้องมี decideAfterBusinessDays และ decideTime`)
    const decidedAt = this.at(this.shift(openDay, row.decideAfterBusinessDays), row.decideTime)

    // an RFI ends with procurement's summary (BR-RFX-02)
    if (row.kind === 'RFI') {
      this.must(where, 'conclude', await concludeRfx(creator(decidedAt), { rfxEventId, expectedVersion: await this.version(rfxEventId), conclusionNote: row.conclusionNote ?? 'สรุปผลการสำรวจข้อมูล' }, opts(ref, 'conclude')))
      await this.sendPast(subjects, decidedAt)
      return this.finish(row, rfxEventId, number)
    }

    // the evaluators' scores, before the award is made (each on their own · BR-RFX-18)
    if (row.awardAfterBusinessDays === null || !row.awardTime) throw new Error(`${where}: ต้องมี awardAfterBusinessDays และ awardTime`)
    const awardAt = this.at(this.shift(openDay, row.awardAfterBusinessDays), row.awardTime)
    const criteria = (row.weightsJson ?? []).filter((w) => w.code !== 'PRICE').map((w) => w.code)
    for (const [i, evaluator] of row.evaluators.entries()) {
      const scoredAt = new Date(awardAt.getTime() - (row.evaluators.length - i) * 60 * MS_PER_MINUTE)
      const entries = this.sheets.scores
        .filter((s) => s.rfxRef === ref && s.evaluator === evaluator && criteria.includes(s.criterion))
        .map((s) => {
          const bidId = bids.get(s.supplier)
          if (!bidId) throw new Error(`${where}: คะแนนของ ${s.supplier} ที่ไม่มีข้อเสนอ`)
          return { bidId, criterionCode: s.criterion, score: s.score }
        })
      this.must(where, `score ${evaluator}`, await submitScores(this.member(evaluator, scoredAt, where), { rfxEventId, entries }, opts(ref, `score-${evaluator}`)))
    }

    // the award of every line to the top of the ranking, sent by its creator (BR-RFX-12)
    const card = await this.db.scorecard.findFirstOrThrow({ where: { rfxEventId }, select: { id: true, status: true } })
    if (card.status !== 'REVEALED') throw new Error(`${where}: คะแนนยังไม่เปิดเผยหลังผู้ประเมินส่งครบ (${card.status})`)
    const ranking = await this.db.$transaction((tx) => rankingOf(tx, card.id))
    const top = ranking.rows[0]
    const winner = top ? [...bids.entries()].find(([, id]) => id === top.bidId)?.[0] : undefined
    if (!top || winner !== row.expectedWinner) throw new Error(`${where}: ผู้ชนะตามคะแนนคือ ${winner ?? '-'} ไม่ใช่ ${row.expectedWinner ?? '-'}`)
    const { awardDecisionId } = this.must(where, 'award', await createAward(creator(awardAt), { rfxEventId, lines: lines.map((l) => ({ rfxLineId: l.id, bidId: top.bidId })), ...(row.awardReason ? { reason: row.awardReason } : {}) }, opts(ref, 'award')))
    subjects.push(awardDecisionId)
    const awardVersion = (await this.db.awardDecision.findUniqueOrThrow({ where: { id: awardDecisionId }, select: { version: true } })).version
    const submittedAt = new Date(awardAt.getTime() + 30 * MS_PER_MINUTE)
    this.must(where, 'award submit', await submitAward(creator(submittedAt), { awardDecisionId, version: awardVersion }, opts(ref, 'award-submit')))

    // approved by the holder of the RA rule, with the PIN the screen asks for at or above stepUpThreshold
    const task = await this.db.approvalTask.findFirstOrThrow({
      where: { status: 'OPEN', step: { route: { subjectType: 'AWARD_DECISION', subjectId: awardDecisionId } } },
      select: { id: true, assignee: { select: { id: true, employeeCode: true } }, step: { select: { route: { select: { ruleCode: true, amountSatang: true, doaVersion: { select: { stepUpThresholdSatang: true } } } } } } },
    })
    const routeOf = task.step.route
    if (row.expectedRule && routeOf.ruleCode !== row.expectedRule) throw new Error(`${where}: ผลมอบงานไปข้อ ${routeOf.ruleCode} ไม่ใช่ ${row.expectedRule}`)
    if (row.expectedApprover && task.assignee.employeeCode !== row.expectedApprover) throw new Error(`${where}: ผู้อนุมัติเป็น ${task.assignee.employeeCode} ไม่ใช่ ${row.expectedApprover}`)
    if (stepUpNeeded({ subjectType: 'AWARD_DECISION', amountSatang: routeOf.amountSatang, stepUpThresholdSatang: routeOf.doaVersion.stepUpThresholdSatang })) {
      // the step-up runs on the real clock, as its 5-minute window is a security timer; the decision keeps its business time
      const granted = await grantStepUp({ organizationId: this.organizationId, memberId: task.assignee.id, subjectType: 'AWARD_DECISION', subjectId: awardDecisionId, method: 'PIN', pin: this.pin, channel: 'WEB' }, systemClock.now(), { sender: null })
      if (!granted.ok) throw new Error(`${where}: การยืนยัน PIN ของ ${task.assignee.employeeCode} ถูกปฏิเสธ (${granted.reason})`)
    }
    const decided = await decideTask(this.member(task.assignee.employeeCode!, decidedAt, where), { taskId: task.id, decision: 'APPROVE' }, opts(ref, 'approve'))
    this.must(where, 'approve', decided)
    await this.sendPast(subjects, decidedAt)
    return this.finish(row, rfxEventId, number)
  }

  private async finish(row: SourcingScenarioRow, rfxEventId: string, number: string): Promise<string> {
    const { status } = await this.db.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId }, select: { status: true } })
    if (status !== row.expectedStatus) throw new Error(`ชีต RFx_Scenarios ${row.ref}: เล่นแล้วได้สถานะ ${status} ไม่ใช่ ${row.expectedStatus}`)
    return `${number} ${status}`
  }

  /** The lines of the history's requests of the row, approved and waiting in the pool (P1-02 leaves them without a supplier) */
  private async requestLines(row: SourcingScenarioRow, where: string): Promise<string[]> {
    const ids: string[] = []
    for (const ref of row.historyRefs) {
      const title = this.historyTitles.get(ref)
      if (!title) throw new Error(`${where}: ไม่มี ${ref} ในชีต Request_History`)
      const request = await this.db.request.findFirst({ where: { title }, select: { status: true, lines: { select: { id: true }, orderBy: { lineNo: 'asc' } } } })
      if (!request) throw new Error(`${where}: ยังไม่มีคำขอของ ${ref} (seed ประวัติคำขอก่อน)`)
      ids.push(...request.lines.map((l) => l.id))
    }
    return ids
  }

  private async needLines(row: SourcingScenarioRow, where: string) {
    const out = []
    for (const l of row.needLines ?? []) {
      const item = l.catalogItemCode ? await this.db.catalogItem.findFirst({ where: { code: l.catalogItemCode }, select: { id: true } }) : null
      if (l.catalogItemCode && !item) throw new Error(`${where}: ไม่มีรายการ ${l.catalogItemCode} ในแคตตาล็อก (ชีต Items)`)
      out.push({
        description: l.description,
        ...(l.descriptionEn ? { descriptionEn: l.descriptionEn } : {}),
        quantity: l.quantity,
        uom: l.uom,
        ...(l.uomEn ? { uomEn: l.uomEn } : {}),
        ...(item ? { catalogItemId: item.id } : {}),
        ...(l.refUnitPrice ? { refUnitPrice: l.refUnitPrice } : {}),
      })
    }
    return out
  }
}
