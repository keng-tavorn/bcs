import { prisma } from '@/server/db/client'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/go-receive.spec.ts against the e2e database only (S17-13, FR-PLT-301 AC7 to AC9). The sent POs and
// their receivers come from tests/e2e/receiving-scene.ts; this switches BCS Go on for the demo organization while the
// spec runs (rows only, as a platform admin would leave them: /api/go/receiving/prepare answers MODULE_DISABLED
// otherwise) and reads back what the queue of /go/receive recorded. Prints JSON on the last line.
//   module on|off   BCS_GO of the demo organization (the specs of the run go one at a time: workers 1)
//   receipts <poId> the PO's receipts, oldest first: number, when it was captured offline, its photos, and the channel
//                   and key its gr.posted Event was recorded with
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the BCS Go receiving scene runs in the e2e database only')

const [command, first = ''] = process.argv.slice(2)
const org = await prisma.organization.findFirstOrThrow({ where: { code: 'DEMO' }, select: { id: true } })

switch (command) {
  case 'module': {
    if (first !== 'on' && first !== 'off') throw new Error('module on|off')
    const enabled = first === 'on'
    const at = new Date()
    await prisma.orgModule.upsert({
      where: { organizationId_module: { organizationId: org.id, module: 'BCS_GO' } },
      create: { organizationId: org.id, module: 'BCS_GO', enabled, enabledAt: enabled ? at : null, contractRef: 'E2E-S17-13', reason: 'ทดสอบตรวจรับออฟไลน์ใน e2e' },
      update: enabled ? { enabled, enabledAt: at, disabledAt: null } : { enabled, disabledAt: at },
    })
    console.log(JSON.stringify({ module: 'BCS_GO', enabled }))
    break
  }
  case 'receipts': {
    if (!/^[0-9a-f-]{36}$/.test(first)) throw new Error('receipts <poId>')
    const receipts = await prisma.goodsReceipt.findMany({ where: { organizationId: org.id, poId: first }, orderBy: { postedAt: 'asc' }, select: { id: true, number: true, offlineCapturedAt: true, receivedAt: true, postedAt: true } })
    const out = []
    for (const gr of receipts) {
      const photos = await prisma.fileLink.count({ where: { subjectType: 'GoodsReceipt', subjectId: gr.id, kind: 'PHOTO' } })
      const posted = await prisma.event.findFirstOrThrow({ where: { aggregateId: gr.id, type: 'gr.posted' }, select: { channel: true, schemaVersion: true } })
      out.push({ number: gr.number, offline: gr.offlineCapturedAt !== null, receivedBeforePosted: gr.postedAt !== null && gr.receivedAt <= gr.postedAt, photos, channel: posted.channel, schemaVersion: posted.schemaVersion })
    }
    console.log(JSON.stringify({ receipts: out }))
    break
  }
  default:
    throw new Error('module on|off · receipts <poId>')
}
await prisma.$disconnect()
