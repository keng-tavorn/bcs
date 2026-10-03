import { randomInt, randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { createSupplier } from '@/server/services/suppliers'
import { createDraft } from '@/server/services/requests'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/suppliers*.spec.ts and request-form*.spec.ts (unit h) against the e2e database only. Everything is
// made through the services with fresh idempotency keys and fresh codes, so a spec may run it again in the same
// database. Prints what the spec needs as JSON on the last line.
//   supplier <member> <name>    an individual supplier (the stub's 1234567890121 at a random branch) without an Express
//                               vendor code, added by <member> (PROCUREMENT) after the registry check
//   site-draft <member> <site>  a purchase draft of <member> that names delivery site <site> (its code), so the next new
//                               form of <member> starts with that site (BR-FORM-02 "the latest site"); nobody is told
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the supplier scene runs in the e2e database only')

const [command, who, arg] = process.argv.slice(2)
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const member = await prisma.member.findFirstOrThrow({ where: { employeeCode: who }, select: { id: true, organizationId: true } })
const ctx = makeCtx({ organizationId: member.organizationId, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now: systemClock.now() })

let out: unknown
switch (command) {
  case 'supplier': {
    const code = `E2E-${randomUUID().slice(0, 8).toUpperCase()}`
    const branchCode = String(randomInt(10000, 99999))
    const nameTh = `${arg ?? 'นายทดสอบ ผู้รับจ้าง'} ${code.slice(-4)}`
    const created = await createSupplier(ctx, { code, nameTh, taxId: '1234567890121', branchCode, isVatRegistered: false, category: 'งานซ่อมบำรุง', registry: { check: 'LOOKUP' } }, key())
    if (!created.ok) throw new Error(`supplier failed: ${JSON.stringify(created.error)}`)
    out = { id: created.data.supplierId, code, nameTh, branchCode }
    break
  }
  case 'site-draft': {
    const site = await prisma.deliverySite.findFirstOrThrow({ where: { organizationId: member.organizationId, code: arg }, select: { id: true } })
    const draft = await createDraft(ctx, { requestTypeCode: 'BUY_GOODS', title: `ร่างส่งที่ ${arg} ${randomUUID().slice(0, 4)}`, deliverySiteId: site.id }, key())
    if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft.error)}`)
    out = { requestId: draft.data.requestId, siteId: site.id }
    break
  }
  default:
    throw new Error(`unknown command ${command}`)
}
await prisma.$disconnect()
console.log(JSON.stringify(out))
