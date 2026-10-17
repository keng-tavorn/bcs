import { satangToAmount } from '@/core/money/dto'
import { ok, type Result } from '@/core/result'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { applyAiAssist, assertNoPendingAiReview, decimalText, registerAssistSubject, type AiAssist } from '../ai/assist-contract'

// The values of a request by form path (BR-AI-17 of S13, ADR-148): what an AI action may propose for a request and
// what the person ended up with. Paths: title · requestTypeCode · priceIncludesVat · suggestedSupplierId · deliverySiteId ·
// formData.<field> · lines.<i>.description|quantity|uom|unitPrice|categoryCode · quotations.<q>.supplierName|supplierId|
// amount|includesVat, where <q> is the quotation's file (the file the Document Agent read: it stays the same however the
// quotations are reordered) or its place for one without a file. Quantities and amounts are written as the form writes
// them (decimalText, satangToAmount).

export async function readRequestForAssist(tx: TenantTx, id: string): Promise<Record<string, string> | null> {
  const r = await tx.request.findFirst({
    where: { id },
    select: {
      title: true,
      priceIncludesVat: true,
      suggestedSupplierId: true,
      deliverySiteId: true,
      formData: true,
      requestType: { select: { code: true } },
      lines: { orderBy: { lineNo: 'asc' }, select: { description: true, quantity: true, uom: true, unitPriceSatang: true, categoryCode: true } },
      // Saved together, quotations share one createdAt: the id (UUID v7, made in order) breaks the tie
      quotations: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { supplierName: true, supplierId: true, amountSatang: true, includesVat: true, fileId: true } },
    },
  })
  if (!r) return null
  const out: Record<string, string> = {
    title: r.title,
    requestTypeCode: r.requestType.code,
    priceIncludesVat: String(r.priceIncludesVat),
  }
  if (r.suggestedSupplierId) out.suggestedSupplierId = r.suggestedSupplierId
  if (r.deliverySiteId) out.deliverySiteId = r.deliverySiteId
  for (const [key, value] of Object.entries((r.formData ?? {}) as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'boolean') out[`formData.${key}`] = String(value)
  }
  r.lines.forEach((l, i) => {
    out[`lines.${i}.description`] = l.description
    out[`lines.${i}.quantity`] = decimalText(l.quantity)
    out[`lines.${i}.uom`] = l.uom
    out[`lines.${i}.unitPrice`] = satangToAmount(l.unitPriceSatang)
    if (l.categoryCode) out[`lines.${i}.categoryCode`] = l.categoryCode
  })
  r.quotations.forEach((q, i) => {
    const at = `quotations.${q.fileId ?? i}`
    out[`${at}.supplierName`] = q.supplierName
    if (q.supplierId) out[`${at}.supplierId`] = q.supplierId
    out[`${at}.amount`] = satangToAmount(q.amountSatang)
    out[`${at}.includesVat`] = String(q.includesVat)
  })
  return out
}

// A request takes what the Document Agent read from a quotation and what the Intake Agent drafted; a draft may keep
// fields waiting until it is sent (request.submit and request.resubmit check)
registerAssistSubject('REQUEST', { purposes: ['QUOTATION_READ', 'INTAKE'], final: false, read: readRequestForAssist, align: alignRequestLines })

const LINE_PATH = /^lines\.(\d+)\.(.+)$/

/** The line places that paths name, in order */
function linePlaces(values: Readonly<Record<string, string>>): number[] {
  const places = new Set<number>()
  for (const k of Object.keys(values)) {
    const m = LINE_PATH.exec(k)
    if (m) places.add(Number(m[1]))
  }
  return [...places].sort((a, b) => a - b)
}

/**
 * Where each line the AI proposed is now: first by its description — at its own place, else the first line not taken
 * yet that has it — then, for one whose description the person changed, at its own place if no other proposal took
 * it. Its values are compared there, so removing or adding a line above leaves the values the AI put in waiting where
 * they moved (BR-AI-16), and a line whose description alone was changed still waits for its quantity and price. A
 * proposed line left without a place was removed by the person. Lines no proposal refers to are not compared.
 */
export function alignRequestLines(proposed: Readonly<Record<string, string>>, current: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = Object.fromEntries(Object.entries(current).filter(([k]) => !LINE_PATH.test(k)))
  const lines = linePlaces(current)
  const wanted = linePlaces(proposed)
  const placeOf = new Map<number, number>()
  const taken = new Set<number>()
  const fieldsOf = (i: number) => Object.entries(proposed).flatMap(([k, v]) => {
    const m = LINE_PATH.exec(k)
    return m && Number(m[1]) === i ? [[m[2]!, v] as const] : []
  })
  // a line still exactly as proposed first (two lines of one description stay told apart), then by description
  const matchBy = (same: (i: number, j: number) => boolean) => {
    for (const i of wanted) {
      if (placeOf.has(i)) continue
      const free = (j: number) => !taken.has(j) && same(i, j)
      const j = free(i) ? i : lines.find(free)
      if (j === undefined) continue
      placeOf.set(i, j)
      taken.add(j)
    }
  }
  matchBy((i, j) => fieldsOf(i).every(([f, v]) => current[`lines.${j}.${f}`] === v))
  matchBy((i, j) => proposed[`lines.${i}.description`] !== undefined && current[`lines.${j}.description`] === proposed[`lines.${i}.description`])
  for (const i of wanted) {
    if (!placeOf.has(i) && lines.includes(i) && !taken.has(i)) {
      placeOf.set(i, i)
      taken.add(i)
    }
  }
  for (const [i, j] of placeOf) {
    for (const [k, v] of Object.entries(current)) {
      const m = LINE_PATH.exec(k)
      if (m && Number(m[1]) === j) out[`lines.${i}.${m[2]}`] = v
    }
  }
  return out
}

/** request.create_draft and request.edit: what the person confirmed of an AI action, after the draft was written */
export function aiAssisted(tx: TenantTx, ctx: Ctx, requestId: string, input: AiAssist | undefined): Promise<Result<readonly EventDraft[]>> {
  return applyAiAssist(tx, ctx, { type: 'REQUEST', id: requestId }, input)
}

/** request.submit and request.resubmit: the same, then nothing the AI filled may still wait (AI_REVIEW_PENDING) */
export async function aiReviewed(tx: TenantTx, ctx: Ctx, requestId: string, input: AiAssist | undefined): Promise<Result<readonly EventDraft[]>> {
  const applied = await aiAssisted(tx, ctx, requestId, input)
  if (!applied.ok) return applied
  const pending = await assertNoPendingAiReview(tx, ctx, { type: 'REQUEST', id: requestId })
  return pending.ok ? ok(applied.data) : pending
}
