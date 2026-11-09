import { delegateFor } from '@/core/delegation'
import type { DelegationSnapshot } from '@/core/doa/types'
import { delegationCoversReview, questionsInSet, type RiskDomain, type RiskQuestionDef, type RiskTierCode, type Screening } from '@/core/risk'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'

// What a reviewer of a supplier risk assessment reads (S11-06 · BR-RSK-08 · INV-RSK-05 · FR-RSK-202 AC4): their tasks, and
// one task's page — the questions, answers and evidence of GENERAL and the slot's own domains, the other slots' state
// without their answers or reasons. Every function here reads from the member of `ctx` and returns only what a task of
// theirs shows: a task they do not hold reads as missing. The service (risk.review.view) asks the right first; this file
// is what tests/integration/risk-review-visibility.test.ts walks with the context of every slot (INV-RSK-05).

const LIVE_DELEGATIONS = ['SCHEDULED', 'ACTIVE'] as const

/** The parts of an assessment a slot's reviewer sees (BR-RSK-08): GENERAL and the slot's domains */
export const domainsSeenBy = (riskDomains: readonly string[]): RiskDomain[] => [...new Set(['GENERAL', ...riskDomains])] as RiskDomain[]

/** Who prepared an assessment: who opened it and every member who filled it in for the supplier (BR-SOD-16) */
export function assessmentPreparers(a: { readonly openedById: string; readonly filledOnBehalfById: string | null; readonly answers: ReadonlyArray<{ readonly answeredByMemberId: string | null }> }): string[] {
  return [...new Set([a.openedById, a.filledOnBehalfById, ...a.answers.map((x) => x.answeredByMemberId)].filter((m): m is string => typeof m === 'string'))]
}

/** The delegations that act for a reviewer: no document type and no amount (BR-RSK-07 · BR-DLG-01) */
async function reviewDelegations(tx: TenantTx, delegatorMemberIds: readonly string[]): Promise<DelegationSnapshot[]> {
  const rows = await tx.delegation.findMany({ where: { delegatorMemberId: { in: [...delegatorMemberIds] }, status: { in: [...LIVE_DELEGATIONS] }, revokedAt: null } })
  return rows
    .map((d) => ({
      id: d.id,
      delegatorMemberId: d.delegatorMemberId,
      delegateMemberId: d.delegateMemberId,
      startsAt: d.startsAt,
      endsAt: d.endsAt,
      documentTypes: d.documentTypes.length ? (d.documentTypes as unknown as DelegationSnapshot['documentTypes']) : null,
      maxAmountSatang: d.maxAmountSatang,
      status: d.status as DelegationSnapshot['status'],
    }))
    .filter(delegationCoversReview)
}

/**
 * Who may decide a reviewer's task at `at` (INV-RSK-04): its holder, the holder it fell to an acting holder for, and
 * whoever acts for the holder now through a delegation of no document type and no amount, unless they prepared the
 * assessment (BR-DLG-05). The one rule of the decision (riskReview.decide) and of these pages.
 */
export async function reviewDecidersIn(
  tx: TenantTx,
  task: { readonly assigneeMemberId: string; readonly delegatorMemberId: string | null },
  preparers: readonly string[],
  at: Date,
): Promise<string[]> {
  const delegations = await reviewDelegations(tx, [task.assigneeMemberId])
  const delegates = delegations.map((d) => d.delegateMemberId)
  const active = new Set((await tx.member.findMany({ where: { id: { in: delegates }, status: 'ACTIVE' }, select: { id: true } })).map((m) => m.id))
  const now = delegateFor({ memberId: task.assigneeMemberId, viaPosition: true }, { documentType: 'PURCHASE_REQUEST', basisAmountSatang: null, at, conflictMemberIds: [...preparers] }, delegations, (m) => active.has(m))
  return [...new Set([task.assigneeMemberId, task.delegatorMemberId, now.principalMemberId ? now.assigneeMemberId : null].filter((m): m is string => typeof m === 'string'))]
}

/** Who sees a task's page: whoever may decide it now, and whoever decided it */
async function taskReaders(tx: TenantTx, task: { assigneeMemberId: string; delegatorMemberId: string | null; decidedById: string | null }, preparers: readonly string[], at: Date): Promise<string[]> {
  return [...new Set([...(await reviewDecidersIn(tx, task, preparers, at)), ...(task.decidedById ? [task.decidedById] : [])])]
}

