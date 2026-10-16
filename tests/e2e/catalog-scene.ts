import { randomUUID } from 'node:crypto'
import { agreementDay } from '@/core/pricing'
import { systemClock } from '@/lib/clock'
import { MS_PER_DAY } from '@/lib/constants'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { createCatalogItem, createPriceAgreement } from '@/server/services/catalog'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/catalog.spec.ts against the e2e database only (S6-10 · FR-INT-102). Everything is made through the
// services as a PROCUREMENT member, with fresh idempotency keys and fresh codes, so a spec may run it again in the same
// database. Prints what the spec needs as JSON on the last line.
//   agreed <procurement member> <name>  a catalogue item named <name> (with its code), 180.00 baht per bag for reference,
//                                       with an agreed price of 1,234.50 with the first active supplier of the register
//                                       from today for 90 days
//   supplier <member>                   the first active supplier of the register (code and name)
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the catalog scene runs in the e2e database only')

const [command, who, name] = process.argv.slice(2)
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const member = await prisma.member.findFirstOrThrow({ where: { employeeCode: who }, select: { id: true, organizationId: true } })
const now = systemClock.now()
const ctx = makeCtx({ organizationId: member.organizationId, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now })
const supplier = await prisma.supplier.findFirstOrThrow({ where: { organizationId: member.organizationId, status: 'ACTIVE' }, orderBy: { code: 'asc' }, select: { id: true, code: true, nameTh: true } })

let out: unknown
switch (command) {
  case 'agreed': {
    const code = `E2E-${randomUUID().slice(0, 8).toUpperCase()}`
    const nameTh = `${name ?? 'ปูนทดสอบ'} ${code.slice(-4)}`
    const item = await createCatalogItem(ctx, { code, nameTh, uom: 'ถุง', categoryCode: 'CEMENT', isService: false, refUnitPrice: '180.00' }, key())
    if (!item.ok) throw new Error(`item failed: ${JSON.stringify(item.error)}`)
    const today = agreementDay(now)
    const validTo = new Date(Date.parse(`${today}T00:00:00Z`) + 90 * MS_PER_DAY).toISOString().slice(0, 10)
    const agreed = await createPriceAgreement(ctx, { catalogItemId: item.data.catalogItemId, supplierId: supplier.id, unitPrice: '1234.50', validFrom: today, validTo, sourceRef: `E2E ${code}` }, key())
    if (!agreed.ok) throw new Error(`agreement failed: ${JSON.stringify(agreed.error)}`)
    out = { itemId: item.data.catalogItemId, code, nameTh, supplier: { id: supplier.id, code: supplier.code, nameTh: supplier.nameTh }, today }
    break
  }
  case 'supplier':
    out = { id: supplier.id, code: supplier.code, nameTh: supplier.nameTh, today: agreementDay(now) }
    break
  default:
    throw new Error(`unknown command ${command}`)
}
await prisma.$disconnect()
console.log(JSON.stringify(out))
