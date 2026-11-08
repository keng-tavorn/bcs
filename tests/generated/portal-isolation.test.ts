import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { portalCtx } from '@/server/portal/session'
import type { Ctx } from '@/server/context'

// INV-SUP-01 (BR-PORTAL ข้อ 05), generated from the code: every export of src/server/portal/queries*.ts (S7's file and
// the queries-<step>.ts of S10 S11) is called as the contact of supplier A, of supplier B, of application A and of
// application B — and none of them may return a row, an id or a name of another. A new query file or export is picked
// up without a line here.

const PORTAL_DIR = path.resolve(import.meta.dirname, '..', '..', 'src', 'server', 'portal')
const QUERY_FILES = readdirSync(PORTAL_DIR).filter((f) => /^queries(-[a-z0-9-]+)?\.ts$/.test(f))

interface Party {
  readonly label: string
  readonly ctx: Ctx
  /** What only this party may see: ids and names */
  readonly marks: readonly string[]
}

const NOW = new Date('2026-11-07T03:00:00Z')
const parties: Party[] = []

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { code: `pi-${randomUUID().slice(0, 8)}`, legalNameTh: 'แยกข้อมูลพอร์ทัล', taxId: '0999999000055', settings: {} } })
  const member = await prisma.member.create({ data: { organizationId: org.id, displayNameTh: 'จัดซื้อ', email: `pi-${randomUUID().slice(0, 8)}@test.bcs.local`, status: 'ACTIVE' } })
  for (const side of ['A', 'B']) {
    const nameS = `ผู้ขาย${side}-${randomUUID().slice(0, 6)}`
    const supplier = await prisma.supplier.create({ data: { organizationId: org.id, code: `PI-${side}-${randomUUID().slice(0, 4)}`, nameTh: nameS, taxId: null, isForeign: true, branchCode: '00000' } })
    const sc = await prisma.supplierContact.create({ data: { organizationId: org.id, supplierId: supplier.id, nameTh: `ติดต่อผู้ขาย${side}-${randomUUID().slice(0, 6)}`, email: `s${side.toLowerCase()}-${randomUUID().slice(0, 6)}@supplier.test`, isPrimary: true, privacyNoticeVersion: '2026-11-01' } })
    parties.push({ label: `supplier ${side}`, ctx: portalCtx(org.id, sc, NOW), marks: [supplier.id, nameS, sc.id, sc.nameTh] })
    const nameA = `ผู้สมัคร${side}-${randomUUID().slice(0, 6)}`
    const application = await prisma.supplierApplication.create({ data: { organizationId: org.id, kind: 'NEW', invitedById: member.id, invitedAt: NOW, lastActivityAt: NOW, expiresAt: new Date('2026-12-07T03:00:00Z'), nameTh: nameA } })
    const ac = await prisma.supplierContact.create({ data: { organizationId: org.id, applicationId: application.id, nameTh: `ติดต่อผู้สมัคร${side}-${randomUUID().slice(0, 6)}`, email: `a${side.toLowerCase()}-${randomUUID().slice(0, 6)}@supplier.test`, privacyNoticeVersion: '2026-11-01' } })
    parties.push({ label: `application ${side}`, ctx: portalCtx(org.id, ac, NOW), marks: [application.id, nameA, ac.id, ac.nameTh] })
  }
})

describe('[INV-SUP-01] every portal query sees its own supplier or application only', () => {
  it('finds the query files of the portal', () => expect(QUERY_FILES).toContain('queries.ts'))
  for (const file of QUERY_FILES) {
    it(`${file}: every export, as each of two suppliers and two applications, returns nothing of another`, async () => {
      const exported = (await import(path.join(PORTAL_DIR, file))) as Record<string, unknown>
      const queries = Object.entries(exported).filter(([, v]) => typeof v === 'function') as Array<[string, (ctx: Ctx) => Promise<unknown>]>
      expect(queries.length).toBeGreaterThan(0)
      for (const [name, query] of queries) {
        for (const me of parties) {
          const seen = JSON.stringify(await query(me.ctx))
          for (const other of parties.filter((p) => p !== me)) {
            for (const mark of other.marks) expect(seen.includes(mark), `${name} as ${me.label} shows ${other.label}`).toBe(false)
          }
        }
      }
    })
  }
})