const memberOf = (ctx: Ctx): string | null => (ctx.actor.type === 'USER' ? ctx.actor.memberId : null)

// ---------- the list of a member's tasks ----------

export interface RiskReviewTaskRow {
  readonly taskId: string
  readonly assessmentId: string
  readonly number: string | null
  readonly supplier: { readonly code: string; readonly nameTh: string }
  readonly tier: RiskTierCode | null
  readonly riskDomains: readonly RiskDomain[]
  readonly status: 'OPEN' | 'PASSED' | 'RETURNED' | 'CANCELLED'
  readonly assignedAt: Date
  readonly dueAt: Date
  readonly decidedAt: Date | null
  /** Held for someone else: the holder the member acts for */
  readonly onBehalfOfName: string | null
}

/**
 * The member's reviewer tasks: `OPEN` those they may decide now (theirs, those that fell to them, and those of a holder
 * they act for), oldest due first; `DONE` those they decided, latest first. RISK must be on (the service checks).
 */
export async function riskReviewTasksOf(ctx: Ctx, which: 'OPEN' | 'DONE', take = 100): Promise<RiskReviewTaskRow[]> {
  const me = memberOf(ctx)
  if (!me) return []
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const select = {
      id: true,
      assessmentId: true,
      riskDomains: true,
      status: true,
      assignedAt: true,
      dueAt: true,
      decidedAt: true,
      assigneeMemberId: true,
      delegatorMemberId: true,
      assessment: { select: { number: true, tier: true, status: true, openedById: true, filledOnBehalfById: true, answers: { select: { answeredByMemberId: true } }, supplier: { select: { code: true, nameTh: true } } } },
    } as const
    let rows
    if (which === 'DONE') {
      rows = await tx.reviewTask.findMany({ where: { decidedById: me }, select, orderBy: { decidedAt: 'desc' }, take })
    } else {
      // the holders the member acts for now, by a delegation that covers a reviewer's task
      const actingFor = (await tx.delegation.findMany({ where: { delegateMemberId: me, status: { in: [...LIVE_DELEGATIONS] }, revokedAt: null, startsAt: { lte: ctx.now }, endsAt: { gt: ctx.now } }, select: { delegatorMemberId: true, documentTypes: true, maxAmountSatang: true } }))
        .filter((d) => d.documentTypes.length === 0 && d.maxAmountSatang === null)
        .map((d) => d.delegatorMemberId)
      const candidates = await tx.reviewTask.findMany({
        where: { status: 'OPEN', OR: [{ assigneeMemberId: me }, { delegatorMemberId: me }, { assigneeMemberId: { in: actingFor } }] },
        select,
        orderBy: { dueAt: 'asc' },
        take,
      })
      rows = []
      for (const t of candidates) if ((await reviewDecidersIn(tx, t, assessmentPreparers(t.assessment), ctx.now)).includes(me)) rows.push(t)
    }
    const others = [...new Set(rows.map((t) => t.assigneeMemberId).filter((m) => m !== me))]
    const names = new Map((await tx.member.findMany({ where: { id: { in: others } }, select: { id: true, displayNameTh: true } })).map((m) => [m.id, m.displayNameTh]))
    return rows.map((t) => ({
      taskId: t.id,
      assessmentId: t.assessmentId,
      number: t.assessment.number,
      supplier: t.assessment.supplier,
      tier: t.assessment.tier,
      riskDomains: t.riskDomains as RiskDomain[],
      status: t.status,
      assignedAt: t.assignedAt,
      dueAt: t.dueAt,
      decidedAt: t.decidedAt,
      onBehalfOfName: t.assigneeMemberId === me ? null : (names.get(t.assigneeMemberId) ?? null),
    }))
  })
}

// ---------- one task's page ----------

export interface ReviewAnswerDto {
  readonly optionCode: string
  readonly optionLabelTh: string
  readonly optionLabelEn: string
  readonly source: 'EXPLICIT' | 'EVIDENCE' | 'ON_BEHALF'
  readonly note: string | null
  readonly evidenceDocument: { readonly id: string; readonly documentTypeCode: string; readonly scope: string | null; readonly expiresOn: Date } | null
  readonly files: readonly { readonly fileId: string; readonly fileName: string; readonly scanStatus: string }[]
}

