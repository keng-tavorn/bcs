import { randomUUID } from 'node:crypto'
import { portalAuthorize } from '@/server/portal/authz'
import { portalRequest, postSession } from '@/server/portal/http'
import { getPortalBankAccount } from '@/server/portal/queries'
import { proposeBankAccountChange } from '@/server/services/suppliers/bank-proposal'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../_lib/respond'

// POST /portal/<org>/api/bank-account (S7-10 · FR-SUP-103 AC1 · ADR-190): the primary contact proposes its supplier's
// account with its proof, as multipart form data with the CSRF token. The service checks everything again (the primary
// contact, the hold of a new contact, one open request, the account by its bank); the answer is the page with its result.

export async function POST(request: Request, { params }: { params: Promise<{ org: string }> }) {
  const req = await portalRequest(request, (await params).org)
  if (!req) return notFound()
  const form = await formOf(request)
  const state = await postSession(request, req, field(form, 'csrf'), 'bank-account')
  if (state === 'NONE') return notFound()
  if (state === 'CSRF') return forbiddenCsrf()
  // the portal's rule on the contact as it stands (the service checks it again with the hold of a new contact)
  const bank = await getPortalBankAccount(state.ctx)
  const primary = portalAuthorize(state.ctx, 'portal.bankAccount.propose', { supplierStatus: bank?.supplierStatus ?? null, isPrimary: bank?.isPrimary === true })
  if (!primary.ok) return seeOther(req.org, '/bank-account', { error: 'FORBIDDEN' })
  const file = form.get('file')
  if (!(file instanceof File) || file.size === 0) return seeOther(req.org, '/bank-account', { error: 'PROOF_REQUIRED' })
  const r = await proposeBankAccountChange(
    state.ctx,
    {
      bankCode: field(form, 'bankCode'),
      accountNo: field(form, 'accountNo'),
      accountName: field(form, 'accountName'),
      branchName: field(form, 'branchName').trim() || null,
      reason: field(form, 'reason'),
      fileName: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    },
    { idempotencyKey: field(form, 'key') || randomUUID() },
  )
  if (r.ok) return seeOther(req.org, '/bank-account', { sent: 1 })
  const reason = typeof r.error.details?.reason === 'string' ? r.error.details.reason : null
  const fieldName = typeof r.error.details?.field === 'string' ? r.error.details.field : null
  const error = reason === 'NOTE_HAS_ACCOUNT_NO' ? 'NAMES_ACCOUNT' : reason && ['NEW_CONTACT_HOLD', 'CHANGE_OPEN', 'PROOF_REQUIRED', 'TYPE_NOT_ALLOWED', 'TOO_LARGE'].includes(reason) ? reason : fieldName === 'accountNo' || fieldName === 'bankCode' ? 'ACCOUNT' : r.error.code
  return seeOther(req.org, '/bank-account', { error })
}
