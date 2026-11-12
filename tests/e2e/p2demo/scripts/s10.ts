import { systemClock } from '@/lib/clock'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { createRfx, setScorecard } from '@/server/services/sourcing'
import { E2E_DB, E2E_P2DEMO } from '../../../support/e2e-env'

// Run by the scenes of S10 (tests/e2e/p2demo, through ../support.ts s10) against the p2demo e2e database only, on SIMEC
// of the phase-1 workbook. Prints JSON on its last line; amounts are baht text.
//   foreign-rfp <memberEmail> <contactEmail>
//                         scene 13 (S10-17 · FR-INT-201): a new RFP DRAFT for the need of scene 10 — its kind, category
//                         and lines copied from the RFP the seed played (title, description and lines in Thai only, so
//                         the scene types the English), made by the member as procurement does on /sourcing/new, with a
//                         price-only scorecard; and the supplier of the contact (the foreign one of RFx_Suppliers)
//   bid <rfxEventId> <supplierId>
//                         the supplier's bid on the RFx: status and amounts (baht text)

if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the scene script of phase 2 runs in its e2e database only')
if (!E2E_P2DEMO) throw new Error('the scene script of phase 2 runs in p2demo mode only (E2E_P2DEMO=1)')
setDefaultOutboxSender(null)
const [mode, ...args] = process.argv.slice(2)
const org = await prisma.organization.findFirstOrThrow({ where: { code: 'SIMEC' }, select: { id: true } })
const organizationId = org.id
const out = (v: unknown) => console.log(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)))
const baht = (satang: bigint | null) => (satang === null ? null : `${satang / 100n}.${String(satang % 100n).padStart(2, '0')}`)
const fail = (r: { ok: boolean; error?: unknown }) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
}

if (mode === 'foreign-rfp') {
  const [memberEmail, contactEmail] = args as [string, string]
  const member = await prisma.member.findFirstOrThrow({ where: { organizationId, email: memberEmail.toLowerCase() }, select: { id: true } })
  const contact = await prisma.supplierContact.findFirstOrThrow({ where: { organizationId, email: contactEmail.toLowerCase(), supplierId: { not: null } }, select: { supplierId: true } })
  // the RFP of scene 10 the seed played: the need of IT (the RFP of a need the seed made first)
  const played = await prisma.rfxEvent.findFirstOrThrow({
    where: { organizationId, kind: 'RFP', sourceKind: 'NEED', categoryCode: 'IT' },
    orderBy: { createdAt: 'asc' },
    select: { title: true, description: true, categoryCode: true, lines: { orderBy: { lineNo: 'asc' }, select: { description: true, quantity: true, uom: true, catalogItemId: true, refUnitPriceSatang: true, refSource: true } } },
  })
  const ctx = makeCtx({ organizationId, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now: systemClock.now() })
  const made = await createRfx(
    ctx,
    {
      kind: 'RFP',
      title: played.title,
      description: played.description,
      source: {
        kind: 'NEED',
        categoryCode: played.categoryCode,
        lines: played.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity.toString(),
          uom: l.uom,
          ...(l.catalogItemId ? { catalogItemId: l.catalogItemId } : {}),
          ...(l.refSource === 'MANUAL' && l.refUnitPriceSatang !== null ? { refUnitPrice: baht(l.refUnitPriceSatang)! } : {}),
        })),
      },
    },
    { idempotencyKey: `scene13:${Date.now()}`, sender: null },
  )
  fail(made)
  const rfxEventId = (made as { data: { rfxEventId: string } }).data.rfxEventId
  const version = (await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId }, select: { version: true } })).version
  fail(await setScorecard(ctx, { rfxEventId, expectedVersion: version, criteria: [{ code: 'PRICE', nameTh: 'ราคา', nameEn: 'Price', weightBp: 10000, kind: 'PRICE' }], evaluatorMemberIds: [] }, { idempotencyKey: `scene13-card:${rfxEventId}`, sender: null }))
  out({ rfxEventId, supplierId: contact.supplierId })
} else if (mode === 'bid') {
  const [rfxEventId, supplierId] = args as [string, string]
  const bid = await prisma.bid.findFirstOrThrow({ where: { organizationId, rfxEventId, supplierId }, select: { status: true, netSatang: true, vatSatang: true, grossSatang: true } })
  const rfx = await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId }, select: { locale: true, currency: true, status: true } })
  out({ status: bid.status, net: baht(bid.netSatang), vat: baht(bid.vatSatang), gross: baht(bid.grossSatang), locale: rfx.locale, currency: rfx.currency, rfxStatus: rfx.status })
} else {
  throw new Error(`unknown mode ${mode ?? ''}`)
}
