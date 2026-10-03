import { normalizeTaxId } from '@/core/thai/taxid'
import type { Principal } from '@/server/authz'
import { isIndividualTaxId, maskTaxId, supplierAccess } from '../suppliers/access'

// BR-AUTH-04 in the audit trail (NEW-33, FR-VIS-004): events keep their data as written, and the data of
// supplier.created and supplier.registry_checked holds the supplier's tax id — for a Thai individual, their national id
// number. The trail shows it the way the supplier register does (../suppliers/access.ts, the same rule and format): whole
// only to a reader the register shows it to whole (supplier.view in full through a grant other than the AUDITOR's:
// PROCUREMENT, FINANCE); masked, all but the last four digits replaced, to every other reader of the trail — the
// AUDITOR, and ORG_ADMIN, to whom the register shows no tax id at all. A juristic person's and a foreign supplier's tax
// id are not national id numbers and stay whole. An exported file says whether it holds a number whole, and such a
// file goes only to readers who see numbers whole (as an individual's registry proof, ../suppliers/file-policy.ts).
// Nothing about who may read or export the trail changes.

/** Whether this reader sees national id numbers in event data whole: only a reader the supplier register shows them to whole */
export function seesNationalIdsWhole(principal: Principal): boolean {
  const access = supplierAccess(principal)
  return access?.level === 'FULL' && !access.maskIndividualTaxIds
}

type Data = Readonly<Record<string, unknown>>
const isData = (value: unknown): value is Data => value !== null && typeof value === 'object' && !Array.isArray(value)

/** A supplier's tax id as the register shows it to a reader who sees individuals' numbers masked */
const supplierTaxId = (taxId: unknown, isForeign: boolean): unknown => (typeof taxId === 'string' && isIndividualTaxId(taxId, isForeign) ? maskTaxId(taxId) : taxId)

/** The data with its tax id as given: the same object when nothing changes */
const withTaxId = (data: Data, taxId: unknown): Data => (taxId === data.taxId ? data : { ...data, taxId })

const THIRTEEN_DIGITS = /^\d{13}$/

/** Free text that is a Thai individual's 13-digit number, with or without spaces and dashes: the digits, else null */
function nationalIdIn(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const digits = normalizeTaxId(text.trim())
  return THIRTEEN_DIGITS.test(digits) && isIndividualTaxId(digits, false) ? digits : null
}

/**
 * The fields of the event catalogue (src/server/events/schemas) whose data may hold a national id number, by event type,
 * and how each is masked; each gives back the same object when it holds none
 */
const NATIONAL_ID_FIELDS: Readonly<Record<string, (data: Data) => Data>> = {
  'supplier.created': (d) => withTaxId(d, supplierTaxId(d.taxId, d.isForeign === true)),
  // the registries are asked about Thai tax ids only (../suppliers/index.ts), so this is never a foreign supplier's
  'supplier.registry_checked': (d) => withTaxId(d, supplierTaxId(d.taxId, false)),
  // the search as it was typed: a person's number typed into the document box is kept with the export
  'audit.exported': (d) => {
    const filter = d.filter
    if (!isData(filter)) return d
    const id = nationalIdIn(filter.document)
    return id ? { ...d, filter: { ...filter, document: maskTaxId(id) } } : d
  },
}

/** The data of an event as a reader who sees national id numbers masked (BR-AUTH-04) reads it; the same object when it holds none */
export function maskNationalIds(type: string, data: unknown): unknown {
  const mask = NATIONAL_ID_FIELDS[type]
  return mask && isData(data) ? mask(data) : data
}

/** Whether the data of an event holds a national id number whole */
export const holdsNationalId = (type: string, data: unknown): boolean => maskNationalIds(type, data) !== data

/**
 * An audit file (ExportJob of kind AUDIT) for a reader who may export the trail: a file that holds a national id number
 * whole only for a reader who sees them whole. The file says so in its params (wholeNationalIds, written by the export);
 * a file that does not say — one made before files said it — may hold them whole.
 */
export function auditFileReadable(principal: Principal, params: unknown): boolean {
  const whole = isData(params) ? params.wholeNationalIds : undefined
  return whole === false || seesNationalIdsWhole(principal)
}
