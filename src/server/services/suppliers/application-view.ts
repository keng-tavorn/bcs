import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { isAllowed, loadPrincipal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { requireModule } from '../modules'
import { maskTaxId } from './access'
import { applicationLabel } from './applications'

// What the approver of a supplier application decides on (S7-09 · FR-SUP-104 AC5 · BR-NOTI ข้อ 10): the facts of the
// application on the task pages — the web's /tasks/[id], LIFF's /liff/tasks/[id] and BCS Go. Who reads it: whoever has
// or had a task on its route (supplier.application.view ASSIGNED), and PROCUREMENT FINANCE AUDITOR over the
// organization. A sole proprietor's tax id is their national id number, so it shows its last four digits only; the
// person's full name is on these signed-in pages, never on a LINE card (BR-NOTI ข้อ 10), and `label` names them as the
// card and the lists do. The matched references of a duplicate warning are internal numbers and codes, shown here.
// No bank account (S7-10 drafts its change) and no file: the documents are listed by type and state. Read only.

const isUuid = (v: string) => z.uuid().safeParse(v).success

export interface MemberNameDto {
  readonly th: string
  readonly en: string | null
}

export interface SupplierApplicationTaskViewDto {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly kind: 'NEW' | 'EXISTING'
  /** How the application is named on cards and lists: a sole proprietor never by name (BR-NOTI ข้อ 10) */
  readonly label: string
  readonly payeeType: 'JURISTIC' | 'INDIVIDUAL' | 'FOREIGN'
  /** The legal name, or a sole proprietor's full name (signed-in pages only) */
  readonly nameTh: string
  readonly nameEn: string | null
  readonly category: string | null
  /** A sole proprietor's with its last four digits only; null for a foreign supplier */
  readonly taxId: string | null
  readonly taxIdMasked: boolean
  readonly branchCode: string
  readonly isVatRegistered: boolean
  readonly registry: {
    /** RD DBD STUB: found there · MANUAL: not found, confirmed by hand with a proof · null: not checked */
    readonly source: 'RD' | 'DBD' | 'MANUAL' | 'STUB' | null
    readonly juristicStatus: string | null
    readonly vatCancelled: boolean
  }
  readonly duplicates: ReadonlyArray<{ readonly code: string; readonly matches: readonly string[]; readonly reason: string | null }>
  readonly documents: ReadonlyArray<{
    readonly id: string
    readonly typeCode: string
    readonly typeName: MemberNameDto
    readonly status: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED' | 'SUPERSEDED'
    readonly expiresOn: string
    readonly verifiedBy: MemberNameDto | null
  }>
  readonly invitedBy: MemberNameDto | null
  readonly filledOnBehalfBy: MemberNameDto | null
  readonly routedBy: MemberNameDto | null
}

const MEMBER = { select: { displayNameTh: true, displayNameEn: true } } as const
const nameOf = (m: { displayNameTh: string; displayNameEn: string | null } | null): MemberNameDto | null => (m ? { th: m.displayNameTh, en: m.displayNameEn } : null)

/** Everyone who has or had a task on a route of the application, and those they held it for */
async function assigneesOf(tx: TenantTx, applicationId: string): Promise<string[]> {
  const tasks = await tx.approvalTask.findMany({
    where: { step: { route: { subjectType: 'SUPPLIER_APPLICATION', subjectId: applicationId } } },
    select: { assigneeMemberId: true, principalMemberId: true },
  })
  return [...new Set(tasks.flatMap((t) => [t.assigneeMemberId, t.principalMemberId]).filter((m): m is string => Boolean(m)))]
}

/** The juristic status the registries reported (DBD's, else RD's) and whether VAT was found cancelled */
function registryOf(source: string | null, data: unknown): SupplierApplicationTaskViewDto['registry'] {
  const d = (data ?? {}) as { vatCancelled?: boolean; dbd?: { record?: { juristicStatus?: string } }; rd?: { record?: { juristicStatus?: string } } }
  return {
    source: source === 'RD' || source === 'DBD' || source === 'MANUAL' || source === 'STUB' ? source : null,
    juristicStatus: d.dbd?.record?.juristicStatus ?? d.rd?.record?.juristicStatus ?? null,
    vatCancelled: d.vatCancelled === true,
  }
}

function duplicatesOf(value: unknown): SupplierApplicationTaskViewDto['duplicates'] {
  if (!Array.isArray(value)) return []
  return value
    .filter((w): w is { code: string; matches?: unknown; reason?: unknown } => Boolean(w) && typeof (w as { code?: unknown }).code === 'string')
    .map((w) => ({
      code: w.code,
      matches: Array.isArray(w.matches) ? w.matches.filter((m): m is string => typeof m === 'string') : [],
      reason: typeof w.reason === 'string' && w.reason ? w.reason : null,
    }))
}

/**
 * The application's facts for its approver (supplier.application.view: ASSIGNED, or PROCUREMENT FINANCE AUDITOR).
 * NOT_FOUND when there is no such application in the organization; FORBIDDEN for any other reader.
 */
export async function getSupplierApplicationTaskView(ctx: Ctx, applicationId: string): Promise<Result<SupplierApplicationTaskViewDto>> {
  if (!isUuid(applicationId)) return err('NOT_FOUND', 'supplier application not found')
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const on = await requireModule(ctx, 'SUPPLIER', tx)
    if (!on.ok) return on
    const principal = await loadPrincipal(tx, ctx)
    const app = await tx.supplierApplication.findFirst({
      where: { id: applicationId },
      include: { invitedBy: MEMBER, filledOnBehalfBy: MEMBER, routedBy: MEMBER },
    })
    if (!app) return err('NOT_FOUND', 'supplier application not found')
    const assignees = await assigneesOf(tx, app.id)
    if (!isAllowed(principal, 'supplier.application.view', { assigneeMemberIds: assignees })) {
      return err('FORBIDDEN', 'you may not see this application', { capability: 'supplier.application.view' })
    }
    const documents = await tx.supplierDocument.findMany({
      where: { applicationId: app.id, status: { not: 'SUPERSEDED' } },
      orderBy: [{ documentType: { sortOrder: 'asc' } }, { createdAt: 'asc' }],
      select: { id: true, documentTypeCode: true, status: true, expiresOn: true, documentType: { select: { nameTh: true, nameEn: true } }, verifiedBy: MEMBER },
    })
    const individual = app.payeeType === 'INDIVIDUAL'
    return ok({
      id: app.id,
      number: app.number,
      status: app.status,
      kind: app.kind,
      label: applicationLabel(app),
      payeeType: app.payeeType,
      nameTh: app.nameTh,
      nameEn: app.nameEn,
      category: app.category,
      taxId: app.payeeType === 'FOREIGN' || !app.taxId ? null : individual ? maskTaxId(app.taxId) : app.taxId,
      taxIdMasked: individual && Boolean(app.taxId),
      branchCode: app.branchCode,
      isVatRegistered: app.isVatRegistered,
      registry: registryOf(app.registrySource, app.registryData),
      duplicates: duplicatesOf(app.duplicateWarnings),
      documents: documents.map((d) => ({
        id: d.id,
        typeCode: d.documentTypeCode,
        typeName: { th: d.documentType.nameTh, en: d.documentType.nameEn },
        status: d.status,
        expiresOn: d.expiresOn.toISOString().slice(0, 10),
        verifiedBy: nameOf(d.verifiedBy),
      })),
      invitedBy: nameOf(app.invitedBy),
      filledOnBehalfBy: nameOf(app.filledOnBehalfBy),
      routedBy: nameOf(app.routedBy),
    })
  })
}
