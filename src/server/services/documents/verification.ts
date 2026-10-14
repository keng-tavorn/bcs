import { createHash } from 'node:crypto'
import { isAllowed, loadPrincipal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { findDocumentVerificationByTokenHash } from '@/server/db/lookups'
import { countRateLimited } from '@/server/db/sql/rate-limit'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { printablePurchaseOrder, printableRequest, type PrintableDocument } from '@/server/pdf/printable'
import { looksLikeToken, verificationKey, verificationToken, verificationTokenHash } from '@/server/verification/token'
import { MS_PER_MINUTE } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { newId } from '@/lib/ids'
import { requestViewScope } from '../requests/view-scope'

// Verifying a printed PR or PO by its QR (S6-19 · FR-DOA-102 · BR-QR-01 BR-QR-02 · ADR-109 · OQ-112). A row of
// DocumentVerification is issued only inside a POST command that changes what the document prints — sending and
// resending a PR or a PO, and the approval of a PO change of S8, which calls issueDocumentVerification — and only when
// the printed content differs from the latest row's (the new row supersedes it). The PDF computes the token of the
// latest row again, so a download never writes and always prints the same QR. The public page reads the document's
// current status by the token: the organization, the kind, the number, the status and its date, and whether this
// printing is the latest — never an amount or a person's name.

export type VerificationSubject = 'REQUEST' | 'PURCHASE_ORDER'

/**
 * sha256 of what the document prints, without its status, its dates and its approval section: the lines, the amounts,
 * the counterparty, the conditions and the note (BR-QR-01)
 */
export function printedContentSha256(doc: PrintableDocument): string {
  const { kind, number, organization, counterparty, meta, amountHeader, lines, totals, note } = doc
  return createHash('sha256').update(JSON.stringify({ kind, number, organization, counterparty, meta, amountHeader, lines, totals, note })).digest('hex')
}

const printable = (tx: TenantTx, ctx: Ctx, subject: { subjectType: VerificationSubject; subjectId: string }) =>
  subject.subjectType === 'REQUEST' ? printableRequest(tx, ctx.organizationId, subject.subjectId, ctx.now) : printablePurchaseOrder(tx, ctx.organizationId, subject.subjectId, ctx.now)

/**
 * BR-QR-01 inside the caller's command (POST): a new row when the printed content changed since the latest row (which
 * it supersedes), nothing when it did not. Returns the event of a new row.
 */
export async function issueDocumentVerification(tx: TenantTx, ctx: Ctx, subject: { subjectType: VerificationSubject; subjectId: string }): Promise<{ events: EventDraft[] }> {
  const content = printedContentSha256(await printable(tx, ctx, subject))
  const latest = await tx.documentVerification.findFirst({ where: { ...subject, supersededAt: null }, orderBy: { issuedAt: 'desc' }, select: { id: true, contentSha256: true } })
  if (latest?.contentSha256 === content) return { events: [] }
  const id = newId()
  const key = verificationKey()
  if (latest) await tx.documentVerification.update({ where: { id: latest.id }, data: { supersededAt: ctx.now } })
  await tx.documentVerification.create({ data: { id, organizationId: ctx.organizationId, ...subject, tokenHash: verificationTokenHash(verificationToken(id, key)), keyId: key.keyId, contentSha256: content, issuedAt: ctx.now } })
  return {
    events: [{ type: 'document_verification.issued', aggregateType: 'DocumentVerification', aggregateId: id, data: { ...subject, supersededId: latest?.id ?? null } }],
  }
}

/** The token the PDF prints: of the latest row (never written here); null for a document never sent */
export async function verificationTokenOf(tx: TenantTx, subject: { subjectType: VerificationSubject; subjectId: string }): Promise<string | null> {
  const latest = await tx.documentVerification.findFirst({ where: { ...subject, supersededAt: null }, orderBy: { issuedAt: 'desc' }, select: { id: true } })
  return latest ? verificationToken(latest.id) : null
}

export interface VerifiedDocumentDto {
  readonly organizationName: string
  readonly kind: VerificationSubject
  readonly number: string
  readonly status: string
  /** When the document came to its current status (ISO) */
  readonly statusAt: string | null
  /** This printing is the latest: no newer content was issued after it */
  readonly latest: boolean
  /** For a signed-in member who may view the document (request.view, po.view): its page */
  readonly href: string | null
}

const latestOf = (...at: ReadonlyArray<Date | null>) => at.filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null

/**
 * BR-QR-02: what the public page shows for a token, read only; null for no token, a malformed one or one of no row —
 * the page says "not found" the same way for all three. `viewer` is the signed-in member, if any, in the document's
 * organization (a member of another organization gets no link).
 */
export async function verifyDocument(token: string, viewer: ((organizationId: string) => Ctx | null) | null): Promise<VerifiedDocumentDto | null> {
  if (!looksLikeToken(token)) return null
  const found = await findDocumentVerificationByTokenHash(verificationTokenHash(token))
  if (!found) return null
  return forTenant(found.organizationId).$transaction(async (tx) => {
    const row = await tx.documentVerification.findUniqueOrThrow({ where: { id: found.id }, select: { subjectType: true, subjectId: true, supersededAt: true } })
    const org = await tx.organization.findUniqueOrThrow({ where: { id: found.organizationId }, select: { legalNameTh: true } })
    const ctx = viewer?.(found.organizationId) ?? null
    const principal = ctx ? await loadPrincipal(tx, ctx) : null
    if (row.subjectType === 'REQUEST') {
      const r = await tx.request.findUniqueOrThrow({ where: { id: row.subjectId }, select: { number: true, status: true, submittedAt: true, approvedAt: true, completedAt: true, cancelledAt: true } })
      const scope = principal ? await requestViewScope(tx, row.subjectId) : null
      return {
        organizationName: org.legalNameTh,
        kind: 'REQUEST' as const,
        number: r.number ?? '',
        status: r.status,
        statusAt: latestOf(r.submittedAt, r.approvedAt, r.completedAt, r.cancelledAt)?.toISOString() ?? null,
        latest: row.supersededAt === null,
        href: principal && scope && isAllowed(principal, 'request.view', scope) ? `/requests/${row.subjectId}` : null,
      }
    }
    const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: row.subjectId }, select: { number: true, status: true, createdById: true, submittedAt: true, approvedAt: true, sentAt: true, closedAt: true, cancelledAt: true } })
    let href: string | null = null
    if (principal) {
      const tasks = await tx.approvalTask.findMany({ where: { step: { route: { subjectType: 'PURCHASE_ORDER', subjectId: row.subjectId } } }, select: { assigneeMemberId: true, principalMemberId: true } })
      const requesters = await tx.request.findMany({ where: { lines: { some: { poSources: { some: { poLine: { poId: row.subjectId } } } } } }, select: { requesterMemberId: true } })
      const scope = {
        ownerMemberIds: [...(po.createdById ? [po.createdById] : []), ...requesters.map((x) => x.requesterMemberId)],
        assigneeMemberIds: tasks.flatMap((t) => [t.assigneeMemberId, t.principalMemberId]).filter((m): m is string => Boolean(m)),
      }
      href = isAllowed(principal, 'po.view', scope) ? `/procurement/pos/${row.subjectId}` : null
    }
    return {
      organizationName: org.legalNameTh,
      kind: 'PURCHASE_ORDER' as const,
      number: po.number ?? '',
      status: po.status,
      statusAt: latestOf(po.submittedAt, po.approvedAt, po.sentAt, po.closedAt, po.cancelledAt)?.toISOString() ?? null,
      latest: row.supersededAt === null,
      href,
    }
  })
}

