import type { DoaDocumentType } from '@/core/doa'
import type { TenantTx } from '@/server/db/tenant'
import type { ApprovalSubject } from '../approvals/route'

// What the timer jobs need to know about the document an approval task is on: its number, title or kind for the message
// (ids, numbers, titles and codes only, BR-NOTI-01) and the page that settles it (a variance's purchase order), who
// asked for it (the requester, the PO creator, the person who recorded the variance, the submitter of a policy change),
// who may not decide it (BR-DOA-06, BR-SOD-01/03/06/08), and the department whose position holders approve it
// (BR-DOA-05). Read inside the caller's transaction.

export const DOCUMENT_TYPE_OF: Readonly<Record<ApprovalSubject, DoaDocumentType>> = {
  REQUEST: 'PURCHASE_REQUEST',
  PURCHASE_ORDER: 'PURCHASE_ORDER',
  VARIANCE: 'GR_VARIANCE',
  DOA_VERSION: 'DOA_CHANGE',
  ORG_AUTHORITY_CHANGE: 'ORG_AUTHORITY_CHANGE',
}

export interface SubjectFacts {
  readonly type: ApprovalSubject
  readonly id: string
  readonly documentType: DoaDocumentType
  /** Document number, else null */
  readonly number: string | null
  /** A request's title, a DOA version's code and number */
  readonly title: string | null
  /** An authority change's kind (OrgAuthorityChange.kind): the templates name it in words */
  readonly changeKind: string | null
  /** A variance's purchase order: its page is where the variance is settled */
  readonly poId: string | null
  readonly ownerMemberId: string | null
  readonly conflictMemberIds: readonly string[]
  readonly chargedDepartmentId: string | null
}

const uniq = (ids: ReadonlyArray<string | null | undefined>) => [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]

/** The member who would gain from an authority change: new holder, replacement or delegate (BR-SOD-08) */
function beneficiaryOf(payload: unknown): string | null {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  for (const key of ['memberId', 'replacementMemberId', 'delegateMemberId']) if (typeof p[key] === 'string') return p[key] as string
  return null
}

export async function subjectFacts(tx: TenantTx, type: ApprovalSubject, id: string): Promise<SubjectFacts> {
  const base = { type, id, documentType: DOCUMENT_TYPE_OF[type], changeKind: null, poId: null }
  switch (type) {
    case 'REQUEST': {
      const r = await tx.request.findUniqueOrThrow({ where: { id }, select: { number: true, title: true, requesterMemberId: true, chargedDepartmentId: true } })
      return { ...base, number: r.number, title: r.title, ownerMemberId: r.requesterMemberId, conflictMemberIds: [r.requesterMemberId], chargedDepartmentId: r.chargedDepartmentId }
    }
    case 'PURCHASE_ORDER': {
      const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, select: { number: true, createdById: true, lines: { select: { budgetLineId: true }, orderBy: { lineNo: 'asc' }, take: 1 } } })
      const requests = await tx.request.findMany({ where: { lines: { some: { poSources: { some: { poLine: { poId: id } } } } } }, select: { requesterMemberId: true } })
      const line = po.lines[0]
      const department = line ? (await tx.budgetLine.findUniqueOrThrow({ where: { id: line.budgetLineId }, select: { departmentId: true } })).departmentId : null
      return { ...base, number: po.number, title: null, ownerMemberId: po.createdById, conflictMemberIds: uniq([po.createdById, ...requests.map((r) => r.requesterMemberId)]), chargedDepartmentId: department }
    }
    case 'VARIANCE': {
      const v = await tx.variance.findUniqueOrThrow({ where: { id }, select: { createdById: true, po: { select: { id: true, number: true } }, poLine: { select: { budgetLineId: true } } } })
      const department = (await tx.budgetLine.findUniqueOrThrow({ where: { id: v.poLine.budgetLineId }, select: { departmentId: true } })).departmentId
      return { ...base, number: v.po.number, title: null, poId: v.po.id, ownerMemberId: v.createdById, conflictMemberIds: [v.createdById], chargedDepartmentId: department }
    }
    case 'DOA_VERSION': {
      const v = await tx.doaVersion.findUniqueOrThrow({ where: { id }, select: { code: true, versionNo: true, submittedById: true } })
      return { ...base, number: null, title: `${v.code} #${v.versionNo}`, ownerMemberId: v.submittedById, conflictMemberIds: uniq([v.submittedById]), chargedDepartmentId: null }
    }
    case 'ORG_AUTHORITY_CHANGE': {
      const c = await tx.orgAuthorityChange.findUniqueOrThrow({ where: { id }, select: { kind: true, submittedById: true, payload: true } })
      return { ...base, number: null, title: null, changeKind: c.kind, ownerMemberId: c.submittedById, conflictMemberIds: uniq([c.submittedById, beneficiaryOf(c.payload)]), chargedDepartmentId: null }
    }
  }
}

export interface SubjectData {
  readonly subjectType: ApprovalSubject
  readonly subjectId: string
  readonly number: string | null
  readonly title: string | null
  readonly changeKind?: string
  readonly poId?: string
}

/** What a notification about the document carries: ids, the number, the title or kind, nothing else (BR-NOTI-01) */
export function subjectData(s: SubjectFacts): SubjectData {
  return { subjectType: s.type, subjectId: s.id, number: s.number, title: s.title, ...(s.changeKind ? { changeKind: s.changeKind } : {}), ...(s.poId ? { poId: s.poId } : {}) }
}