export interface ReviewQuestionDto {
  readonly code: string
  readonly domain: RiskDomain
  readonly textTh: string
  readonly textEn: string
  readonly answer: ReviewAnswerDto | null
}

export interface ReviewSlotStateDto {
  readonly slotNo: number
  readonly riskDomains: readonly RiskDomain[]
  readonly status: 'OPEN' | 'PASSED' | 'RETURNED' | 'CANCELLED'
  readonly mine: boolean
}

export interface RiskReviewTaskPage {
  readonly taskId: string
  readonly status: 'OPEN' | 'PASSED' | 'RETURNED' | 'CANCELLED'
  readonly slotNo: number
  readonly reviewRound: number
  readonly ruleCodes: readonly string[]
  readonly riskDomains: readonly RiskDomain[]
  readonly assignedAt: Date
  readonly dueAt: Date
  readonly decidedAt: Date | null
  readonly onBehalfOfName: string | null
  /** The reason the member gave when they returned it (their own slot only) */
  readonly myReason: string | null
  readonly assessment: {
    readonly id: string
    readonly number: string | null
    readonly status: string
    readonly supplier: { readonly code: string; readonly nameTh: string; readonly nameEn: string | null }
    readonly screening: Readonly<Record<string, string>>
    readonly categoryCodes: readonly string[]
    readonly inherentTier: RiskTierCode
    readonly tier: RiskTierCode | null
    readonly submittedAt: Date | null
  }
  readonly questions: readonly ReviewQuestionDto[]
  /** The other slots of the round: their state only (BR-RSK-08) */
  readonly slots: readonly ReviewSlotStateDto[]
  /** The member may pass or return it now: open, in review, theirs to decide and not prepared by them (the command checks again) */
  readonly canDecide: boolean
}

interface StoredOption {
  readonly code: string
  readonly points: number
  readonly labelTh: string
  readonly labelEn: string
}
const optionsOf = (json: unknown): StoredOption[] =>
  (Array.isArray(json) ? json : []).flatMap((o) => {
    const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>
    return typeof x.code === 'string' && typeof x.points === 'number' ? [{ code: x.code, points: x.points, labelTh: typeof x.labelTh === 'string' ? x.labelTh : x.code, labelEn: typeof x.labelEn === 'string' ? x.labelEn : typeof x.labelTh === 'string' ? x.labelTh : x.code }] : []
  })

