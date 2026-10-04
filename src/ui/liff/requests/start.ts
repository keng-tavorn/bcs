import { formInput, initialValues, plainNumber, savableLine, TITLE_MAX, totalsOf, visibleFieldIds, type FormValues } from '../../request-form/model'
import type { PreviewRequestInput, RequestFormData } from '../../request-form/types'

// Where the LIFF request form starts (§9.4), worked out with the workspace's form rules (model.ts) — on the server for the
// first screen, so the first JavaScript of the page carries none of them, and in the browser by the form's engine once
// the requester touches the form (./engine.tsx). Pure.

/** The lines the preview of the budget and the route is asked about: the complete ones, numbers as plain text */
export function previewLinesOf(values: FormValues): PreviewRequestInput['lines'] {
  return values.lines.filter(savableLine).map((l) => ({ quantity: plainNumber(l.quantity), unitPrice: plainNumber(l.unitPrice), vatable: l.vatable }))
}

export interface LiffFormStart {
  /** The values the form opens with: the saved draft, or a new form with its budget line and site filled (BR-FORM-02) */
  readonly values: FormValues
  /** The fields shown with those values (BR-FORM-01) */
  readonly visible: readonly string[]
  /** The lines the first preview asks about */
  readonly previewLines: PreviewRequestInput['lines']
  /** The longest title the service takes */
  readonly titleMax: number
}

export function liffFormStart(data: RequestFormData): LiffFormStart {
  const values = initialValues(data)
  const totals = data.type.documentType === 'PURCHASE_REQUEST' ? totalsOf(values, data.vatRateBp) : null
  const input = formInput(values, data.draft?.attachments ?? [], totals, data.type.code)
  return { values, visible: [...visibleFieldIds(data.form, input)], previewLines: previewLinesOf(values), titleMax: TITLE_MAX }
}
