import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { canViewPo } from '@/app/(workspace)/procurement/pos/_parts/access'
import { canViewRequest } from '@/app/(workspace)/_tracking/access'
import { API_RATE_LIMIT_PER_WINDOW, SEARCH_GROUP_LIMIT } from '@/lib/constants'
import { loadPrincipal, type Principal } from '@/server/authz'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { getPoAccess } from '@/server/queries/purchase-orders'
import { getRequestAccess } from '@/server/queries/requests'
import type { SearchDocumentDto } from '@/server/queries/search'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization } from '@/server/seed/demo-org'
import { seedBudget } from '@/server/seed/budget'
import { seedDevPins } from '@/server/seed/pins'
import { parseOrgStructureInput, seedOrgStructure } from '@/server/seed/org-structure'
import { parseBudget, parseDemoHistory, parseSites, parseSuppliers } from '@/server/seed/sheets'
import { seedSuppliers } from '@/server/seed/suppliers'
import { seedTaxRates } from '@/server/seed/tax-rates'
import { loadInputWorkbook } from '@/server/seed/workbook'
import { seedDemoHistory } from '@/server/services/demo-history'
import { countSearch, searchForMember } from '@/server/services/search'
import { supplierAccess } from '@/server/services/suppliers/access'

// S16-03 · the ⌘K search (FR-PLT-014) on the organization `pnpm db:seed` makes — every user of sheet Users, the
// suppliers, and the requests, POs and receipts of Demo_History made through the real services. What each member may
// see is counted here, document by document, with the checks the pages themselves ask (canViewRequest, canViewPo with
// getRequestAccess and getPoAccess), never with the scope the search builds; the search must find exactly that by
// number and nothing more. The organization is seeded under its own code and addresses so it never meets the others.

const NOW = new Date('2026-09-28T03:00:00Z')
const ORG_CODE = 'SEARCH-SCOPE'
const PASSWORD = 'search-test-password-0001'
const TOTP_KEY = 'search-test-totp-key-0000000000001'
const PIN = '739164'
const P95 = 0.95
/** NFR-PERF-02: reads p95 within 300 ms */
const P95_MS = 300
const TIMED_SEARCHES = 40

interface Member {
  readonly id: string
  readonly code: string
  readonly principal: Principal
  readonly ctx: Ctx
}

let organizationId: string
let members: Member[]
let requests: Array<{ id: string; number: string | null; title: string; status: string; requesterMemberId: string }>
let pos: Array<{ id: string; number: string | null }>
let grs: Array<{ id: string; number: string | null; poId: string }>
let suppliers: Array<{ id: string; taxId: string | null; isForeign: boolean }>
/** Per member: what the pages let them open */
const canSee = new Map<string, { requests: Set<string>; pos: Set<string> }>()

const ctxAt = (memberId: string, now = NOW): Ctx => makeCtx({ organizationId, actor: { type: 'USER', memberId }, channel: 'WEB', now })

async function search(member: Member, q: string) {
  const found = await searchForMember(member.ctx, q)
  if (!found.ok) throw new Error(`search refused ${member.code}: ${found.error.code}`)
  return found.data
}

/** Every document in the answer is one the member may open (a GR through its PO, a draft only its requester's) */
function expectInScope(member: Member, docs: readonly SearchDocumentDto[], label: string) {
  const sees = canSee.get(member.id)!
  for (const d of docs) {
    if (d.kind === 'REQUEST') expect(sees.requests.has(d.id), `${label}: ${member.code} found request ${d.number ?? d.title}`).toBe(true)
    if (d.kind === 'PURCHASE_ORDER') expect(sees.pos.has(d.id), `${label}: ${member.code} found PO ${d.number}`).toBe(true)
    if (d.kind === 'GOODS_RECEIPT') {
      const gr = grs.find((g) => g.id === d.id)!
      expect(sees.pos.has(gr.poId), `${label}: ${member.code} found GR ${d.number}`).toBe(true)
    }
  }
}

