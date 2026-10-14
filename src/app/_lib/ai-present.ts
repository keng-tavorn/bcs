import type { AgentActionDto } from '@/server/services/ai'
import type { AiDoaDraftView, AiNote, AiReadingView, AiResultView } from '@/ui/ai/types'

// An AgentAction of the Document Agent as its screen shows it (FR-AI-303 AC1): the values proposed for the form and
// which must be confirmed one by one, what was read, and what the checks and the mapping found. The content is the
// requester's own (getAgentAction gives it to them only); anything else in the row stays on the server.

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

function readingOf(output: unknown): AiReadingView | null {
  const r = obj(obj(output).reading)
  if (Object.keys(r).length === 0) return null
  const seller = obj(r.seller)
  const lines = Array.isArray(r.lines) ? r.lines.map(obj) : []
  return {
    docNo: text(r.docNo),
    docDate: text(r.docDate),
    sellerName: text(seller.name),
    sellerTaxId: text(seller.taxId),
    sellerBranch: text(seller.branch),
    priceIncludesVat: typeof r.priceIncludesVat === 'boolean' ? r.priceIncludesVat : null,
    net: text(r.net),
    vat: text(r.vat),
    gross: text(r.gross),
    lines: lines.map((l) => ({ description: text(l.description), qty: text(l.qty), unit: text(l.unit), unitPrice: text(l.unitPrice), amount: text(l.amount) })),
  }
}

/** Failures of the checks first, then their warnings, then what the mapping could not fill (with its line) */
function notesOf(verification: unknown, output: unknown): AiNote[] {
  const v = obj(verification)
  const mapping = obj(obj(output).mapping)
  const notes: AiNote[] = [...strings(v.fail).map((code) => ({ code, tone: 'danger' as const })), ...strings(v.warn).map((code) => ({ code, tone: 'warning' as const }))]
  for (const flag of Array.isArray(mapping.flags) ? mapping.flags : []) {
    if (typeof flag === 'string') notes.push({ code: flag, tone: 'info' })
    else {
      const f = obj(flag)
      const line = typeof f.dnLine === 'number' ? f.dnLine + 1 : typeof f.lineNo === 'number' ? f.lineNo : undefined
      if (typeof f.code === 'string') notes.push({ code: f.code, tone: f.code === 'OVER_OPEN' ? 'warning' : 'info', ...(line === undefined ? {} : { line }) })
    }
  }
  return notes
}

export function presentAiResult(dto: AgentActionDto): AiResultView {
  const content = dto.content
  const review = obj(content?.review)
  const proposed = Object.fromEntries(Object.entries(obj(review.proposed)).filter((e): e is [string, string] => typeof e[1] === 'string'))
  return {
    id: dto.id,
    status: dto.status as AiResultView['status'],
    errorCode: dto.errorCode,
    proposed,
    requiredPaths: strings(review.requiredPaths),
    reading: content ? readingOf(content.output) : null,
    notes: content ? notesOf(content.verification, content.output) : [],
    suggestedType: text(obj(content?.output).suggestedType) ? { code: text(obj(content?.output).suggestedType)!, name: text(obj(content?.output).suggestedTypeName) ?? text(obj(content?.output).suggestedType)! } : null,
    supplierText: text(obj(content?.output).supplierText),
    doa: content && typeof obj(content.output).yaml === 'string' ? (content.output as AiDoaDraftView) : null,
  }
}
