import { randomUUID } from 'node:crypto'
import { portalRequest, postSession } from '@/server/portal/http'
import { isUuid } from '@/server/queries/requests'
import { saveBid, submitBid, withdrawBid } from '@/server/services/sourcing'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../../_lib/respond'

// POST /portal/<org>/api/rfx/bid (S10-06 · FR-SRC-202 AC2 AC3): the contact saves, submits or withdraws its bid
// (action = save | submit | withdraw). Lines come as line:<rfxLineId>:price · :offered · :brand · :lead · :note; a line
// left without a price and not ticked as offered is not offered. The answer is the RFx page with ?saved= ?sent= ?withdrawn=
// or ?error= (and ?reason= ?lines=) — S10-07: a draft and a refusal come back to /rfx/<id>/bid. Logs never carry a price
// (NFR-SEC-09).

const intOf = (v: string): number | undefined => (/^\d{1,4}$/.test(v) ? Number(v) : undefined)

function linesOf(form: FormData) {
  const ids = new Set<string>()
  for (const key of form.keys()) {
    const m = /^line:([0-9a-f-]{36}):/.exec(key)
    if (m && isUuid(m[1]!)) ids.add(m[1]!)
  }
  return [...ids].map((id) => {
    const price = field(form, `line:${id}:price`).trim().replaceAll(',', '')
    const offered = field(form, `line:${id}:offered`) === '1' || price !== ''
    return {
      rfxLineId: id,
      offered,
      ...(offered && price ? { unitPrice: price } : {}),
      ...(field(form, `line:${id}:brand`) ? { brand: field(form, `line:${id}:brand`) } : {}),
      ...(intOf(field(form, `line:${id}:lead`)) !== undefined ? { leadTimeDays: intOf(field(form, `line:${id}:lead`)) } : {}),
      ...(field(form, `line:${id}:note`) ? { note: field(form, `line:${id}:note`) } : {}),
    }
  })
}

export async function POST(request: Request, { params }: { params: Promise<{ org: string }> }) {
  const req = await portalRequest(request, (await params).org)
  if (!req) return notFound()
  const form = await formOf(request)
  const state = await postSession(request, req, field(form, 'csrf'), 'rfx/bid')
  if (state === 'NONE') return notFound()
  if (state === 'CSRF') return forbiddenCsrf()
  const rfxEventId = field(form, 'rfxEventId')
  if (!isUuid(rfxEventId)) return seeOther(req.org, '/rfx', { error: 'NOT_FOUND' })
  const page = `/rfx/${rfxEventId}`
  const action = field(form, 'action')
  const content = {
    rfxEventId,
    priceIncludesVat: field(form, 'vatIncluded') === '1',
    ...(intOf(field(form, 'deliveryDays')) !== undefined ? { deliveryDays: intOf(field(form, 'deliveryDays')) } : {}),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(field(form, 'promisedDeliveryOn')) ? { promisedDeliveryOn: field(form, 'promisedDeliveryOn') } : {}),
    ...(field(form, 'note') ? { note: field(form, 'note') } : {}),
    lines: linesOf(form),
  }
  const version = intOf(field(form, 'version'))
  // one submit per version of the bid (§4.3): a double click sends the same key and gets the same answer
  const key = field(form, 'key') || (action === 'submit' && isUuid(field(form, 'bidId')) && version !== undefined ? `bid:${field(form, 'bidId')}:${version}` : randomUUID())
  const r =
    action === 'submit'
      ? await submitBid(state.ctx, { ...content, ...(version !== undefined ? { expectedVersion: version } : {}) }, { idempotencyKey: key })
      : action === 'withdraw'
        ? await withdrawBid(state.ctx, { rfxEventId }, { idempotencyKey: key })
        : await saveBid(state.ctx, content, { idempotencyKey: key })
  // S10-07: a sent or withdrawn bid shows on the RFx's page; a draft, and a refusal of save or submit, come back to the form
  const formPage = `${page}/bid`
  if (r.ok) return action === 'submit' ? seeOther(req.org, page, { sent: 1 }) : action === 'withdraw' ? seeOther(req.org, page, { withdrawn: 1 }) : seeOther(req.org, formPage, { saved: 1 })
  const details: Readonly<Record<string, unknown>> = r.error.details ?? {}
  return seeOther(req.org, action === 'withdraw' ? page : formPage, { error: r.error.code, reason: typeof details.reason === 'string' ? details.reason : undefined, lines: typeof details.lines === 'string' ? details.lines : undefined })
}
