import { prisma } from '../../src/server/db/client'
import { E2E_DB, E2E_P2DEMO } from '../../tests/support/e2e-env'

// S7-18 (§9.9 step 4): the records the screen review of S7 opens (scripts/design-review/s7-pages.spec.ts), on the p2demo
// database after the @p2demo scenes played on it (SIMEC of the phase-1 workbook). Prints JSON on its last line.
//   targets   the organization, a supplier with a portal contact and its documents (scene 6's), its PO sent to it, the
//             invoice it sent on the portal, the stuck application (scene 2's) and the one approved in scene 1 with its
//             bank account change, an open approval task of a supplier application and who holds it, the PO of scene 5
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the screen review of S7 runs in its e2e database only')
if (!E2E_P2DEMO) throw new Error('the screen review of S7 runs in p2demo mode only (E2E_P2DEMO=1)')
const [mode] = process.argv.slice(2)
if (mode !== 'targets') throw new Error(`unknown mode ${mode}`)

const org = await prisma.organization.findFirstOrThrow({ where: { code: 'SIMEC' }, select: { id: true, code: true } })
const organizationId = org.id
const supplier = await prisma.supplier.findFirstOrThrow({ where: { organizationId, code: 'SP0029' }, select: { id: true } })
const sentPo = await prisma.purchaseOrder.findFirst({ where: { organizationId, supplierId: supplier.id, status: 'SENT' }, orderBy: { createdAt: 'desc' }, select: { id: true } })
const portalInvoice = await prisma.invoice.findFirst({ where: { organizationId, supplierId: supplier.id, channel: 'PORTAL' }, orderBy: { createdAt: 'desc' }, select: { id: true } })
const contactApp = async (email: string) => (await prisma.supplierContact.findFirst({ where: { organizationId, email, applicationId: { not: null } }, orderBy: { createdAt: 'desc' }, select: { applicationId: true } }))?.applicationId ?? null
const stuck = await contactApp('bpk@supplier.simec.local')
const applied = await contactApp('rcb@supplier.simec.local')
const appliedSupplier = applied ? (await prisma.supplierApplication.findUnique({ where: { id: applied }, select: { approvedSupplierId: true } }))?.approvedSupplierId ?? null : null
const bankChange = appliedSupplier ? await prisma.bankAccountChange.findFirst({ where: { organizationId, supplierId: appliedSupplier }, orderBy: { createdAt: 'desc' }, select: { id: true } }) : null
const task = await prisma.approvalTask.findFirst({
  where: { organizationId, status: 'OPEN', step: { route: { subjectType: 'SUPPLIER_APPLICATION' } } },
  orderBy: { createdAt: 'asc' },
  select: { id: true, assignee: { select: { employeeCode: true } } },
})
const acked = await prisma.purchaseOrder.findFirst({ where: { organizationId, supplierAckStatus: { not: 'NOT_ACKNOWLEDGED' } }, orderBy: { updatedAt: 'desc' }, select: { id: true } })
const contact = await prisma.supplierContact.findFirstOrThrow({ where: { organizationId, supplierId: supplier.id, isPrimary: true }, select: { email: true } })
console.log(
  JSON.stringify({
    org: org.code.toLowerCase(),
    organizationId,
    supplierId: supplier.id,
    supplierContact: contact.email,
    sentPo: sentPo?.id ?? null,
    portalInvoice: portalInvoice?.id ?? null,
    stuckApplication: stuck,
    appliedApplication: applied,
    bankChange: bankChange?.id ?? null,
    supplierTask: task ? { id: task.id, code: task.assignee?.employeeCode ?? null } : null,
    ackedPo: acked?.id ?? null,
  }),
)
await prisma.$disconnect()
