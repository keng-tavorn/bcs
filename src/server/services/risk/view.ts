import type { AppError, Result } from '@/core/result'
import type { RiskDomain, RiskTierCode } from '@/core/risk'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { requireModule } from '../modules'
import { loadAssessment, questionsOf } from './assessments'

// What /risk/assessments/[id] shows (S11-05 · FR-RSK-204 AC1 in part · BR-RSK-14): the context of the assessment, the
// questions of its set with the answer each has and where it came from (the supplier, procurement for it, a certificate),
// the files behind them as metadata, and — once sent — its points and tier. risk.assessment.view reads it; the buttons
// that change it are offered to risk.assessment.manage (the commands check again).

type Fail = { readonly ok: false; readonly error: AppError }
const fail = (code: AppError['code'], message: string): Fail => ({ ok: false, error: { code, message } })

export interface RiskAnswerView {
  readonly optionCode: string
  readonly source: 'EXPLICIT' | 'EVIDENCE' | 'ON_BEHALF'
  readonly points: number
  readonly note: string | null
  readonly answeredAt: Date
  readonly byName: string | null
  readonly evidenceDocument: { readonly id: string; readonly documentTypeCode: string; readonly scope: string | null; readonly expiresOn: Date } | null
  readonly files: readonly { readonly fileId: string; readonly fileName: string; readonly scanStatus: string }[]
}

export interface RiskQuestionView {
  readonly code: string
  readonly domain: RiskDomain
  readonly textTh: string
  readonly textEn: string
  readonly required: boolean
  readonly options: readonly { readonly code: string; readonly labelTh: string; readonly labelEn: string; readonly points: number }[]
  readonly answer: RiskAnswerView | null
}

export interface RiskAssessmentView {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly version: number
  readonly supplier: { readonly id: string; readonly code: string; readonly nameTh: string; readonly nameEn: string | null }
  readonly screening: Readonly<Record<string, string>>
  readonly categoryCodes: readonly string[]
  readonly workScopes: readonly string[]
  readonly inherentTier: RiskTierCode
  readonly pointsTotal: number | null
  readonly tier: RiskTierCode | null
  readonly openedAt: Date
  readonly openedByName: string
  readonly submittedAt: Date | null
  readonly completedOn: Date | null
  readonly validUntil: Date | null
  readonly questionnaire: { readonly code: string; readonly versionNo: number }
  readonly questions: readonly RiskQuestionView[]
  readonly canManage: boolean
  /** risk.evidence.view: may open the files and the certificates behind the answers */
  readonly canViewEvidence: boolean
}

export async function riskAssessmentView(ctx: Ctx, assessmentId: string): Promise<Result<RiskAssessmentView>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const on = await requireModule(ctx, 'RISK', tx)
    if (!on.ok) return on
    const may = await authorize(tx, ctx, 'risk.assessment.view')
    if (!may.ok) return may
    const a = await loadAssessment(tx, assessmentId)
    if (!a) return fail('NOT_FOUND', 'assessment not found')
    const [manage, evidence] = await Promise.all([authorize(tx, ctx, 'risk.assessment.manage'), authorize(tx, ctx, 'risk.evidence.view')])
    const [supplier, openedBy] = await Promise.all([
      tx.supplier.findUniqueOrThrow({ where: { id: a.supplierId }, select: { id: true, code: true, nameTh: true, nameEn: true } }),
      tx.member.findUniqueOrThrow({ where: { id: a.openedById }, select: { displayNameTh: true } }),
    ])
    const memberIds = [...new Set(a.answers.map((x) => x.answeredByMemberId).filter((m): m is string => m !== null))]
    const contactIds = [...new Set(a.answers.map((x) => x.answeredByContactId).filter((c): c is string => c !== null))]
    const docIds = a.answers.map((x) => x.evidenceDocumentId).filter((d): d is string => d !== null)
    const [members, contacts, docs, links] = await Promise.all([
      tx.member.findMany({ where: { id: { in: memberIds } }, select: { id: true, displayNameTh: true } }),
      tx.supplierContact.findMany({ where: { id: { in: contactIds } }, select: { id: true, nameTh: true } }),
      tx.supplierDocument.findMany({ where: { id: { in: docIds } }, select: { id: true, documentTypeCode: true, scope: true, expiresOn: true } }),
      tx.fileLink.findMany({ where: { kind: 'RISK_EVIDENCE', subjectType: 'RiskAnswer', subjectId: { in: a.answers.map((x) => x.id) } }, select: { subjectId: true, file: { select: { id: true, fileName: true, scanStatus: true } } } }),
    ])
    const stored = new Map(a.questionnaire.questions.map((q) => [q.code, q]))
    const questions: RiskQuestionView[] = questionsOf(a).map((q) => {
      const row = stored.get(q.code)!
      const answer = a.answers.find((x) => x.questionCode === q.code && x.optionCode !== null)
      const labels = (Array.isArray(row.options) ? row.options : []) as { code?: string; labelTh?: string; labelEn?: string }[]
      return {
        code: q.code,
        domain: q.domain,
        textTh: row.textTh,
        textEn: row.textEn,
        required: q.required !== false,
        options: q.options.map((o) => {
          const l = labels.find((x) => x.code === o.code)
          return { code: o.code, labelTh: l?.labelTh || o.code, labelEn: l?.labelEn || l?.labelTh || o.code, points: o.points }
        }),
        answer: answer
          ? {
              optionCode: answer.optionCode!,
              source: answer.source,
              points: answer.points,
              note: answer.note,
              answeredAt: answer.answeredAt,
              byName: answer.answeredByMemberId ? (members.find((m) => m.id === answer.answeredByMemberId)?.displayNameTh ?? null) : answer.answeredByContactId ? (contacts.find((c) => c.id === answer.answeredByContactId)?.nameTh ?? null) : null,
              evidenceDocument: answer.evidenceDocumentId ? (docs.find((d) => d.id === answer.evidenceDocumentId) ?? null) : null,
              files: links.filter((l) => l.subjectId === answer.id).map((l) => ({ fileId: l.file.id, fileName: l.file.fileName, scanStatus: l.file.scanStatus })),
            }
          : null,
      }
    })
    return {
      ok: true as const,
      data: {
        id: a.id,
        number: a.number,
        status: a.status,
        version: a.version,
        supplier,
        screening: (a.screening ?? {}) as Record<string, string>,
        categoryCodes: a.categoryCodes,
        workScopes: a.workScopes,
        inherentTier: a.inherentTier,
        pointsTotal: a.pointsTotal,
        tier: a.tier,
        openedAt: a.createdAt,
        openedByName: openedBy.displayNameTh,
        submittedAt: a.submittedAt,
        completedOn: a.completedOn,
        validUntil: a.validUntil,
        questionnaire: { code: a.questionnaire.code, versionNo: a.questionnaire.versionNo },
        questions,
        canManage: manage.ok,
        canViewEvidence: evidence.ok,
      },
    }
  })
}
