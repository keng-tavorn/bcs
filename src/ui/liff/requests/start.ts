import { formInput, initialValues, TITLE_MAX, totalsOf, visibleFieldIds, type FormValues } from '../../request-form/model'
import type { RequestFormData } from '../../request-form/types'

// Where the LIFF request form starts (§9.4), worked out with the workspace's form rules (model.ts) — on the server for the
// first screen, so the first JavaScript of the page carries none of them, and in the browser by the form's engine once
// the requester touches the form (./engine.tsx). The draft's lines are written into the page once, in its data: the
// form takes its opening lines from there and asks the preview about them in the browser (./lines.ts), so the start
// carries every opening value but those. Pure.

export interface LiffFormStart {
  /**
   * The values the form opens with — the saved draft, or a new form with its budget line and site filled (BR-FORM-02) —
   * all but its lines, which the form takes from the draft (./lines.ts openingLines)
   */
  readonly values: Omit<FormValues, 'lines'>
  /** The fields shown with those values (BR-FORM-01) */
  readonly visible: readonly string[]
  /** The longest title the service takes */
  readonly titleMax: number
}

export function liffFormStart(data: RequestFormData): LiffFormStart {
  const opening = initialValues(data)
  const totals = data.type.documentType === 'PURCHASE_REQUEST' ? totalsOf(opening, data.vatRateBp) : null
  const input = formInput(opening, data.draft?.attachments ?? [], totals, data.type.code)
  // The lines are the draft's, which the page's data carries already
  const { lines, ...values } = opening
  return { values, visible: [...visibleFieldIds(data.form, input)], titleMax: TITLE_MAX }
}
