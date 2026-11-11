import type { AppError } from '@/core/result'
import type { ApplicationFieldsInput } from '@/server/services/suppliers/applications'
import type { PortalApplicationView, PortalApplyStep } from './queries'

// The application form of the portal (S7-08 · ADR-184): what one step of /portal/<org>/apply sends to
// supplierApplication.update — only the step's own fields, only those that changed (an unchanged form goes on to the
// next step), a blank optional field cleared, a blank account number left as stored — and the words of a refusal.

/** A form field as text ('' when absent or a file) */
const field = (form: FormData, name: string): string => {
  const v = form.get(name)
  return typeof v === 'string' ? v : ''
}

const blankToNull = (v: string) => (v.trim() === '' ? null : v.trim())

/** The step's fields from the form, as supplierApplication.update takes them */
export function stepFields(step: PortalApplyStep, form: FormData): ApplicationFieldsInput {
  const f = (name: string) => field(form, name)
  switch (step) {
    case 'company':
      return {
        nameTh: f('nameTh').trim(),
        nameEn: blankToNull(f('nameEn')),
        ...(['JURISTIC', 'INDIVIDUAL', 'FOREIGN'].includes(f('payeeType')) ? { payeeType: f('payeeType') as 'JURISTIC' | 'INDIVIDUAL' | 'FOREIGN' } : {}),
        address: blankToNull(f('address')),
        phone: blankToNull(f('phone')),
        email: blankToNull(f('email')),
        category: blankToNull(f('category')),
      }
    case 'tax':
      return { ...(form.has('taxId') ? { taxId: blankToNull(f('taxId')) } : {}), branchCode: f('branchCode').trim(), isVatRegistered: f('isVatRegistered') === '1' }
    case 'bank':
      return { bankCode: blankToNull(f('bankCode')), ...(f('accountNo').trim() ? { accountNo: f('accountNo').trim() } : {}), accountName: blankToNull(f('accountName')), bankBranch: blankToNull(f('bankBranch')) }
    default:
      return {}
  }
}

/** Only what differs from the application as stored (the account number, sent only when typed, always counts) */
export function changedFields(fields: ApplicationFieldsInput, app: PortalApplicationView): ApplicationFieldsInput {
  const stored = app.fields as unknown as Record<string, unknown>
  return Object.fromEntries(Object.entries(fields).filter(([k, v]) => k === 'accountNo' || (stored[k] ?? null) !== (v ?? null))) as ApplicationFieldsInput
}

/** The words of a refusal the form knows (apply.errors.*), by its reason first */
export function applyErrorOf(error: AppError): string {
  const reason = typeof error.details?.reason === 'string' ? error.details.reason : null
  const fieldName = typeof error.details?.field === 'string' ? error.details.field : null
  if (reason === 'TAXID_CHECKSUM' || reason === 'DUPLICATE_REASON_REQUIRED') return reason
  if (fieldName === 'fields.accountNo') return 'ACCOUNT'
  if (fieldName === 'taxId' && error.code === 'VALIDATION_FAILED') return 'TAXID_CHECKSUM'
  return error.code
}
