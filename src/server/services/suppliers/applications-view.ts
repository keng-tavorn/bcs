import { BANKS } from '@/core/bankfile/banks'
import type { Result } from '@/core/result'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { escapeLike } from '@/server/db/like'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { getTimeline, type TimelineEntryDto } from '@/server/queries/timeline'
import { requireModule } from '../modules'
import { applicationOverdue } from './application-sla'
import { applicationLabel, missingItems } from './applications'

// What the workspace shows of supplier applications (S7-09 · docs/sub-specs/S7.md "/suppliers/applications"): the list for
// PROCUREMENT FINANCE AUDITOR (supplier.application.view ORG), and one application for them and for whoever has or had a
// task on its route (ASSIGNED). A sole proprietor's application is named by its number in the list (BR-NOTI ข้อ 10); its
// page shows the name to those who may read it. The account number is never here, its last four only (BR-SUP ข้อ 07).

type Fail = { readonly ok: false; readonly error: { readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'MODULE_DISABLED'; readonly message: string } }

const WAITING = ['INVITED', 'DRAFT', 'RETURNED'] as const
const STATUSES = ['INVITED', 'DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'RETURNED', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'] as const
export type ApplicationStatus = (typeof STATUSES)[number]
const LIST_LIMIT = 200
/** The suppliers offered for an invitation to the portal: a select of the active ones (a big register searches first) */
const INVITABLE_LIMIT = 500

export interface ApplicationListRow {
  readonly id: string
  readonly number: string | null
  readonly label: string
  readonly kind: 'NEW' | 'EXISTING'
  readonly status: ApplicationStatus
  readonly invitedAt: string
  readonly lastActivityAt: string
  readonly inviterName: string | null
  readonly overdue: boolean
  readonly filledOnBehalf: boolean
}

export interface ApplicationListView {
  readonly rows: readonly ApplicationListRow[]
  readonly total: number
  readonly overdue: number
  readonly canInvite: boolean
}

const nameOf = (m: { displayNameTh: string } | null | undefined) => m?.displayNameTh ?? null

async function memberCan(tx: TenantTx, ctx: Ctx, capability: 'supplier.invite' | 'supplier.application.fillOnBehalf' | 'supplier.application.route') {
  return (await authorize(tx, ctx, capability)).ok
}

/** Whether /suppliers shows the tab of the applications: SUPPLIER on and the reader one of their ORG readers */
export async function canSeeApplicationList(ctx: Ctx): Promise<boolean> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => (await requireModule(ctx, 'SUPPLIER', tx)).ok && (await authorize(tx, ctx, 'supplier.application.view', {})).ok)
}

/** The applications of the organization, newest first; `overdue` keeps those escalated and still waiting (BR-SUP ข้อ 12) */
export async function listSupplierApplicationsForScreen(ctx: Ctx, filter: { readonly status?: string; readonly overdue?: boolean; readonly q?: string } = {}): Promise<Result<ApplicationListView> | Fail> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const on = await requireModule(ctx, 'SUPPLIER', tx)
    if (!on.ok) return { ok: false, error: { code: 'MODULE_DISABLED', message: on.error.message } } as Fail
    // the list is the ORG readers': an approver opens the one of their task from the task
    const may = await authorize(tx, ctx, 'supplier.application.view', {})
    if (!may.ok) return { ok: false, error: { code: 'FORBIDDEN', message: may.error.message } } as Fail
    const status = (STATUSES as readonly string[]).includes(filter.status ?? '') ? (filter.status as ApplicationStatus) : null
    const q = (filter.q ?? '').trim()
    const where = {
      ...(status ? { status } : {}),
      ...(filter.overdue ? { escalatedAt: { not: null }, status: { in: [...WAITING] } } : {}),
      ...(q ? { OR: [{ nameTh: { contains: escapeLike(q), mode: 'insensitive' as const } }, { number: { contains: escapeLike(q), mode: 'insensitive' as const } }, { taxId: { contains: escapeLike(q.replace(/\D/g, '') || q) } }] } : {}),
    }
    const [rows, total, overdue] = await Promise.all([
      tx.supplierApplication.findMany({
        where,
        orderBy: [{ invitedAt: 'desc' }, { id: 'desc' }],
        take: LIST_LIMIT,
        select: { id: true, number: true, nameTh: true, payeeType: true, kind: true, status: true, invitedAt: true, lastActivityAt: true, escalatedAt: true, filledOnBehalfById: true, invitedBy: { select: { displayNameTh: true } } },
      }),
      tx.supplierApplication.count(),
      tx.supplierApplication.count({ where: { escalatedAt: { not: null }, status: { in: [...WAITING] } } }),
    ])
    return {
      ok: true,
      data: {
        rows: rows.map((a) => ({
          id: a.id,
          number: a.number,
          label: applicationLabel(a),
          kind: a.kind,
          status: a.status as ApplicationStatus,
          invitedAt: a.invitedAt.toISOString(),
          lastActivityAt: a.lastActivityAt.toISOString(),
          inviterName: nameOf(a.invitedBy),
          overdue: applicationOverdue(a),
          filledOnBehalf: a.filledOnBehalfById !== null,
        })),
        total,
        overdue,
        canInvite: await memberCan(tx, ctx, 'supplier.invite'),
      },
    }
  })
}

