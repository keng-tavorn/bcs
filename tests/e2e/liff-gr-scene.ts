import { randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { getMyLineLink, issueLineLinkCode, linkLineAccount, unlinkMyLine } from '@/server/services/line-link'
import { runLineRichMenu } from '../../scripts/line-richmenu'
import { E2E_DB } from '../support/e2e-env'

// Run by the LIFF specs of S5-06 (tests/e2e/liff-gr.spec.ts, tests/e2e/liff-delegation.spec.ts) against the e2e database
// only: links a member of the demo organization to a LINE account through the services, as /settings/line and the LIFF
// link page would (a code issued for the member, spent with an ID token the fake LINE server issued for that LINE user),
// makes a member who has nothing to do with a PO, and reads back what a LIFF receipt recorded. The sent POs and their
// receivers come from tests/e2e/receiving-scene.ts. Prints JSON on the last line.
//   link <employeeCode> <lineUserId>  both rich menus made once per run; the member's earlier LINE link (left by another
//                                     test) ended first; then linked to that LINE account
//   unlink <employeeCode>             ends the member's LINE link, if there is one (a test's clean-up)
//   outsider <tag>                    a fresh member of the construction department with no role (e2e-lgo-<tag>): no
//                                     gr.post and no po.view on another member's PO
//   receipt <poId>                    the PO's status and its newest receipt: number, the channel its gr.posted Event was
//                                     recorded on, its photos (name, type, size) and its variances, each with the
//                                     approval route it waits on (the DOA rule, its document type, and per task its
//                                     status and the approver whose authority it is: the principal, or the assignee)
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the LIFF receiving scene runs in the e2e database only')

const [command, first = '', second = ''] = process.argv.slice(2)
const org = await prisma.organization.findFirstOrThrow({ where: { code: 'DEMO' }, select: { id: true } })
const ctxOf = (memberId: string) => makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId }, channel: 'WEB', now: systemClock.now() })

async function memberOf(employeeCode: string): Promise<string> {
  if (!/^[a-z0-9_-]{3,60}$/.test(employeeCode)) throw new Error('an employee code of lower-case letters, digits, - and _')
  return (await prisma.member.findUniqueOrThrow({ where: { organizationId_employeeCode: { organizationId: org.id, employeeCode } }, select: { id: true } })).id
}

/** Both rich menus of the demo organization's LINE account, made once per run (the fake LINE server starts empty) */
async function menus(): Promise<void> {
  const stored = await prisma.lineChannelConfig.findFirst({ where: { organizationId: org.id }, select: { richMenuLinkedId: true } })
  if (stored?.richMenuLinkedId) return
  // DEMO by name: other organizations of the run have LINE channels of their own (the twins, tests/e2e/liff-home-scene.ts)
  const run = await runLineRichMenu({ org: 'DEMO' })
  if (!run.ok) throw new Error(`the rich menus were not made: ${run.problem}`)
}

async function unlink(memberId: string): Promise<boolean> {
  const link = await getMyLineLink(ctxOf(memberId))
  if (!link.ok) throw new Error(`no LINE link status: ${link.error.code}`)
  if (!link.data.linked) return false
  const ended = await unlinkMyLine(ctxOf(memberId), {}, { idempotencyKey: randomUUID(), sender: null })
  if (!ended.ok) throw new Error(`not unlinked: ${ended.error.code}`)
  return true
}