beforeAll(async () => {
  execSync('pnpm exec tsx scripts/storage-init.ts', { stdio: 'ignore' })
  const workbook = await loadInputWorkbook()
  await seedTaxRates()
  const input = parseDemoOrgInput(workbook, loadOrgSettingsYaml())
  const users = input.users.map((u) => ({ ...u, email: `search.${u.email}` }))
  const org = await seedDemoOrganization({ ...input, org: { ...input.org, code: ORG_CODE }, users }, { password: PASSWORD, totpKey: TOTP_KEY, now: NOW })
  organizationId = org.organizationId
  await seedOrgStructure(organizationId, users, parseOrgStructureInput(workbook), NOW)
  await seedBudget(organizationId, parseBudget(workbook), NOW)
  await seedSuppliers(organizationId, { suppliers: parseSuppliers(workbook), sites: parseSites(workbook) }, NOW)
  await seedDevPins(organizationId, PIN, NOW)
  await seedDemoHistory(organizationId, parseDemoHistory(workbook), NOW, { pin: PIN })

  const db = forTenant(organizationId)
  const rows = await db.member.findMany({ where: { status: 'ACTIVE' }, select: { id: true, employeeCode: true }, orderBy: { employeeCode: 'asc' } })
  members = await Promise.all(
    rows.map(async (m) => {
      const ctx = ctxAt(m.id)
      return { id: m.id, code: m.employeeCode ?? m.id, ctx, principal: await db.$transaction((tx) => loadPrincipal(tx, ctx)) }
    })
  )
  requests = await db.request.findMany({ select: { id: true, number: true, title: true, status: true, requesterMemberId: true } })
  pos = await db.purchaseOrder.findMany({ select: { id: true, number: true } })
  grs = await db.goodsReceipt.findMany({ where: { status: { not: 'DRAFT' } }, select: { id: true, number: true, poId: true } })
  suppliers = await db.supplier.findMany({ select: { id: true, taxId: true, isForeign: true } })
  const requestAccess = await Promise.all(requests.map((r) => getRequestAccess(ctxAt(members[0]!.id), r.id)))
  const poAccess = await Promise.all(pos.map((p) => getPoAccess(ctxAt(members[0]!.id), p.id)))
  for (const m of members) {
    canSee.set(m.id, {
      requests: new Set(requests.filter((r, i) => canViewRequest(m.principal, requestAccess[i]!) && (r.status !== 'DRAFT' || r.requesterMemberId === m.id)).map((r) => r.id)),
      pos: new Set(pos.filter((_, i) => canViewPo(m.principal, poAccess[i]!)).map((p) => p.id)),
    })
  }
}, 900_000)

describe('[FR-PLT-014/AC2] the search finds only what each seed member may see', () => {
  it('has members of every role and scope to try: requesters, department heads and every organization-wide role', () => {
    const roles = new Set(members.flatMap((m) => (m.principal.kind === 'member' ? [...m.principal.roles] : [])))
    for (const role of ['PROCUREMENT', 'FINANCE', 'EXECUTIVE', 'AUDITOR', 'ORG_ADMIN', 'RECEIVER']) expect(roles, role).toContain(role)
    expect(members.some((m) => m.principal.kind === 'member' && m.principal.headOfDepartmentIds.size > 0)).toBe(true)
    expect(members.some((m) => m.principal.kind === 'member' && m.principal.roles.size === 0)).toBe(true)
    expect(requests.filter((r) => r.number).length).toBeGreaterThan(SEARCH_GROUP_LIMIT)
    expect(pos.filter((p) => p.number).length).toBeGreaterThan(0)
    expect(grs.length).toBeGreaterThan(0)
  })

  it('finds every PR, PO and GR by its whole number exactly when the member may open it — for every member', async () => {
    const someoneMissed: string[] = []
    for (const m of members) {
      const sees = canSee.get(m.id)!
      // Some members see none of a kind: the counts differ from member to member, or the test proves nothing
      for (const r of requests.filter((x) => x.number)) {
        const found = await search(m, r.number!)
        expectInScope(m, found.documents, r.number!)
        expect(found.documents.some((d) => d.id === r.id), `${m.code} · ${r.number}`).toBe(sees.requests.has(r.id))
      }
      for (const p of pos.filter((x) => x.number)) {
        const found = await search(m, p.number!)
        expectInScope(m, found.documents, p.number!)
        expect(found.documents.some((d) => d.id === p.id), `${m.code} · ${p.number}`).toBe(sees.pos.has(p.id))
      }
      for (const g of grs.filter((x) => x.number)) {
        const found = await search(m, g.number!)
        expectInScope(m, found.documents, g.number!)
        expect(found.documents.some((d) => d.id === g.id), `${m.code} · ${g.number}`).toBe(sees.pos.has(g.poId))
      }
      if (sees.requests.size < requests.length) someoneMissed.push(m.code)
    }
    // The seed has members who may not see every request: otherwise the refusals above were never tried
    expect(someoneMissed.length).toBeGreaterThan(0)
    expect(new Set(members.map((m) => canSee.get(m.id)!.requests.size)).size).toBeGreaterThan(2)
  }, 900_000)

  it('finds requests by title, and recent documents, only in scope', async () => {
    for (const m of members) {
      for (const r of requests) {
        const found = await search(m, r.title)
        expectInScope(m, found.documents, r.title)
        if (canSee.get(m.id)!.requests.has(r.id)) expect(found.documents.length, `${m.code} · ${r.title}`).toBeGreaterThan(0)
      }
      const recent = await searchForMember(m.ctx, '')
      if (!recent.ok) throw new Error('recent refused')
      expectInScope(m, recent.data.recent, 'recent')
      expect(recent.data.recent.length).toBeLessThanOrEqual(SEARCH_GROUP_LIMIT)
    }
  }, 900_000)

  it('finds a supplier by tax id only for a member who sees the whole register; an individual masked by BR-AUTH-04 only by all 13 digits', async () => {
    for (const m of members) {
      const access = supplierAccess(m.principal)
      for (const s of suppliers.filter((x) => x.taxId)) {
        const whole = await search(m, s.taxId!)
        const part = await search(m, s.taxId!.slice(2, 9))
        for (const found of [whole, part]) for (const row of found.suppliers) expect(Object.keys(row).sort()).toEqual(['code', 'href', 'id', 'nameEn', 'nameTh', 'status'])
        const individual = !s.isForeign && !s.taxId!.startsWith('0')
        expect(whole.suppliers.some((x) => x.id === s.id), `${m.code} whole ${s.taxId}`).toBe(access?.level === 'FULL')
        if (access?.level !== 'FULL') expect(part.suppliers.some((x) => x.id === s.id), `${m.code} part ${s.taxId}`).toBe(false)
        if (access?.maskIndividualTaxIds && individual) expect(part.suppliers.some((x) => x.id === s.id), `${m.code} part of an individual`).toBe(false)
      }
    }
  }, 900_000)
})

