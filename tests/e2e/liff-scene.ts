import { randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { MS_PER_MINUTE } from '@/lib/constants'
import { deriveSeedTotpSecret } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { LINE_LINK_CODE_TTL_MS } from '@/server/line/link-code'
import { issueLineLinkCode, linkLineAccount, unlinkMyLine } from '@/server/services/line-link'
import { runLineRichMenu } from '../../scripts/line-richmenu'
import { E2E_DB } from '../support/e2e-env'

// Run by the LIFF e2e specs (tests/e2e/liff-*.spec.ts, through liff-support.ts) against the e2e database only: builds what
// a LIFF test needs through the services, as the workspace would, and prints it as JSON on the last line.
//   code <tag>                  both rich menus made (pnpm line:richmenu), a fresh member, a link code issued for them now
//   expired <tag>               a fresh member and a link code issued longer ago than a code lasts
//   used <tag> <lineUserId>     a fresh member and a link code already spent with that LINE account
//   two-factor <tag>            both rich menus made, a fresh member who signs in with a password and TOTP
//   linked <tag> <lineUserId>   both rich menus made, a fresh member linked to that LINE account; and the administrators
//   relink <tag> <lineUserId>   the member of `linked <tag>` unlinks on the web (/settings/line: command line.unlink on
//                               channel WEB), then links that other LINE account with a new code (a QR from the new phone)
//   plain <tag>                 a fresh member who signs in with a password only
// A fresh member (employee code e2e-liff-<tag>, a plain requester of the demo organization that no other test touches)
// keeps every LIFF test apart from the rest. Link codes are short-lived secrets of this test database only.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the LIFF scene runs in the e2e database only')

const [command, tag = '', lineUserId = ''] = process.argv.slice(2)
if (!/^[a-z0-9-]{3,40}$/.test(tag) && command !== 'admins') throw new Error('the scene needs a tag of lower-case letters, digits and -')
const password = process.env.SEED_DEV_PASSWORD
if (!password) throw new Error('SEED_DEV_PASSWORD is needed')

const org = await prisma.organization.findFirstOrThrow({ where: { code: 'DEMO' }, select: { id: true, displayName: true, legalNameTh: true } })

/** Both rich menus of the demo organization's LINE account, made once per run (the fake LINE server starts empty) */
async function menus(): Promise<string> {
  const stored = await prisma.lineChannelConfig.findFirst({ where: { organizationId: org.id }, select: { richMenuLinkedId: true } })
  if (stored?.richMenuLinkedId) return stored.richMenuLinkedId
  const run = await runLineRichMenu({ org: null })
  if (!run.ok) throw new Error(`the rich menus were not made: ${run.problem}`)
  return run.report.linkedId
}

async function freshMember(options: { totp?: boolean } = {}) {
  const employeeCode = `e2e-liff-${tag}`
  const email = `${employeeCode}@demo.bcs.local`
  const nameTh = `ทดสอบ ไลฟ์ ${tag}`
  const nameEn = `LIFF Test ${tag}`
  const department = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: 'CON' }, select: { id: true } })
  const userId = await upsertUserWithPassword({ email, name: nameTh, password: password! })
  const member = await prisma.member.upsert({
    where: { organizationId_email: { organizationId: org.id, email } },
    create: { organizationId: org.id, userId, email, displayNameTh: nameTh, displayNameEn: nameEn, employeeCode, status: 'ACTIVE', primaryDepartmentId: department.id },
    update: {},
    select: { id: true },
  })
  if (options.totp) await enableTotpWithSecret(userId, deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, employeeCode), [])
  return { id: member.id, email, employeeCode, nameTh, nameEn, organizationName: org.displayName ?? org.legalNameTh }
}

async function codeFor(memberId: string, issuedAt: Date): Promise<string> {
  const ctx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId }, channel: 'WEB', now: issuedAt })
  const issued = await issueLineLinkCode(ctx, issuedAt)
  if (!issued.ok) throw new Error(`no link code: ${issued.error.code} ${JSON.stringify(issued.error.details ?? {})}`)
  return issued.data.code
}

/** Spends a code as the LIFF page does, with an ID token the fake LINE server issued for that LINE user */
async function spend(code: string, forLineUser: string): Promise<void> {
  const answer = await fetch(`${process.env.LINE_API_BASE_URL}/__fake/id-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub: forLineUser, aud: process.env.LINE_LIFF_CHANNEL_ID }),
  })
  const { idToken } = (await answer.json()) as { idToken: string }
  const linked = await linkLineAccount({ code, idToken }, { sender: null, requestId: randomUUID() })
  if (!linked.ok) throw new Error(`not linked: ${linked.error.code} ${JSON.stringify(linked.error.details ?? {})}`)
}

async function administrators(): Promise<string[]> {
  const admins = await prisma.member.findMany({
    where: { organizationId: org.id, status: 'ACTIVE', roleAssignments: { some: { role: 'ORG_ADMIN', revokedAt: null } } },
    select: { displayNameTh: true },
  })
  return admins.map((a) => a.displayNameTh)
}

const needLineUser = () => {
  if (!/^U[0-9a-f]{32}$/.test(lineUserId)) throw new Error('the scene needs a LINE user id (U and 32 hexadecimal digits)')
  return lineUserId
}

let result: unknown
switch (command) {
  case 'code': {
    const linkedMenuId = await menus()
    const member = await freshMember()
    result = { member, code: await codeFor(member.id, systemClock.now()), linkedMenuId }
    break
  }
  case 'expired': {
    const member = await freshMember()
    const longAgo = new Date(systemClock.now().getTime() - LINE_LINK_CODE_TTL_MS - MS_PER_MINUTE)
    result = { member, code: await codeFor(member.id, longAgo) }
    break
  }
  case 'used': {
    const member = await freshMember()
    const code = await codeFor(member.id, systemClock.now())
    await spend(code, needLineUser())
    result = { member, code }
    break
  }
  case 'two-factor': {
    const linkedMenuId = await menus()
    result = { member: await freshMember({ totp: true }), linkedMenuId }
    break
  }
  case 'linked': {
    const linkedMenuId = await menus()
    const member = await freshMember()
    await spend(await codeFor(member.id, systemClock.now()), needLineUser())
    result = { member, linkedMenuId, admins: await administrators() }
    break
  }
  case 'relink': {
    const member = await prisma.member.findUniqueOrThrow({ where: { organizationId_employeeCode: { organizationId: org.id, employeeCode: `e2e-liff-${tag}` } }, select: { id: true } })
    const web = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now: systemClock.now() })
    const ended = await unlinkMyLine(web, {}, { idempotencyKey: randomUUID(), sender: null })
    if (!ended.ok) throw new Error(`not unlinked: ${ended.error.code}`)
    await spend(await codeFor(member.id, systemClock.now()), needLineUser())
    result = { relinked: true }
    break
  }
  case 'plain':
    result = { member: await freshMember(), admins: await administrators() }
    break
  case 'admins':
    result = { admins: await administrators() }
    break
  default:
    throw new Error(`unknown LIFF scene command ${command ?? '(none)'}`)
}
console.log(JSON.stringify(result))
await prisma.$disconnect()