async function link(memberId: string, lineUserId: string): Promise<void> {
  if (!/^U[0-9a-f]{32}$/.test(lineUserId)) throw new Error('a LINE user id (U and 32 hexadecimal digits)')
  await menus()
  await unlink(memberId)
  const issued = await issueLineLinkCode(ctxOf(memberId), systemClock.now())
  if (!issued.ok) throw new Error(`no link code: ${issued.error.code}`)
  const answer = await fetch(`${process.env.LINE_API_BASE_URL}/__fake/id-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub: lineUserId, aud: process.env.LINE_LIFF_CHANNEL_ID }),
  })
  const { idToken } = (await answer.json()) as { idToken: string }
  const linked = await linkLineAccount({ code: issued.data.code, idToken }, { sender: null, requestId: randomUUID() })
  // The code is a secret of this test database: only the refusal's code is shown
  if (!linked.ok) throw new Error(`not linked: ${linked.error.code}`)
}

/** A fresh member of the construction department with no role: a stranger to every PO of another member */
async function outsider(tag: string): Promise<{ code: string }> {
  if (!/^[a-z0-9-]{3,40}$/.test(tag)) throw new Error('a tag of lower-case letters, digits and -')
  const password = process.env.SEED_DEV_PASSWORD
  if (!password) throw new Error('SEED_DEV_PASSWORD is needed')
  const code = `e2e-lgo-${tag}`
  const email = `${code}@demo.bcs.local`
  const department = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: 'CON' }, select: { id: true } })
  const userId = await upsertUserWithPassword({ email, name: `ทดสอบ คนนอก ${tag}`, password })
  await prisma.member.upsert({
    where: { organizationId_email: { organizationId: org.id, email } },
    create: { organizationId: org.id, userId, email, displayNameTh: `ทดสอบ คนนอก ${tag}`, employeeCode: code, status: 'ACTIVE', primaryDepartmentId: department.id },
    update: {},
    select: { id: true },
  })
  return { code }
}

/** The approval route a variance waits on: the DOA rule and its document type, and its tasks with their approvers */
async function routeOf(routeId: string | null) {
  if (!routeId) return null
  const route = await prisma.approvalRoute.findUniqueOrThrow({
    where: { id: routeId },
    select: { ruleCode: true, doaVersionId: true, steps: { orderBy: { stepNo: 'asc' }, select: { tasks: { select: { status: true, assigneeMemberId: true, principalMemberId: true } } } } },
  })
  const rule = await prisma.doaRule.findFirst({ where: { organizationId: org.id, doaVersionId: route.doaVersionId, code: route.ruleCode }, select: { documentType: true } })
  const tasks = route.steps.flatMap((s) => s.tasks)
  const members = await prisma.member.findMany({ where: { id: { in: tasks.map((t) => t.principalMemberId ?? t.assigneeMemberId) } }, select: { id: true, employeeCode: true } })
  const codeOf = new Map(members.map((m) => [m.id, m.employeeCode]))
  return { ruleCode: route.ruleCode, documentType: rule?.documentType ?? null, tasks: tasks.map((t) => ({ status: t.status, approver: codeOf.get(t.principalMemberId ?? t.assigneeMemberId) ?? null })) }
}

let result: unknown
switch (command) {
  case 'link':
    await link(await memberOf(first), second)
    result = { linked: true }
    break
  case 'unlink':
    result = { unlinked: await unlink(await memberOf(first)) }
    break
  case 'outsider':
    result = await outsider(first)
    break
  case 'receipt': {
    const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: first, organizationId: org.id }, select: { id: true, status: true } })
    const gr = await prisma.goodsReceipt.findFirst({ where: { poId: po.id }, orderBy: [{ receivedAt: 'desc' }, { number: 'desc' }], select: { id: true, number: true } })
    const posted = gr ? await prisma.event.findFirst({ where: { organizationId: org.id, type: 'gr.posted', aggregateId: gr.id }, select: { channel: true } }) : null
    const links = gr ? await prisma.fileLink.findMany({ where: { subjectType: 'GoodsReceipt', subjectId: gr.id }, select: { kind: true, fileId: true } }) : []
    const files = await prisma.fileObject.findMany({ where: { id: { in: links.map((l) => l.fileId) } }, select: { id: true, fileName: true, mimeType: true, sizeBytes: true } })
    const variances = gr ? await prisma.variance.findMany({ where: { organizationId: org.id, grId: gr.id }, select: { type: true, disposition: true, status: true, quantity: true, currentRouteId: true } }) : []
    const routes = await Promise.all(variances.map((v) => routeOf(v.currentRouteId)))
    result = {
      poStatus: po.status,
      receipt: gr
        ? {
            number: gr.number,
            channel: posted?.channel ?? null,
            photos: files.map((f) => ({ fileName: f.fileName, mimeType: f.mimeType, sizeBytes: f.sizeBytes, kind: links.find((l) => l.fileId === f.id)?.kind ?? null })),
            variances: variances.map((v, i) => ({ type: v.type, disposition: v.disposition, status: v.status, quantity: v.quantity.toString(), route: routes[i] ?? null })),
          }
        : null,
    }
    break
  }
  default:
    throw new Error(`unknown LIFF receiving scene command ${command ?? '(none)'}`)
}
console.log(JSON.stringify(result))
await prisma.$disconnect()
