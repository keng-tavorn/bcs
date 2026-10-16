// S17-09 (FR-PLT-301 AC10, BR-APP-01, BR-APP-02): the BCS Go app is the web of server.url in a WebView whose user agent
// carries "BCSGo/<version>". A request from it records the APP channel on its Events — for audit and KPI only — and
// may do everything the web may: policy decisions (DOA versions, authority changes) included. The domain names the
// app in /.well-known/assetlinks.json once the environment says which app it is.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { getEnv } from '@/lib/env'
import { auth } from '@/server/auth/auth'
import { upsertUserWithPassword } from '@/server/auth/provision'
import { ctxFromSession, resolveSession, type SessionState } from '@/server/auth/session'
import { grantStepUp } from '@/server/auth/step-up'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { importDoaDraft, submitDoaVersion } from '@/server/services/doa'
import { proposeOrgChange } from '@/server/services/org-authority'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { createDraft } from '../support/requests'
import { seedTestPins, TEST_PIN } from '../support/pin'

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const APP_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36 BCSGo/0.1.0'
const BROWSER_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
const PASSWORD = 'requester-password-123456'

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  await seedTestPins(org.organizationId)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

/** Signs the member in through Better Auth's HTTP handler (the path the app's WebView takes) and returns the cookie */
async function signIn(code: string): Promise<string> {
  const m = await prisma.member.findUniqueOrThrow({ where: { id: org.member[code]! } })
  const userId = await upsertUserWithPassword({ email: m.email, name: m.displayNameTh, password: PASSWORD })
  await prisma.member.update({ where: { id: m.id }, data: { userId } })
  const env = getEnv()
  const res = await auth.handler(
    new Request(`${env.BETTER_AUTH_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.APP_URL, 'x-forwarded-for': '203.0.113.71', 'user-agent': APP_UA },
      body: JSON.stringify({ email: m.email, password: PASSWORD }),
    }),
  )
  expect(res.status).toBe(200)
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}

async function taskOf(subjectId: string) {
  return prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId } } } })
}

const ceoStepUp = (subjectType: string, subjectId: string) =>
  grantStepUp({ organizationId: org.organizationId, memberId: org.member.ceo!, subjectType, subjectId, method: 'PIN', pin: TEST_PIN, channel: 'APP' }, new Date(), { sender: null })

describe('[FR-PLT-301/AC10] a request from the BCS Go app records the APP channel (BR-APP-02)', () => {
  it("gives the app's session an APP context, so its Events say APP; the same session in a browser says WEB", async () => {
    const cookie = await signIn('req_con')
    const fromApp = await resolveSession(new Headers({ cookie, 'user-agent': APP_UA }))
    expect(fromApp).toMatchObject({ kind: 'member', client: 'APP' })
    const appCtx = ctxFromSession(fromApp, 'WEB', NOW)
    expect(appCtx?.channel).toBe('APP')
    const fromBrowser = await resolveSession(new Headers({ cookie, 'user-agent': BROWSER_UA }))
    expect(fromBrowser).not.toHaveProperty('client')
    expect(ctxFromSession(fromBrowser, 'WEB', NOW)?.channel).toBe('WEB')

    const line = { description: 'ปูนซีเมนต์', quantity: '2', uom: 'ถุง', unitPrice: '150.00' }
    const inApp = await createDraft(appCtx!, { requestTypeCode: 'BUY_GOODS', title: 'ปูนจากแอป', priceIncludesVat: true, lines: [line] }, key())
    const inBrowser = await createDraft(ctxFromSession(fromBrowser, 'WEB', NOW)!, { requestTypeCode: 'BUY_GOODS', title: 'ปูนจากเว็บ', priceIncludesVat: true, lines: [line] }, key())
    if (!inApp.ok || !inBrowser.ok) throw new Error('draft failed')
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: inApp.data.requestId, type: 'request.drafted' } })).toMatchObject({ channel: 'APP' })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: inBrowser.data.requestId, type: 'request.drafted' } })).toMatchObject({ channel: 'WEB' })
  })

  it('records APP for the web only: a LIFF page stays LIFF, and a member who must still set up 2FA gets no context', () => {
    const member: SessionState = {
      kind: 'member',
      userId: 'u',
      sessionId: 's',
      client: 'APP',
      member: { id: org.member.req_con!, organizationId: org.organizationId, organizationName: 'x', organizationKind: 'PRODUCTION', displayNameTh: 'x', displayNameEn: null, email: 'x@example.com' },
      roles: [],
    }
    expect(ctxFromSession(member, 'LIFF', NOW)?.channel).toBe('LIFF')
    expect(ctxFromSession({ ...member, kind: 'needs-2fa-setup' }, 'WEB', NOW)).toBeNull()
  })
})

describe('[FR-PLT-301/AC10] policy is decided in the app as on the web (BR-APP-02, BR-DOA-15)', () => {
  it('approves an authority change in the app with the PIN typed there; the task and its Event say APP', async () => {
    const proposed = await proposeOrgChange(
      org.ctxOf('admin', NOW),
      { kind: 'POSITION_ASSIGN', payload: { positionCode: 'VP', departmentId: org.department.SUP!, memberId: org.member.dm_fin! }, effectiveFrom: '2026-10-25T01:00:00Z', reason: 'แต่งตั้งตามคำสั่งบริษัท' },
      key(),
    )
    if (!proposed.ok) throw new Error('propose failed')
    const task = await taskOf(proposed.data.changeId)
    expect(await ceoStepUp('ORG_AUTHORITY_CHANGE', proposed.data.changeId)).toMatchObject({ ok: true })
    expect(await decideTask(org.ctxOf('ceo', NOW, 'APP'), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'SCHEDULED' } })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'APPROVED', channel: 'APP' })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: task.id, type: 'approval_task.decided' } })).toMatchObject({ channel: 'APP' })
  })

  it('publishes a DOA version approved in the app', async () => {
    const fixture = readFileSync(path.resolve(import.meta.dirname, '../golden/fixtures/doa-versions.yaml'), 'utf8')
    const yaml = `versions:\n${fixture.slice(fixture.indexOf('  - code: DOA-DEMO\n    version: 2')).replace('version: 2', 'version: 31')}`
    const imported = await importDoaDraft(org.ctxOf('admin', NOW), { yaml }, key())
    if (!imported.ok) throw new Error('import failed')
    const versionId = imported.data.versionIds[0]!
    expect(await submitDoaVersion(org.ctxOf('admin', NOW), { versionId, boundaryTableConfirmed: true }, key())).toMatchObject({ ok: true })
    const task = await taskOf(versionId)
    await ceoStepUp('DOA_VERSION', versionId)
    expect(await decideTask(org.ctxOf('ceo', NOW, 'APP'), { taskId: task.id, decision: 'APPROVE', boundaryTableConfirmed: true }, key())).toMatchObject({ ok: true, data: { documentStatus: 'PUBLISHED' } })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: task.id, type: 'approval_task.decided' } })).toMatchObject({ channel: 'APP' })
  })

  it('still refuses policy from a chat button', async () => {
    const proposed = await proposeOrgChange(
      org.ctxOf('admin', NOW),
      { kind: 'POSITION_ASSIGN', payload: { positionCode: 'VP', departmentId: org.department.SUP!, memberId: org.member.dm_it! }, effectiveFrom: '2026-10-26T01:00:00Z', reason: 'แต่งตั้งตามคำสั่งบริษัท' },
      key(),
    )
    if (!proposed.ok) throw new Error('propose failed')
    const task = await taskOf(proposed.data.changeId)
    await ceoStepUp('ORG_AUTHORITY_CHANGE', proposed.data.changeId)
    expect(await decideTask(org.ctxOf('ceo', NOW, 'LINE_CHAT'), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'CHANNEL' } } })
  })
})

describe('[FR-PLT-301/AC10] /.well-known/assetlinks.json answers from the environment (ADR-166)', () => {
  const CERT = Array.from({ length: 32 }, (_, i) => (i * 7 + 16).toString(16).toUpperCase()).join(':')
  const route = async () => (await import('@/app/.well-known/assetlinks.json/route')).GET()

  it('is 404 while the environment names no app', async () => {
    vi.stubEnv('BCS_GO_ANDROID_PACKAGE', '')
    vi.stubEnv('BCS_GO_ANDROID_CERT_SHA256', '')
    vi.resetModules()
    expect((await route()).status).toBe(404)
    vi.stubEnv('BCS_GO_ANDROID_PACKAGE', 'th.bcs.go')
    vi.resetModules()
    expect((await route()).status).toBe(404)
  })

  it('names the package and the certificate once both are set', async () => {
    vi.stubEnv('BCS_GO_ANDROID_PACKAGE', 'th.bcs.go')
    vi.stubEnv('BCS_GO_ANDROID_CERT_SHA256', CERT.toLowerCase())
    vi.resetModules()
    const res = await route()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(await res.json()).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
        target: { namespace: 'android_app', package_name: 'th.bcs.go', sha256_cert_fingerprints: [CERT] },
      },
    ])
  })
})