/** The verification page the PDF prints as a QR: of the latest row; null for a document never sent (BR-QR-01) */
export async function verifyUrlOf(tx: TenantTx, subject: { subjectType: VerificationSubject; subjectId: string }): Promise<string | null> {
  const token = await verificationTokenOf(tx, subject)
  return token ? `${getEnv().APP_URL.replace(/\/+$/, '')}/verify/${token}` : null
}

/** BR-QR-02: how often one address may open /verify in a minute */
export const VERIFY_RATE_WINDOW_MS = MS_PER_MINUTE
export const VERIFY_RATE_PER_WINDOW = 30

export type VerifyPage = { readonly kind: 'FOUND'; readonly document: VerifiedDocumentDto } | { readonly kind: 'NOT_FOUND' } | { readonly kind: 'TOO_MANY' }

/**
 * The public page /verify/<token> (BR-QR-02): limited per address (the limiter's own count, as NFR-SEC-05 keeps it —
 * no document row is added or changed), then read only
 */
export async function verifyPage(token: string, address: string, now: Date, viewer: ((organizationId: string) => Ctx | null) | null): Promise<VerifyPage> {
  const limit = await countRateLimited(`bcs:verify:${address}`, VERIFY_RATE_WINDOW_MS, VERIFY_RATE_PER_WINDOW, now)
  if (!limit.allowed) return { kind: 'TOO_MANY' }
  const document = await verifyDocument(token, viewer)
  return document ? { kind: 'FOUND', document } : { kind: 'NOT_FOUND' }
}