export interface ApplicationRegistryView {
  readonly source: string | null
  readonly checkedAt: string | null
  readonly nameTh: string | null
  readonly juristicStatus: string | null
  readonly vatCancelled: boolean
  readonly manualProof: boolean
}

export interface ApplicationDetailView {
  readonly id: string
  readonly number: string | null
  readonly kind: 'NEW' | 'EXISTING'
  readonly status: ApplicationStatus
  readonly version: number
  readonly overdue: boolean
  readonly supplierId: string | null
  readonly approvedSupplierId: string | null
  readonly fields: {
    readonly nameTh: string
    readonly nameEn: string | null
    readonly payeeType: 'JURISTIC' | 'INDIVIDUAL' | 'FOREIGN'
    readonly taxId: string | null
    readonly branchCode: string
    readonly isVatRegistered: boolean
    readonly address: string | null
    readonly phone: string | null
    readonly email: string | null
    readonly category: string | null
    readonly bankCode: string | null
    readonly accountNoLast4: string | null
    readonly accountName: string | null
    readonly bankBranch: string | null
  }
  readonly fieldSources: Readonly<Record<string, string>>
  readonly registry: ApplicationRegistryView | null
  readonly warnings: readonly { readonly code: string; readonly matches: readonly string[]; readonly reason: string | null }[]
  readonly missing: readonly string[]
  /** The names of the document types `missing` names (`document:<code>`) */
  readonly documentTypeNames: Readonly<Record<string, { readonly nameTh: string; readonly nameEn: string }>>
  readonly contacts: readonly { readonly id: string; readonly nameTh: string; readonly email: string; readonly isPrimary: boolean; readonly status: string }[]
  readonly people: { readonly inviter: string | null; readonly filledOnBehalf: string | null; readonly router: string | null }
  readonly dates: { readonly invitedAt: string; readonly lastActivityAt: string; readonly expiresAt: string; readonly submittedAt: string | null; readonly decidedAt: string | null }
  readonly returnReason: string | null
  readonly currentRouteId: string | null
  readonly timeline: readonly TimelineEntryDto[]
  readonly can: { readonly fillOnBehalf: boolean; readonly route: boolean; readonly invite: boolean }
}

interface RegistryRecord {
  readonly nameTh?: string
  readonly juristicStatus?: string
}

function registryOf(app: { registrySource: string | null; registryCheckedAt: Date | null; registryData: unknown }): ApplicationRegistryView | null {
  if (!app.registrySource) return null
  const d = (app.registryData ?? {}) as { rd?: { record?: RegistryRecord }; dbd?: { record?: RegistryRecord }; vatCancelled?: boolean; manualProof?: boolean }
  return {
    source: app.registrySource,
    checkedAt: app.registryCheckedAt?.toISOString() ?? null,
    nameTh: d.dbd?.record?.nameTh ?? d.rd?.record?.nameTh ?? null,
    juristicStatus: d.dbd?.record?.juristicStatus ?? d.rd?.record?.juristicStatus ?? null,
    vatCancelled: d.vatCancelled === true,
    manualProof: d.manualProof === true,
  }
}

/** Everyone who has or had a task on a route of the application (the ASSIGNED readers of supplier.application.view) */
async function assigneesOf(tx: TenantTx, applicationId: string): Promise<string[]> {
  const tasks = await tx.approvalTask.findMany({ where: { step: { route: { subjectType: 'SUPPLIER_APPLICATION', subjectId: applicationId } } }, select: { assigneeMemberId: true } })
  return [...new Set(tasks.map((t) => t.assigneeMemberId))]
}

