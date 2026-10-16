import { randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { PROMPT_VERSIONS } from '@/lib/ai-config'
import { MS_PER_HOUR } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { upsertUserWithPassword } from '@/server/auth/provision'
import { seedLineChannel } from '@/server/services/line-channel'
import { issueLineLinkCode, linkLineAccount } from '@/server/services/line-link'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/liff-chat.spec.ts (S17-07 · FR-LINE-301 AC4 AC7) against the e2e database only:
//   intake <tag> <lineUserId>   a fresh requester of the demo organization's construction department (e2e-lc-<tag>),
//                               linked to that LINE account, with a chat draft as the chat side leaves it: two lines of
//                               text and a photo LINE no longer had (FAILED), so the page shows both
//   intake-ai <tag> <lineUserId>  the same, with the Intake Agent's reading of it linked as job chat-intake-ai leaves it
//                               (S17-08: a DRAFT AgentAction whose values the LIFF page offers; no model call in e2e)
//   state <intakeId>            how the chat draft stands now and the request drafts its owner has
// Prints JSON on the last line.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the LIFF chat scene runs in the e2e database only')

const [mode, first = '', second = ''] = process.argv.slice(2)

async function intake() {
  const [tag, lineUserId] = [first, second]
  if (!/^[a-z0-9-]{3,40}$/.test(tag)) throw new Error('the requester needs a tag of lower-case letters, digits and -')
  const org = await prisma.organization.findFirstOrThrow({ where: { code: 'DEMO' }, select: { id: true } })
  const con = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: 'CON' }, select: { id: true } })
  const now = systemClock.now()
  if (!(await prisma.lineChannelConfig.findFirst({ where: { organizationId: org.id }, select: { id: true } }))) {
    const line = await seedLineChannel(org.id, getEnv(), now)
    if (line.status !== 'CREATED') throw new Error(`the LINE channel was not saved: ${line.status}`)
  }
  const employeeCode = `e2e-lc-${tag}`
  const email = `${employeeCode}@demo.bcs.local`
  const userId = await upsertUserWithPassword({ email, name: `ทดสอบ แชท ${tag}`, password: process.env.SEED_DEV_PASSWORD! })
  const member = await prisma.member.upsert({
    where: { organizationId_email: { organizationId: org.id, email } },
    create: { organizationId: org.id, userId, email, displayNameTh: `ทดสอบ แชท ${tag}`, employeeCode, status: 'ACTIVE', primaryDepartmentId: con.id },
    update: {},
    select: { id: true },
  })
  const issued = await issueLineLinkCode(makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now }), now)
  if (!issued.ok) throw new Error(`no link code: ${issued.error.code}`)
  const answer = await fetch(`${process.env.LINE_API_BASE_URL}/__fake/id-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub: lineUserId, aud: process.env.LINE_LIFF_CHANNEL_ID }),
  })
  const { idToken } = (await answer.json()) as { idToken: string }
  const linked = await linkLineAccount({ code: issued.data.code, idToken }, { sender: null, requestId: randomUUID() })
  if (!linked.ok) throw new Error(`not linked: ${linked.error.code}`)
  // The chat draft as chat_intake.receive and the image job leave it (the chat side is tested in tests/integration/chat-intake.test.ts)
  const draft = await prisma.chatIntake.create({
    data: { organizationId: org.id, memberId: member.id, status: 'OPEN', text: 'ขอซื้อหมวกนิรภัยสีขาว 20 ใบ\nส่งที่ไซต์ก่อสร้างบางนา', messageCount: 3, imageCount: 1, openedAt: now, lastMessageAt: now, expiresAt: new Date(now.getTime() + 24 * MS_PER_HOUR), linkSentAt: now },
  })
  const id = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`
  await prisma.chatIntakeItem.createMany({
    data: [
      { organizationId: org.id, intakeId: draft.id, seq: 1, kind: 'TEXT', lineMessageId: id(), receivedAt: now },
      { organizationId: org.id, intakeId: draft.id, seq: 2, kind: 'TEXT', lineMessageId: `${id()}2`, receivedAt: now },
      { organizationId: org.id, intakeId: draft.id, seq: 3, kind: 'IMAGE', lineMessageId: `${id()}3`, fetchStatus: 'FAILED', fetchError: 'GONE', receivedAt: now },
    ],
  })
  if (mode === 'intake-ai') {
    const action = await prisma.agentAction.create({
      data: {
        organizationId: org.id,
        agent: 'INTAKE',
        purpose: 'INTAKE',
        level: 'L1',
        status: 'DRAFT',
        subjectType: 'CHAT_INTAKE',
        subjectId: draft.id,
        requestedById: member.id,
        channel: 'LINE_CHAT',
        promptVersion: PROMPT_VERSIONS.INTAKE,
        idempotencyKey: `chat_intake:${draft.id}:3`,
        review: {
          proposed: { requestTypeCode: 'BUY_GOODS', title: 'หมวกนิรภัยสีขาวสำหรับไซต์บางนา', 'lines.0.description': 'หมวกนิรภัยสีขาว', 'lines.0.quantity': '20', 'lines.0.uom': 'ใบ', 'lines.0.unitPrice': '250.00' },
          requiredPaths: ['lines.0.quantity', 'lines.0.unitPrice', 'requestTypeCode'],
          confirmedPaths: [],
        },
      },
    })
    await prisma.chatIntake.update({ where: { id: draft.id }, data: { agentActionId: action.id } })
  }
  return { memberId: member.id, intakeId: draft.id }
}

async function state() {
  const draft = await prisma.chatIntake.findUniqueOrThrow({ where: { id: first }, select: { status: true, requestId: true, memberId: true } })
  const requests = await prisma.request.count({ where: { requesterMemberId: draft.memberId } })
  return { status: draft.status, requestId: draft.requestId, requests }
}

const result = mode === 'intake' || mode === 'intake-ai' ? await intake() : mode === 'state' ? await state() : null
if (result === null) throw new Error(`unknown mode ${mode}`)
console.log(JSON.stringify(result))
await prisma.$disconnect()
