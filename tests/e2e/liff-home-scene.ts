import { randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { getEnv } from '@/lib/env'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { deriveSeedBackupCodes, deriveSeedTotpSecret } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { homeApprovals, homeFollowing, homeTodo } from '@/server/services/home'
import { grantRole } from '@/server/services/members/roles'
import { runLineRichMenu } from '../../scripts/line-richmenu'
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
//   worker <tag> <lineUserId>             S17-04 (FR-LINE-303 AC3 AC4): a fresh member of the demo organization's
//                                         construction department (e2e-lw-<tag>), RECEIVER and PROCUREMENT through the
//                                         members service (with TOTP, as the seeded roles), linked to that LINE account after
//                                         the menus of every set exist (made by pnpm line:richmenu's command once per run),
//                                         so the link gives them the set LINKED:RECEIVER:PROCUREMENT
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

async function worker() {
  const [tag, lineUserId] = [orgCode, code]
  if (!/^[a-z0-9-]{3,40}$/.test(tag)) throw new Error('the worker needs a tag of lower-case letters, digits and -')
  const org = await prisma.organization.findFirstOrThrow({ where: { code: 'DEMO' }, select: { id: true } })
  const con = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: 'CON' }, select: { id: true } })
  const admin = await prisma.member.findFirstOrThrow({ where: { organizationId: org.id, employeeCode: 'admin' }, select: { id: true } })
  const employeeCode = `e2e-lw-${tag}`
  const email = `${employeeCode}@demo.bcs.local`
  const nameTh = `ทดสอบ เมนู ${tag}`
  const userId = await upsertUserWithPassword({ email, name: nameTh, password: process.env.SEED_DEV_PASSWORD! })
  const member = await prisma.member.upsert({
    where: { organizationId_email: { organizationId: org.id, email } },
    create: { organizationId: org.id, userId, email, displayNameTh: nameTh, employeeCode, status: 'ACTIVE', primaryDepartmentId: con.id },
    update: {},
    select: { id: true },
  })
  const adminCtx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: admin.id }, channel: 'WEB', now: systemClock.now() })
  for (const role of ['RECEIVER', 'PROCUREMENT'] as const) {
    const granted = await grantRole(adminCtx, { memberId: member.id, role }, { idempotencyKey: randomUUID(), sender: null })
    if (!granted.ok) throw new Error(`grant ${role}: ${granted.error.code}`)
  }
  await enableTotpWithSecret(userId, deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, employeeCode), deriveSeedBackupCodes(process.env.SEED_TOTP_KEY!, employeeCode))
  // Every set made once per run (the fake LINE server starts empty), as tests/e2e/liff-scene.ts makes the DEMO menus
  if ((await prisma.lineRichMenuVariant.count({ where: { organizationId: org.id } })) === 0) {
    const run = await runLineRichMenu({ org: 'DEMO' })
    // Another scene of the run may have made them at the same moment (its run wins, this one's CONFLICT_VERSION)
    if (!run.ok && (await prisma.lineRichMenuVariant.count({ where: { organizationId: org.id } })) === 0) throw new Error(`the rich menus were not made: ${run.problem}`)
  }
  const now = systemClock.now()
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
  const set = await prisma.lineRichMenuVariant.findFirstOrThrow({ where: { organizationId: org.id, variantKey: 'LINKED:RECEIVER:PROCUREMENT' }, select: { richMenuId: true } })
  return { memberId: member.id, employeeCode, richMenuId: set.richMenuId }
}

const result = mode === 'link' ? await link() : mode === 'home' ? await home() : mode === 'worker' ? await worker() : null
if (result === null) throw new Error(`unknown mode ${mode}`)
console.log(JSON.stringify(result))
await prisma.$disconnect()