describe('[FR-PLT-014/AC3] part of a number, at least two characters, % and _ taken as written, five per group', () => {
  it('finds a document by part of its number (the running number alone, or the whole PR-yyyy-nnnn)', async () => {
    const executive = members.find((m) => m.principal.kind === 'member' && m.principal.roles.has('EXECUTIVE'))!
    const numbered = requests.filter((r) => r.number)
    for (const r of numbered.slice(0, 5)) {
      const tail = r.number!.slice(-5)
      const found = await search(executive, tail)
      expect(found.documents.some((d) => d.number?.includes(tail)), tail).toBe(true)
    }
    const prefix = await search(executive, numbered[0]!.number!.slice(0, 7))
    expect(prefix.documents.length).toBe(SEARCH_GROUP_LIMIT)
  })

  it('does not search under two characters (the recent documents show instead) and escapes % and _ (NEW-61)', async () => {
    const executive = members.find((m) => m.principal.kind === 'member' && m.principal.roles.has('EXECUTIVE'))!
    const one = await search(executive, numbered(0).slice(0, 1))
    expect(one.documents).toEqual([])
    expect(one.suppliers).toEqual([])
    for (const q of ['%%', '__', '%_', ' % ']) {
      const found = await search(executive, q)
      expect(found.documents, q).toEqual([])
      expect(found.suppliers, q).toEqual([])
    }
  })
})

const numbered = (i: number) => requests.filter((r) => r.number)[i]!.number!

