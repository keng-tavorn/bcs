import { randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { createDraft } from '@/server/services/requests'
import { getRequestForEdit } from '@/server/services/requests/form-view'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/admin-settings.spec.ts against the e2e database only (FR-ADM-005 AC3), the way the request page of
// another unit will act: `draft <member code> <request type code>` makes a draft of that type before a new form version
// is published; `form <member code> <request id>` prints the form version the draft keeps and the ids of its fields.
// The answer is JSON on the last line.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the admin settings scene runs in the e2e database only')

const [command, memberCode, subject] = process.argv.slice(2)
if (!memberCode || !subject || (command !== 'draft' && command !== 'form')) throw new Error('usage: admin-settings-scene.ts draft <member> <type> | form <member> <requestId>')

const member = await prisma.member.findFirstOrThrow({ where: { employeeCode: memberCode }, select: { id: true, organizationId: true } })
const ctx = makeCtx({ organizationId: member.organizationId, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now: systemClock.now() })

if (command === 'draft') {
  const draft = await createDraft(ctx, { requestTypeCode: subject, title: 'คำขอที่ทำก่อนฟอร์มฉบับใหม่' }, { idempotencyKey: randomUUID(), sender: null })
  if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft.error)}`)
  console.log(JSON.stringify({ requestId: draft.data.requestId }))
} else {
  const form = await getRequestForEdit(ctx, subject, 'th')
  if (!form.ok) throw new Error(`form failed: ${JSON.stringify(form.error)}`)
  const request = await prisma.request.findUniqueOrThrow({ where: { id: subject }, select: { formVersion: { select: { versionNo: true } } } })
  console.log(JSON.stringify({ versionNo: request.formVersion.versionNo, fields: form.data.form.fields.map((f) => f.id) }))
}
await prisma.$disconnect()
