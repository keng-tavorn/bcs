import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { portalWhere } from './db'

// The portal's reads of supplier risk (S11-05 · BR-RSK-17 · INV-RSK-05 · INV-SUP-01): each reads through portalWhere, so
// a contact sees only the assessments of its own supplier — the questions of the set, the answers and their files, the
// message procurement forwarded — never the points, the tier before it completed or a reviewer's reasons.
// tests/generated/portal-isolation.test.ts calls every export of this file as two suppliers and two applications.

const OPEN = ['DRAFT', 'IN_REVIEW', 'RETURNED'] as const

/** portal.risk.view: the contact of an ACTIVE supplier (an application has no assessment) */
async function mayView(ctx: Ctx): Promise<boolean> {
  const supplier = await forTenant(ctx.organizationId).supplier.findFirst({ where: portalWhere(ctx, 'supplier'), select: { status: true } })
  return supplier?.status === 'ACTIVE'
}

export interface PortalRiskRow {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly openedAt: Date
  /** The tier it was assessed at, once completed */
  readonly tier: string | null
  readonly validUntil: Date | null
}

/** The supplier's assessments, open ones first */
export async function listPortalRiskAssessments(ctx: Ctx): Promise<PortalRiskRow[]> {
  if (!(await mayView(ctx))) return []
  const rows = await forTenant(ctx.organizationId).riskAssessment.findMany({
    where: portalWhere(ctx, 'riskAssessment'),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, number: true, status: true, createdAt: true, tier: true, validUntil: true },
  })
  const open = (s: string) => (OPEN as readonly string[]).includes(s)
  return rows
    .map((r) => ({ id: r.id, number: r.number, status: r.status, openedAt: r.createdAt, tier: r.status === 'COMPLETED' || r.status === 'SUPERSEDED' ? r.tier : null, validUntil: r.validUntil }))
    .sort((a, b) => Number(open(b.status)) - Number(open(a.status)))
}

export interface PortalRiskQuestion {
  readonly code: string
  readonly domain: string
  readonly textTh: string
  readonly textEn: string
  readonly helpTh: string | null
  readonly helpEn: string | null
  readonly required: boolean
  /** The options' words only: the points are the organization's (BR-RSK-17) */
  readonly options: readonly { readonly code: string; readonly labelTh: string; readonly labelEn: string }[]
  readonly appliesWhen: unknown
  readonly sortOrder: number
}

export interface PortalRiskAnswer {
  readonly questionCode: string
  readonly optionCode: string | null
  readonly source: string
  readonly note: string | null
  readonly evidenceAiReadable: boolean
  readonly evidenceDocumentId: string | null
  readonly files: readonly { readonly fileId: string; readonly fileName: string; readonly scanStatus: string }[]
}

export interface PortalRiskAssessment {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly version: number
  readonly screening: unknown
  readonly categoryCodes: readonly string[]
  readonly payeeType: string
  readonly inherentTier: string
  readonly isForeign: boolean
  readonly questions: readonly PortalRiskQuestion[]
  readonly answers: readonly PortalRiskAnswer[]
  /** What procurement forwarded when it was returned */
  readonly returnReason: string | null
}

const label = (v: unknown, fallback: string) => (typeof v === 'string' && v !== '' ? v : fallback)

/** One assessment of the supplier with the questions of its version and its answers; null when it is not the supplier's */
export async function portalRiskAssessment(ctx: Ctx, assessmentId?: string): Promise<PortalRiskAssessment | null> {
  if (!assessmentId || !(await mayView(ctx))) return null
  const db = forTenant(ctx.organizationId)
  const a = await db.riskAssessment.findFirst({
    where: { AND: [portalWhere(ctx, 'riskAssessment'), { id: assessmentId }] },
    select: { id: true, number: true, status: true, version: true, screening: true, categoryCodes: true, payeeType: true, inherentTier: true, questionnaireId: true, returnReason: true, supplier: { select: { isForeign: true } } },
  })
  if (!a) return null
  const [questions, answers] = await Promise.all([
    db.riskQuestion.findMany({ where: { AND: [portalWhere(ctx, 'riskQuestion'), { questionnaireId: a.questionnaireId }] }, orderBy: { sortOrder: 'asc' } }),
    db.riskAnswer.findMany({ where: { AND: [portalWhere(ctx, 'riskAnswer'), { assessmentId: a.id }] } }),
  ])
  const links = answers.length
    ? await db.fileLink.findMany({ where: { AND: [portalWhere(ctx, 'fileLink'), { subjectId: { in: answers.map((x) => x.id) } }] }, select: { subjectId: true, file: { select: { id: true, fileName: true, scanStatus: true } } } })
    : []
  return {
    id: a.id,
    number: a.number,
    status: a.status,
    version: a.version,
    screening: a.screening,
    categoryCodes: a.categoryCodes,
    payeeType: a.payeeType,
    inherentTier: a.inherentTier,
    isForeign: a.supplier.isForeign,
    questions: questions.map((q) => ({
      code: q.code,
      domain: q.domain,
      textTh: q.textTh,
      textEn: q.textEn,
      helpTh: q.helpTh,
      helpEn: q.helpEn,
      required: q.required,
      options: (Array.isArray(q.options) ? q.options : []).map((o) => {
        const opt = (o ?? {}) as { code?: unknown; labelTh?: unknown; labelEn?: unknown }
        const code = label(opt.code, '')
        const th = label(opt.labelTh, code)
        return { code, labelTh: th, labelEn: label(opt.labelEn, th) }
      }),
      appliesWhen: q.appliesWhen,
      sortOrder: q.sortOrder,
    })),
    answers: answers.map((x) => ({
      questionCode: x.questionCode,
      optionCode: x.optionCode,
      source: x.source,
      note: x.note,
      evidenceAiReadable: x.evidenceAiReadable,
      evidenceDocumentId: x.evidenceDocumentId,
      files: links.filter((l) => l.subjectId === x.id).map((l) => ({ fileId: l.file.id, fileName: l.file.fileName, scanStatus: l.file.scanStatus })),
    })),
    returnReason: a.status === 'RETURNED' ? a.returnReason : null,
  }
}

/**
 * Where a contact lands after signing in: the open assessment of its supplier when the link it used was sent for the
 * questionnaire (purpose RISK_QUESTIONNAIRE · BR-RSK-17), else the portal's home ('')
 */
export async function portalRiskLanding(ctx: Ctx): Promise<string> {
  const db = forTenant(ctx.organizationId)
  const link = await db.portalInviteLink.findFirst({ where: { AND: [portalWhere(ctx, 'portalInviteLink'), { usedAt: { not: null } }] }, orderBy: { usedAt: 'desc' }, select: { purpose: true } })
  if (link?.purpose !== 'RISK_QUESTIONNAIRE') return ''
  const open = await db.riskAssessment.findFirst({ where: { AND: [portalWhere(ctx, 'riskAssessment'), { status: { in: [...OPEN] } }] }, select: { id: true } })
  return open ? `/risk/${open.id}` : '/risk'
}
