import { amountToSatang } from '@/core/money/dto'
import type { FormLine, FormValues } from '../../request-form/model'
import type { PreviewRequestInput, RequestFormData } from '../../request-form/types'

// The lines of the LIFF request form in the browser (§9.4: the first JavaScript of a LIFF page, its page data included).
// A draft's lines are written into the page once, in its data (data.draft.lines): the form opens with them as the
// workspace's form does (model.ts initialValues), and asks the preview of the budget and the route about the complete
// ones (model.ts savableLine), numbers as plain text — before the form's engine has arrived and after. Worked out here
// without model.ts, which brings core/forms and the money maths along: those load with the engine on the requester's
// first touch (./engine.tsx). The rules are the workspace's, written again; tests/unit/liff-requests.test.tsx checks that
// both say the same for any line and any form. Pure.

const QUANTITY = /^\d{1,14}(\.\d{1,4})?$/
const MONEY = /^\d{1,13}(\.\d{1,2})?$/

/** "1,234.50 " → "1234.50": thousands separators and spaces are only for reading (model.ts plainNumber) */
const plain = (text: string) => text.replace(/[\s,]/g, '')

/** A line the service accepts: item, quantity above zero, unit and unit price (model.ts savableLine) */
function complete(line: FormLine): boolean {
  const quantity = plain(line.quantity)
  return line.description.trim().length > 0 && line.uom.trim().length > 0 && QUANTITY.test(quantity) && /[1-9]/.test(quantity) && MONEY.test(plain(line.unitPrice))
}

/** The lines the preview of the budget and the route is asked about: the complete ones, numbers as plain text */
export function previewLinesOf(values: Pick<FormValues, 'lines'>): PreviewRequestInput['lines'] {
  return values.lines.filter(complete).map((l) => ({ quantity: plain(l.quantity), unitPrice: plain(l.unitPrice), vatable: l.vatable }))
}

/** The empty line a new purchase form opens with (model.ts emptyLine) */
const FIRST_LINE: FormLine = { key: 'line-0', id: null, reserved: null, description: '', quantity: '', uom: '', unitPrice: '', vatable: true, serviceEndDate: '' }

/**
 * The lines the form opens with (model.ts initialValues): the draft's, each keyed by its id, with what it holds on the
 * budget line of a returned request; a new purchase form, or a purchase draft without lines, one empty line
 */
export function openingLines(data: RequestFormData): FormLine[] {
  const draft = data.draft
  const purchase = data.type.documentType === 'PURCHASE_REQUEST'
  if (draft && (draft.lines.length > 0 || !purchase)) {
    return draft.lines.map((l) => ({
      ...l,
      key: l.id,
      id: l.id,
      reserved: l.reserved && amountToSatang(l.reserved.amount) > 0n ? l.reserved.amount : null,
      serviceEndDate: l.serviceEndDate ?? '',
    }))
  }
  return purchase ? [FIRST_LINE] : []
}