describe('[FR-PLT-014/AC5] /api/search reads only, is rate limited, and answers within 300 ms p95', () => {
  it('writes no Event', async () => {
    const before = await prisma.event.count({ where: { organizationId } })
    for (const m of members) {
      await search(m, numbered(0))
      await searchForMember(m.ctx, '')
    }
    expect(await prisma.event.count({ where: { organizationId } })).toBe(before)
  })

  it('allows 60 searches a minute per member, then answers RATE_LIMITED until the minute ends (NFR-SEC-05)', async () => {
    const m = members[0]!
    const at = new Date('2026-09-28T05:00:00Z')
    const ctx = ctxAt(m.id, at)
    for (let i = 0; i < API_RATE_LIMIT_PER_WINDOW; i++) expect((await countSearch(ctx)).ok).toBe(true)
    const refused = await countSearch(ctx)
    expect(refused.ok ? null : refused.error.code).toBe('RATE_LIMITED')
    // Another member is counted apart, and the next minute starts again
    expect((await countSearch(ctxAt(members[1]!.id, at))).ok).toBe(true)
    expect((await countSearch(ctxAt(m.id, new Date(at.getTime() + 61_000)))).ok).toBe(true)
  })

  it('answers within 300 ms at p95 on the seed with Demo_History (NFR-PERF-02)', async () => {
    const requester = members.find((m) => m.principal.kind === 'member' && m.principal.roles.size === 0)!
    const executive = members.find((m) => m.principal.kind === 'member' && m.principal.roles.has('EXECUTIVE'))!
    await search(requester, numbered(0))
    const times: number[] = []
    for (let i = 0; i < TIMED_SEARCHES; i++) {
      const who = i % 2 ? requester : executive
      const started = performance.now()
      await searchForMember(who.ctx, i % 4 < 2 ? numbered(i % 5).slice(-5) : 'บริษัท')
      times.push(performance.now() - started)
    }
    times.sort((a, b) => a - b)
    expect(times[Math.ceil(times.length * P95) - 1]).toBeLessThanOrEqual(P95_MS)
  })
})

describe('[FR-PLT-014/AC1] "ล่าสุด" keeps the other documents when one has many events (a draft saved again and again)', () => {
  it('lists the documents the member acted on, each once, newest first, after 60 more events on one of them', async () => {
    // A member whose recent list holds more than one document
    let member: Member | undefined
    let before: readonly SearchDocumentDto[] = []
    for (const m of members) {
      const recent = await searchForMember(m.ctx, '')
      if (recent.ok && recent.data.recent.length >= 3) {
        member = m
        before = recent.data.recent
        break
      }
    }
    expect(member, 'a seed member with three recent documents').toBeDefined()
    const flooded = before[before.length - 1]!
    // The events autosave writes on a draft, here on the oldest of them (Event is append-only: inserting is all it allows)
    const correlationId = randomUUID()
    await prisma.event.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        organizationId,
        type: 'request.drafted',
        aggregateType: flooded.kind === 'REQUEST' ? 'Request' : flooded.kind === 'PURCHASE_ORDER' ? 'PurchaseOrder' : 'GoodsReceipt',
        aggregateId: flooded.id,
        occurredAt: new Date(NOW.getTime() + i * 1000),
        actorType: 'USER' as const,
        actorMemberId: member!.id,
        channel: 'WEB' as const,
        correlationId,
        requestId: `search-flood-${i}`,
        data: {},
        schemaVersion: 1,
      })),
    })
    const after = await searchForMember(member!.ctx, '')
    if (!after.ok) throw new Error('recent refused')
    const ids = after.data.recent.map((d) => d.id)
    expect(ids[0]).toBe(flooded.id)
    expect(new Set(ids).size).toBe(ids.length)
    // Every other document is still there, in the same order
    expect(ids.slice(1)).toEqual(before.filter((d) => d.id !== flooded.id).map((d) => d.id).slice(0, SEARCH_GROUP_LIMIT - 1))
  })
})

describe('[FR-PLT-014/AC3] the whole number finds its document though newer ones hold it too', () => {
  it('ranks the request whose number was typed first, when more than five newer requests quote that number in their title', async () => {
    const executive = members.find((m) => m.principal.kind === 'member' && m.principal.roles.has('EXECUTIVE'))!
    const db = forTenant(organizationId)
    const numbered = await db.request.findMany({ where: { number: { not: null } }, select: { id: true, number: true }, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }] })
    const oldest = numbered[0]!
    const quoting = numbered.slice(1, SEARCH_GROUP_LIMIT + 2)
    expect(quoting.length).toBeGreaterThan(SEARCH_GROUP_LIMIT)
    // Newer requests that quote the old number (a request set up after it, say) crowd its group
    for (const [i, r] of quoting.entries()) await db.request.update({ where: { id: r.id }, data: { title: `ต่อจาก ${oldest.number!} ${i}`, updatedAt: new Date(NOW.getTime() + (i + 1) * 60_000) } })
    const found = await search(executive, oldest.number!)
    expect(found.documents[0]?.id).toBe(oldest.id)
    expect(found.documents.length).toBeLessThanOrEqual(SEARCH_GROUP_LIMIT)
  })
})