/** The page of one reviewer's task, or null when the member of `ctx` neither may decide it nor decided it */
export async function riskReviewTaskPage(ctx: Ctx, taskId: string): Promise<RiskReviewTaskPage | null> {
  const me = memberOf(ctx)
  if (!me || !/^[0-9a-f-]{36}$/i.test(taskId)) return null
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const task = await tx.reviewTask.findFirst({ where: { id: taskId } })
    if (!task) return null
    const a = await tx.riskAssessment.findUniqueOrThrow({
      where: { id: task.assessmentId },
      include: { supplier: { select: { code: true, nameTh: true, nameEn: true, isForeign: true } }, questionnaire: { include: { questions: { orderBy: { sortOrder: 'asc' } } } }, answers: true },
    })
    const preparers = assessmentPreparers(a)
    const readers = await taskReaders(tx, task, preparers, ctx.now)
    if (!readers.includes(me)) return null
    const seen = domainsSeenBy(task.riskDomains)
    const definitions: RiskQuestionDef[] = a.questionnaire.questions.map((q) => ({
      code: q.code,
      domain: q.domain,
      options: optionsOf(q.options),
      appliesWhen: (q.appliesWhen as RiskQuestionDef['appliesWhen']) ?? null,
      required: q.required,
      sortOrder: q.sortOrder,
      evidenceScopeRequired: q.evidenceScopeRequired,
      evidenceScope: q.evidenceScope,
    }))
    const inSet = questionsInSet(definitions, { screening: a.screening as Screening, categoryCodes: a.categoryCodes, payeeType: a.payeeType, isForeign: a.supplier.isForeign }, a.inherentTier).filter((q) => seen.includes(q.domain))
    // only the answers and the files of the slot's own questions are read at all
    const codes = new Set(inSet.map((q) => q.code))
    const answers = a.answers.filter((x) => codes.has(x.questionCode) && x.optionCode !== null)
    const [docs, links] = await Promise.all([
      tx.supplierDocument.findMany({ where: { id: { in: answers.map((x) => x.evidenceDocumentId).filter((d): d is string => d !== null) } }, select: { id: true, documentTypeCode: true, scope: true, expiresOn: true } }),
      tx.fileLink.findMany({ where: { kind: 'RISK_EVIDENCE', subjectType: 'RiskAnswer', subjectId: { in: answers.map((x) => x.id) } }, select: { subjectId: true, file: { select: { id: true, fileName: true, scanStatus: true } } } }),
    ])
    const stored = new Map(a.questionnaire.questions.map((q) => [q.code, q]))
    const questions: ReviewQuestionDto[] = inSet.map((q) => {
      const row = stored.get(q.code)!
      const answer = answers.find((x) => x.questionCode === q.code)
      const option = answer ? optionsOf(row.options).find((o) => o.code === answer.optionCode) : undefined
      return {
        code: q.code,
        domain: q.domain,
        textTh: row.textTh,
        textEn: row.textEn,
        answer: answer
          ? {
              optionCode: answer.optionCode!,
              optionLabelTh: option?.labelTh ?? answer.optionCode!,
              optionLabelEn: option?.labelEn ?? answer.optionCode!,
              source: answer.source,
              note: answer.note,
              evidenceDocument: answer.evidenceDocumentId ? (docs.find((d) => d.id === answer.evidenceDocumentId) ?? null) : null,
              files: links.filter((l) => l.subjectId === answer.id).map((l) => ({ fileId: l.file.id, fileName: l.file.fileName, scanStatus: l.file.scanStatus })),
            }
          : null,
      }
    })
    const round = await tx.reviewTask.findMany({ where: { assessmentId: a.id, reviewRound: task.reviewRound }, select: { id: true, slotNo: true, riskDomains: true, status: true }, orderBy: { slotNo: 'asc' } })
    const myReason = task.reasonCommentId ? ((await tx.comment.findFirst({ where: { id: task.reasonCommentId, retractedAt: null }, select: { body: true } }))?.body ?? null) : null
    const onBehalfOf = task.assigneeMemberId === me ? null : await tx.member.findUnique({ where: { id: task.assigneeMemberId }, select: { displayNameTh: true } })
    const deciders = await reviewDecidersIn(tx, task, preparers, ctx.now)
    return {
      taskId: task.id,
      status: task.status,
      slotNo: task.slotNo,
      reviewRound: task.reviewRound,
      ruleCodes: task.ruleCodes,
      riskDomains: task.riskDomains as RiskDomain[],
      assignedAt: task.assignedAt,
      dueAt: task.dueAt,
      decidedAt: task.decidedAt,
      onBehalfOfName: onBehalfOf?.displayNameTh ?? null,
      myReason,
      assessment: {
        id: a.id,
        number: a.number,
        status: a.status,
        supplier: { code: a.supplier.code, nameTh: a.supplier.nameTh, nameEn: a.supplier.nameEn },
        screening: (a.screening ?? {}) as Record<string, string>,
        categoryCodes: a.categoryCodes,
        inherentTier: a.inherentTier,
        tier: a.tier,
        submittedAt: a.submittedAt,
      },
      questions,
      slots: round.map((s) => ({ slotNo: s.slotNo, riskDomains: s.riskDomains as RiskDomain[], status: s.status, mine: s.id === task.id })),
      canDecide: task.status === 'OPEN' && a.status === 'IN_REVIEW' && a.reviewRound === task.reviewRound && deciders.includes(me) && !preparers.includes(me) && !(task.delegatorMemberId !== null && preparers.includes(task.delegatorMemberId)),
    }
  })
}

/** The holders of a task for the service's right (risk.review.view, ASSIGNED): whoever may decide it now or decided it */
export async function riskReviewTaskReaders(ctx: Ctx, taskId: string): Promise<string[]> {
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) return []
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const task = await tx.reviewTask.findFirst({ where: { id: taskId }, select: { assessmentId: true, assigneeMemberId: true, delegatorMemberId: true, decidedById: true } })
    if (!task) return []
    const a = await tx.riskAssessment.findUniqueOrThrow({ where: { id: task.assessmentId }, select: { openedById: true, filledOnBehalfById: true, answers: { select: { answeredByMemberId: true } } } })
    return taskReaders(tx, task, assessmentPreparers(a), ctx.now)
  })
}
