import type { Ctx } from '@/server/context'

// What the portal may read (BR-PORTAL ข้อ 05 · INV-SUP-01): every query of src/server/portal/queries*.ts reads one of the
// models of PORTAL_MODELS through forTenant(organizationId) AND portalWhere(ctx, model) — the rows of the contact's own
// supplier or application, and nothing else. The list is a registry: S10 S11 append one line per model with its
// condition and never change the lines above (tests/generated/portal-isolation.test.ts runs every query export with two
// suppliers and two applications; tests/unit/portal-registry.test.ts holds the queries to the registry).

type SupplierActor = Extract<Ctx['actor'], { type: 'SUPPLIER' }>
/** A condition of no row at all: an actor who has no supplier (or no application) has nothing of that model */
const NONE = { id: { in: [] as string[] } } as const

export interface PortalModel {
  /** The Prisma delegate name */
  readonly model: string
  readonly where: (actor: SupplierActor) => Readonly<Record<string, unknown>>
}

/** A PO the supplier sees: sent to it, never a draft or one waiting for approval (BR-PORTAL ข้อ 05) */
export const PORTAL_PO_STATUSES = ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'] as const

const bySupplierOrApplication = (a: SupplierActor) => (a.supplierId ? { supplierId: a.supplierId } : a.applicationId ? { applicationId: a.applicationId } : NONE)

export const PORTAL_MODELS: PortalModel[] = [
  // S7
  { model: 'supplier', where: (a) => (a.supplierId ? { id: a.supplierId } : NONE) },
  { model: 'supplierContact', where: bySupplierOrApplication },
  { model: 'supplierApplication', where: (a) => (a.applicationId ? { id: a.applicationId } : a.supplierId ? { supplierId: a.supplierId } : NONE) },
  { model: 'supplierDocument', where: bySupplierOrApplication },
  { model: 'supplierDocumentType', where: () => ({ active: true }) },
  { model: 'portalSession', where: (a) => ({ contactId: a.supplierContactId }) },
  { model: 'portalInviteLink', where: (a) => ({ contactId: a.supplierContactId }) },
  { model: 'purchaseOrder', where: (a) => (a.supplierId ? { supplierId: a.supplierId, status: { in: [...PORTAL_PO_STATUSES] } } : NONE) },
  { model: 'supplierNotice', where: (a) => (a.supplierId ? { supplierId: a.supplierId } : { contactId: a.supplierContactId }) },
  // S11-05 (BR-RSK-17 · INV-RSK-05): the supplier's own assessments, their answers, the questions of their versions, the
  // evidence files of their answers and the AI's proposals for them; an application (no supplier yet) has none
  { model: 'riskAssessment', where: (a) => (a.supplierId ? { supplierId: a.supplierId } : NONE) },
  { model: 'riskAnswer', where: (a) => (a.supplierId ? { assessment: { supplierId: a.supplierId } } : NONE) },
  { model: 'riskQuestion', where: (a) => (a.supplierId ? { questionnaire: { assessments: { some: { supplierId: a.supplierId } } } } : NONE) },
  // a file link names its answer by id only (no relation), so this condition cannot pin the supplier: every portal query
  // of fileLink MUST add subjectId ∈ the answers it read through riskAnswer (review S11-05 ข้อ 6)
  { model: 'fileLink', where: (a) => (a.supplierId ? { kind: 'RISK_EVIDENCE', subjectType: 'RiskAnswer' } : NONE) },
  { model: 'agentAction', where: (a) => (a.supplierId ? { subjectType: 'RISK_ASSESSMENT', requestedByContactId: a.supplierContactId } : NONE) },
]

// S10-06 (INV-RFX-01 · BR-RFX-06): an RFx the contact's supplier or application is invited to (never a draft, never a
// removed invite), its lines and amendments, the questions answered to all or asked from its own invite; its own invites
// and bids only
const invitedTo = (a: SupplierActor) => ({ status: { not: 'DRAFT' }, invites: { some: { ...bySupplierOrApplication(a), status: { not: 'REMOVED' } } } })
PORTAL_MODELS.push(
  { model: 'rfxInvite', where: (a) => ({ ...bySupplierOrApplication(a), status: { not: 'REMOVED' } }) },
  { model: 'rfxEvent', where: invitedTo },
  { model: 'rfxLine', where: (a) => ({ rfxEvent: invitedTo(a) }) },
  { model: 'rfxAmendment', where: (a) => ({ rfxEvent: invitedTo(a) }) },
  { model: 'rfxQuestion', where: (a) => ({ rfxEvent: invitedTo(a), OR: [{ status: 'ANSWERED', visibility: 'ALL' }, { invite: bySupplierOrApplication(a) }] }) },
  { model: 'bid', where: (a) => (a.supplierId ? { supplierId: a.supplierId } : NONE) },
  { model: 'bidLine', where: (a) => (a.supplierId ? { bid: { supplierId: a.supplierId } } : NONE) },
)

export const PORTAL_MODEL_NAMES: ReadonlySet<string> = new Set(PORTAL_MODELS.map((m) => m.model))

/** The condition of the model for the actor of the portal context; throws for a model outside the registry or a non-portal ctx */
export function portalWhere(ctx: Ctx, model: string): Readonly<Record<string, unknown>> {
  if (ctx.actor.type !== 'SUPPLIER' || ctx.channel !== 'PORTAL') throw new Error('portalWhere needs the context of a portal request')
  const entry = PORTAL_MODELS.find((m) => m.model === model)
  if (!entry) throw new Error(`the portal may not read ${model}`)
  return entry.where(ctx.actor)
}