/** One application as its page shows it, for the ORG readers and the people of its route */
export async function getSupplierApplicationForScreen(ctx: Ctx, applicationId: string): Promise<Result<ApplicationDetailView> | Fail> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const on = await requireModule(ctx, 'SUPPLIER', tx)
    if (!on.ok) return { ok: false, error: { code: 'MODULE_DISABLED', message: on.error.message } } as Fail
    const app = await tx.supplierApplication.findUnique({
      where: { id: applicationId },
      include: {
        invitedBy: { select: { displayNameTh: true } },
        filledOnBehalfBy: { select: { displayNameTh: true } },
        routedBy: { select: { displayNameTh: true } },
        contacts: { select: { id: true, nameTh: true, email: true, isPrimary: true, status: true }, orderBy: [{ isPrimary: 'desc' }, { nameTh: 'asc' }] },
      },
    })
    if (!app) return { ok: false, error: { code: 'NOT_FOUND', message: 'application not found' } } as Fail
    const may = await authorize(tx, ctx, 'supplier.application.view', { assigneeMemberIds: await assigneesOf(tx, app.id) })
    if (!may.ok) return { ok: false, error: { code: 'FORBIDDEN', message: may.error.message } } as Fail
    const [timeline, missing, fill, route, invite, types] = await Promise.all([
      getTimeline(ctx, 'SupplierApplication', app.id),
      app.kind === 'NEW' ? missingItems(tx, app) : Promise.resolve([] as string[]),
      memberCan(tx, ctx, 'supplier.application.fillOnBehalf'),
      memberCan(tx, ctx, 'supplier.application.route'),
      memberCan(tx, ctx, 'supplier.invite'),
      tx.supplierDocumentType.findMany({ select: { code: true, nameTh: true, nameEn: true } }),
    ])
    return {
      ok: true,
      data: {
        id: app.id,
        number: app.number,
        kind: app.kind,
        status: app.status as ApplicationStatus,
        version: app.version,
        overdue: applicationOverdue(app),
        supplierId: app.supplierId,
        approvedSupplierId: app.approvedSupplierId,
        fields: {
          nameTh: app.nameTh,
          nameEn: app.nameEn,
          payeeType: app.payeeType,
          taxId: app.taxId,
          branchCode: app.branchCode,
          isVatRegistered: app.isVatRegistered,
          address: app.address,
          phone: app.phone,
          email: app.email,
          category: app.category,
          bankCode: app.bankCode,
          accountNoLast4: app.accountNoLast4,
          accountName: app.accountName,
          bankBranch: app.bankBranch,
        },
        fieldSources: (app.fieldSources ?? {}) as Record<string, string>,
        registry: registryOf(app),
        warnings: (app.duplicateWarnings as unknown as { code: string; matches: string[]; reason: string | null }[]).map((w) => ({ code: w.code, matches: w.matches ?? [], reason: w.reason ?? null })),
        missing,
        documentTypeNames: Object.fromEntries(types.map((ty) => [ty.code, { nameTh: ty.nameTh, nameEn: ty.nameEn }])),
        contacts: app.contacts,
        people: { inviter: nameOf(app.invitedBy), filledOnBehalf: nameOf(app.filledOnBehalfBy), router: nameOf(app.routedBy) },
        dates: {
          invitedAt: app.invitedAt.toISOString(),
          lastActivityAt: app.lastActivityAt.toISOString(),
          expiresAt: app.expiresAt.toISOString(),
          submittedAt: app.submittedAt?.toISOString() ?? null,
          decidedAt: app.decidedAt?.toISOString() ?? null,
        },
        returnReason: app.returnReason,
        currentRouteId: app.currentRouteId,
        timeline,
        can: { fillOnBehalf: fill, route, invite },
      },
    }
  })
}

/** The registered suppliers PROCUREMENT may invite to the portal (/suppliers/invite, kind EXISTING): active, by code */
export async function listInvitableSuppliers(ctx: Ctx): Promise<Result<readonly { readonly id: string; readonly code: string; readonly nameTh: string }[]> | Fail> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const on = await requireModule(ctx, 'SUPPLIER', tx)
    if (!on.ok) return { ok: false, error: { code: 'MODULE_DISABLED', message: on.error.message } } as Fail
    if (!(await memberCan(tx, ctx, 'supplier.invite'))) return { ok: false, error: { code: 'FORBIDDEN', message: 'missing capability supplier.invite' } } as Fail
    const rows = await tx.supplier.findMany({ where: { status: 'ACTIVE' }, orderBy: [{ code: 'asc' }], take: INVITABLE_LIMIT, select: { id: true, code: true, nameTh: true } })
    return { ok: true, data: rows }
  })
}

/** The banks an account may be at (ADR-131), for the bank step of the form */
export const bankChoices = (): readonly { readonly code: string; readonly nameTh: string }[] => BANKS.map((b) => ({ code: b.code, nameTh: b.nameTh }))
