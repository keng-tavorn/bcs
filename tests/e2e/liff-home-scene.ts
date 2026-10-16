import { randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { getEnv } from '@/lib/env'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { homeApprovals, homeFollowing, homeTodo } from '@/server/services/home'
import { seedLineChannel } from '@/server/services/line-channel'
import { issueLineLinkCode, linkLineAccount } from '@/server/services/line-link'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/liff-home.spec.ts (S17-02 · FR-LINE-302) against the e2e database only, on an organization another
// scene built (tests/e2e/review-step-scene.ts: pm_p07's contract work waiting for the DM of LEG, QSE and FIN at once):
//   link <org code> <code> <lineUserId>   the organization's LINE channel saved when it has none (the run's fake LINE),
//                                         and its member <code> (employee code ending _<code>) linked to that LINE account
//                                         as the LIFF link page does: a code issued on the web, spent with an ID token
//   home <org code> <code>                what the web home's services give that member now: the numbers /liff/home must
//                                         show (AC1)
// Prints JSON on the last line.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the LIFF home scene runs in the e2e database only')

const [mode, orgCode = '', code = '', lineUserId = ''] = process.argv.slice(2)

async function memberOf(orgCodeArg: string, codeArg: string) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { code: orgCodeArg }, select: { id: true } })
  const member = await prisma.member.findFirstOrThrow({ where: { organizationId: org.id, employeeCode: { endsWith: `_${codeArg}` } }, select: { id: true } })
  return { organizationId: org.id, memberId: member.id }
}

async function link() {
  const { organizationId, memberId } = await memberOf(orgCode, code)
  const now = systemClock.now()
  if (!(await prisma.lineChannelConfig.findFirst({ where: { organizationId }, select: { id: true } }))) {
    const line = await seedLineChannel(organizationId, getEnv(), now)
    if (line.status !== 'CREATED') throw new Error(`the LINE channel was not saved: ${line.status}`)
  }
  const issued = await issueLineLinkCode(makeCtx({ organizationId, actor: { type: 'USER', memberId }, channel: 'WEB', now }), now)
  if (!issued.ok) throw new Error(`no link code: ${issued.error.code}`)
  const answer = await fetch(`${process.env.LINE_API_BASE_URL}/__fake/id-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub: lineUserId, aud: process.env.LINE_LIFF_CHANNEL_ID }),
  })
  const { idToken } = (await answer.json()) as { idToken: string }
  const linked = await linkLineAccount({ code: issued.data.code, idToken }, { sender: null, requestId: randomUUID() })
  if (!linked.ok) throw new Error(`not linked: ${linked.error.code}`)
  return { memberId }
}

async function home() {
  const { organizationId, memberId } = await memberOf(orgCode, code)
  const ctx = makeCtx({ organizationId, actor: { type: 'USER', memberId }, channel: 'WEB', now: systemClock.now() })
  const [todo, approvals, following] = await Promise.all([homeTodo(ctx), homeApprovals(ctx), homeFollowing(ctx)])
  if (!todo.ok || !approvals.ok || !following.ok) throw new Error('the home services refused')
  return {
    todo: todo.data.rows.map((r) => ({ key: r.key, count: r.count })),
    approvals: { all: approvals.data.all.count, overdue: approvals.data.overdue.count, info: approvals.data.info.count, taskIds: approvals.data.all.rows.map((t) => t.id) },
    following: { total: following.data.total, open: following.data.open },
  }
}

const result = mode === 'link' ? await link() : mode === 'home' ? await home() : null
if (result === null) throw new Error(`unknown mode ${mode}`)
console.log(JSON.stringify(result))
await prisma.$disconnect()
