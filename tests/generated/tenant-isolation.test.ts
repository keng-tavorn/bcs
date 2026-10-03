// Generated tenant tests (spec §4.8, §15.3): the Prisma DMMF is read here, every model with an
// organizationId column is found and counted by this test (never hard-coded), and each one is checked for
// INV-TEN-02 (schema rules) and INV-TEN-01 (no cross-tenant read, update, delete or create via db.forTenant).
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import internals from '@prisma/internals'
import { beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@/lib/ids'
import { prisma } from '@/server/db/client'
import { RELATIONS } from '@/server/db/relations.generated'
import { forTenant, TenantViolationError } from '@/server/db/tenant'
import { GLOBAL_MODELS_WITH_ORG_COLUMN, TENANT_MODELS } from '@/server/db/tenant-models'
import { RELATIONS_FILE, renderRelations } from '../../scripts/gen-db-relations'

type Field = {
  name: string
  kind: 'scalar' | 'object' | 'enum' | 'unsupported'
  type: string
  isList: boolean
  isRequired: boolean
  isId: boolean
  hasDefaultValue: boolean
  isUpdatedAt?: boolean
  nativeType?: [string, string[]] | null
  relationFromFields?: string[]
  relationToFields?: string[]
}
type Model = { name: string; fields: Field[] }
type Index = { model: string; type: 'id' | 'unique' | 'normal' | 'fulltext'; fields: Array<{ name: string }> }

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const dmmf = await internals.getDMMF({ datamodel: readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8') })
const models = dmmf.datamodel.models as unknown as Model[]
const enums = new Map((dmmf.datamodel.enums as unknown as Array<{ name: string; values: Array<{ name: string }> }>).map((e) => [e.name, e.values.map((v) => v.name)]))
const indexes = dmmf.datamodel.indexes as unknown as Index[]

const withOrgColumn = models.filter((m) => m.fields.some((f) => f.name === 'organizationId')).map((m) => m.name)
const tenantModels = withOrgColumn.filter((name) => !GLOBAL_MODELS_WITH_ORG_COLUMN.has(name)).sort()

// Documented exceptions (each with its reason)
const NULLABLE_ORG_ALLOWED = new Set(['Event']) // platform-level events have no organization (§4.5)
const GLOBAL_UNIQUE_ALLOWED: Record<string, string[]> = {
  Event: ['seq'], // global ordering used for the audit seal (§4.5)
  FileObject: ['storageKey'], // object key is unique in the whole bucket
  MemberInvitation: ['tokenHash'], // sha256 of a random 32-byte token, unique by construction
  LineChannelConfig: ['channelKey'], // random and public: the LINE webhook path names it, and it finds the organization (§6.2)
}
// Unique indexes whose exact columns the spec writes out; each leads with a key of one organization's row
const SPEC_UNIQUE_ALLOWED: Record<string, string[][]> = {
  PositionAssignment: [['positionId', 'departmentId']], // §6.3 item 4 position_single_holder (Position.id is one organization's)
}

const delegateName = (model: string) => model.charAt(0).toLowerCase() + model.slice(1)
// any: generic access to every model delegate, whose types differ per model
const delegate = (client: unknown, model: string): any => (client as Record<string, unknown>)[delegateName(model)]

// Sample values that CHECK constraints of the migrations require (the generic sample would break them)
const SAMPLE_OVERRIDES: Record<string, Record<string, unknown>> = {
  Delegation: { endsAt: new Date('2026-10-06T03:00:00Z') }, // delegation_period: startsAt < endsAt
  BudgetLedgerEntry: { toBucket: 'AVAILABLE' }, // ledger_buckets_differ: fromBucket (OUTSIDE) <> toBucket
  Supplier: { isForeign: true }, // supplier_tax_id_shape: a Thai supplier needs a 13-digit tax id, a foreign one may have none
  InvoiceConfirmation: { netSatang: 1n, vatSatang: 0n, grossSatang: 1n }, // invoice_money_non_negative: gross = net + VAT
}
// Relations that need their own parent row instead of the shared one: delegation_not_self (delegator <> delegate)
const FRESH_PARENTS: Record<string, ReadonlySet<string>> = {
  Delegation: new Set(['delegate']),
}
// Optional relations a CHECK requires one of: budget_grant_one_grantee (a department or a member)
const OPTIONAL_PARENTS: Record<string, ReadonlySet<string>> = {
  BudgetGrant: new Set(['granteeDepartment']),
}
// Columns that must name an existing row without a relation in the schema: ledger_event_exists (INV-BUD-04)
const EXISTING_ROWS: Record<string, Record<string, string>> = {
  BudgetLedgerEntry: { eventId: 'Event' },
}

function sample(field: Field): unknown {
  if (field.isList) return []
  if (field.kind === 'enum') return enums.get(field.type)![0]
  switch (field.type) {
    case 'String':
      return field.nativeType?.[0] === 'Uuid' ? newId() : `t-${randomUUID()}`
    case 'Int':
      return 1
    case 'BigInt':
      return 1n
    case 'Float':
    case 'Decimal':
      return 1
    case 'Boolean':
      return false
    case 'DateTime':
      return new Date('2026-10-05T03:00:00Z')
    case 'Json':
      return {}
    default:
      throw new Error(`no sample for ${field.type}`)
  }
}

/** Builds valid create data for one row of `modelName` in `organizationId`, creating required parent rows first. */
async function rowData(modelName: string, organizationId: string): Promise<Record<string, unknown>> {
  const model = models.find((m) => m.name === modelName)!
  const data: Record<string, unknown> = {}
  for (const f of model.fields) {
    if (f.kind !== 'object' || !f.relationFromFields?.length) continue
    const fkFields = f.relationFromFields
    // A composite key (organizationId, xId) is required when its own column is: organizationId is always required
    const own = fkFields.filter((fk) => fk !== 'organizationId')
    const required = (own.length ? own : fkFields).every((fk) => model.fields.find((x) => x.name === fk)?.isRequired)
    if (!required && !OPTIONAL_PARENTS[modelName]?.has(f.name)) continue
    if (f.type === 'Organization') {
      data[fkFields[0]!] = organizationId
      continue
    }
    const parent = FRESH_PARENTS[modelName]?.has(f.name) ? await createRow(f.type, organizationId) : await parentRow(f.type, organizationId)
    fkFields.forEach((fk, i) => (data[fk] = parent[f.relationToFields![i]!]))
  }
  for (const f of model.fields) {
    if (f.kind === 'object' || data[f.name] !== undefined) continue
    if (f.name === 'organizationId') {
      data[f.name] = organizationId
      continue
    }
    const override = SAMPLE_OVERRIDES[modelName]?.[f.name]
    if (override !== undefined) {
      data[f.name] = override
      continue
    }
    if (f.isId || f.hasDefaultValue || f.isUpdatedAt || !f.isRequired) continue
    const existing = EXISTING_ROWS[modelName]?.[f.name]
    data[f.name] = existing ? (await parentRow(existing, organizationId)).id : sample(f)
  }
  return data
}

async function createRow(modelName: string, organizationId: string): Promise<Record<string, unknown>> {
  return delegate(prisma, modelName).create({ data: await rowData(modelName, organizationId) })
}

// Parent rows are created once per organization and shared: some tables allow one row of a kind per organization
// (department_single_root: one root department), and every child only needs some parent in the same organization
const parents = new Map<string, Promise<Record<string, unknown>>>()
function parentRow(modelName: string, organizationId: string): Promise<Record<string, unknown>> {
  const key = `${organizationId}:${modelName}`
  if (!parents.has(key)) parents.set(key, createRow(modelName, organizationId))
  return parents.get(key)!
}

const REACHABLE = new Set([...TENANT_MODELS, 'Organization'])
const unreachableModels = models.map((m) => m.name).filter((name) => !REACHABLE.has(name)).sort()
type Hop = { model: string; field: string; target: string; list: boolean }
const hops: Hop[] = models.flatMap((m) =>
  m.fields.filter((f) => f.kind === 'object').map((f) => ({ model: m.name, field: f.name, target: f.type, list: f.isList })),
)
// One hop from a reachable model straight into a platform/identity table, and two hops (via a reachable model)
const directLeaks = hops.filter((h) => REACHABLE.has(h.model) && !REACHABLE.has(h.target))
const twoHopLeaks = hops
  .filter((h) => REACHABLE.has(h.model) && REACHABLE.has(h.target))
  .flatMap((first) => directLeaks.filter((second) => second.model === first.target).map((second) => ({ first, second })))
// Relations from a tenant table to a tenant table (owning side): their key must include organizationId
const sameTenantKeys = models
  .filter((m) => TENANT_MODELS.has(m.name))
  .flatMap((m) =>
    m.fields
      .filter((f) => f.kind === 'object' && TENANT_MODELS.has(f.type) && f.relationFromFields?.length)
      .map((f) => ({ model: m.name, field: f, from: f.relationFromFields!, to: f.relationToFields! })),
  )

describe('[FR-PLT-001/AC3] [INV-TEN-02] tenant tables in the schema', () => {
  it('finds the tenant models itself and they match src/server/db/tenant-models.ts', () => {
    expect(tenantModels.length).toBeGreaterThan(0)
    expect(tenantModels).toEqual([...TENANT_MODELS].sort())
  })

  it.each(tenantModels)('%s has a NOT NULL, indexed organizationId', (name) => {
    const model = models.find((m) => m.name === name)!
    const org = model.fields.find((f) => f.name === 'organizationId')!
    if (!NULLABLE_ORG_ALLOWED.has(name)) expect(org.isRequired).toBe(true)
    const leading = indexes.filter((i) => i.model === name && i.fields[0]?.name === 'organizationId')
    expect(leading.length, `${name} needs an index or unique starting with organizationId`).toBeGreaterThan(0)
  })

  it.each(tenantModels)('%s business unique constraints include organizationId', (name) => {
    const uniques = indexes.filter((i) => i.model === name && i.type === 'unique')
    for (const u of uniques) {
      const fields = u.fields.map((f) => f.name)
      if (fields.length === 1 && (GLOBAL_UNIQUE_ALLOWED[name] ?? []).includes(fields[0]!)) continue
      if ((SPEC_UNIQUE_ALLOWED[name] ?? []).some((spec) => spec.join(',') === fields.join(','))) continue
      expect(fields, `${name} unique (${fields.join(', ')})`).toContain('organizationId')
    }
  })
})

describe('[FR-PLT-001/AC3] [INV-TEN-01] db.forTenant() never crosses organizations', () => {
  const rows = new Map<string, { a: Record<string, unknown>; b: Record<string, unknown> }>()
  let orgA: string
  let orgB: string

  beforeAll(async () => {
    const make = () =>
      prisma.organization.create({ data: { code: `T-${randomUUID().slice(0, 8)}`, legalNameTh: 'tenant test', taxId: '0999999000055', settings: {} } })
    orgA = (await make()).id
    orgB = (await make()).id
    // A model that is also some other model's parent reuses that row, so the one-per-organization tables hold
    for (const name of tenantModels) rows.set(name, { a: await parentRow(name, orgA), b: await parentRow(name, orgB) })
  })

  it('sees only its own organization row', async () => {
    const orgs = await forTenant(orgA).organization.findMany()
    expect(orgs.map((o) => o.id)).toEqual([orgA])
    expect(await forTenant(orgA).organization.findUnique({ where: { id: orgB } })).toBeNull()
  })

  it.each(tenantModels)('%s: reads, updates, deletes and creates stay inside the tenant', async (name) => {
    const { a, b } = rows.get(name)!
    const db = delegate(forTenant(orgA), name)
    const model = models.find((m) => m.name === name)!
    // The row key: "id", or the column a projection is keyed by (BudgetLineBalance.budgetLineId)
    const idKey = model.fields.find((f) => f.isId)!.name
    const byKey = (row: Record<string, unknown>) => ({ [idKey]: row[idKey] })

    const visible = (await db.findMany({ where: { [idKey]: { in: [a[idKey], b[idKey]] } } })) as Array<Record<string, unknown>>
    expect(visible.map((r) => r[idKey])).toEqual([a[idKey]])
    expect(visible.every((r) => r.organizationId === orgA)).toBe(true)
    expect(await db.findFirst({ where: byKey(b) })).toBeNull()
    expect(await db.findUnique({ where: byKey(b) })).toBeNull()
    expect(await db.count({ where: byKey(b) })).toBe(0)

    // Asking for the other tenant's rows explicitly finds nothing (it is not rewritten to this tenant's rows).
    expect(await db.findMany({ where: { organizationId: orgB } })).toEqual([])

    // A harmless "update" (set a column to its current value) must not reach the other tenant's row.
    // Append-only/insert-only tables (Event, CommandLog) refuse UPDATE/DELETE for the app role entirely.
    // a plain column (not the id, the tenant key, or a database-assigned value such as Event.seq)
    const plain = (f: Field) => f.kind !== 'object' && !f.isId && f.name !== 'organizationId' && !f.isUpdatedAt
    // a projection whose columns all start from a default (BudgetLineBalance) uses one of those
    const column = model.fields.find((f) => plain(f) && !f.hasDefaultValue) ?? model.fields.find((f) => plain(f) && f.kind === 'scalar' && f.name !== 'seq')!
    const [privileges] = await prisma.$queryRawUnsafe<Array<{ upd: boolean; del: boolean }>>(
      `select has_table_privilege('bcs_app', '"${name}"', 'UPDATE') as upd, has_table_privilege('bcs_app', '"${name}"', 'DELETE') as del`,
    )
    if (privileges!.upd) {
      expect((await db.updateMany({ where: byKey(b), data: { [column.name]: b[column.name] } })).count).toBe(0)
      await expect(db.update({ where: byKey(b), data: { [column.name]: b[column.name] } })).rejects.toThrow()
    } else {
      await expect(db.updateMany({ where: byKey(b), data: { [column.name]: b[column.name] } })).rejects.toThrow(/permission denied/)
    }
    if (privileges!.del) {
      expect((await db.deleteMany({ where: byKey(b) })).count).toBe(0)
    } else {
      await expect(db.deleteMany({ where: byKey(b) })).rejects.toThrow(/permission denied/)
    }

    // Writing a row for another organization is refused before it reaches the database.
    await expect(db.create({ data: { organizationId: orgB } })).rejects.toBeInstanceOf(TenantViolationError)
    await expect(db.updateMany({ where: byKey(a), data: { organizationId: orgB } })).rejects.toBeInstanceOf(TenantViolationError)

    // The other tenant's row is untouched.
    expect(await delegate(prisma, name).findUnique({ where: byKey(b) })).not.toBeNull()
  })
})

describe('[INV-TEN-01] the tenant guard follows relations', () => {
  it('relations.generated.ts matches prisma/schema.prisma', async () => {
    expect(readFileSync(path.join(ROOT, RELATIONS_FILE), 'utf8')).toBe(await renderRelations(ROOT))
    expect(Object.keys(RELATIONS).sort()).toEqual(models.map((m) => m.name).sort())
  })

  it('every reference between two tenant tables includes organizationId, so Postgres keeps it inside one organization', () => {
    expect(sameTenantKeys.length).toBeGreaterThan(0)
    for (const k of sameTenantKeys) expect(k.from, `${k.model}.${k.field.name}`).toContain('organizationId')
  })
})

describe('[INV-TEN-01] platform and identity tables are unreachable through db.forTenant()', () => {
  const orgId = newId()

  it('counts the unreachable models from the schema itself', () => {
    expect(unreachableModels.length).toBeGreaterThan(0)
    expect(unreachableModels).toContain('User')
  })

  it.each(unreachableModels)('%s cannot be queried', async (name) => {
    await expect(delegate(forTenant(orgId), name).findMany({ take: 1 })).rejects.toBeInstanceOf(TenantViolationError)
  })

  it.each(directLeaks.map((h) => [`${h.model}.${h.field} -> ${h.target}`, h] as const))('%s: include, select, filter and order are refused', async (_label, h) => {
    const db = delegate(forTenant(orgId), h.model)
    await expect(db.findMany({ include: { [h.field]: true } })).rejects.toBeInstanceOf(TenantViolationError)
    await expect(db.findMany({ select: { id: true, [h.field]: true } })).rejects.toBeInstanceOf(TenantViolationError)
    const filter = h.list ? { some: {} } : { is: {} }
    await expect(db.findMany({ where: { [h.field]: filter } })).rejects.toBeInstanceOf(TenantViolationError)
    await expect(db.findMany({ where: { OR: [{ [h.field]: filter }] } })).rejects.toBeInstanceOf(TenantViolationError)
    if (h.list) await expect(db.findMany({ select: { _count: { select: { [h.field]: true } } } })).rejects.toBeInstanceOf(TenantViolationError)
    else await expect(db.findMany({ orderBy: { [h.field]: { id: 'asc' } } })).rejects.toBeInstanceOf(TenantViolationError)
  })

  it.each(twoHopLeaks.map((p) => [`${p.first.model}.${p.first.field}.${p.second.field}`, p] as const))('%s: two hops away is refused too', async (_label, p) => {
    const db = delegate(forTenant(orgId), p.first.model)
    await expect(db.findMany({ include: { [p.first.field]: { include: { [p.second.field]: true } } } })).rejects.toBeInstanceOf(TenantViolationError)
    const inner = p.second.list ? { some: {} } : { is: {} }
    const outer = p.first.list ? { some: { [p.second.field]: inner } } : { is: { [p.second.field]: inner } }
    await expect(db.findMany({ where: { [p.first.field]: outer } })).rejects.toBeInstanceOf(TenantViolationError)
  })

  it.each(
    models
      .filter((m) => REACHABLE.has(m.name))
      .flatMap((m) => m.fields.filter((f) => f.kind === 'object').map((f) => [`${m.name}.${f.name}`, m.name, f.name] as const)),
  )('%s: nested relation writes are refused', async (_label, model, field) => {
    const db = delegate(forTenant(orgId), model)
    const nested = { connect: { id: newId() } }
    if (model !== 'Organization') await expect(db.create({ data: { [field]: nested } })).rejects.toBeInstanceOf(TenantViolationError)
    await expect(db.updateMany({ where: { id: newId() }, data: { [field]: nested } })).rejects.toBeInstanceOf(TenantViolationError)
  })
})

describe('[INV-TEN-01] Postgres refuses references into another organization', () => {
  let orgA: string
  let orgB: string
  beforeAll(async () => {
    const make = () =>
      prisma.organization.create({ data: { code: `F-${randomUUID().slice(0, 8)}`, legalNameTh: 'fk test', taxId: '0999999000055', settings: {} } })
    orgA = (await make()).id
    orgB = (await make()).id
  })

  it.each(sameTenantKeys.map((k) => [`${k.model}.${k.field.name}`, k] as const))('%s cannot point at a row of another organization', async (_label, k) => {
    // Any row of the other organization will do; a shared one keeps one-per-organization tables valid
    const target = await parentRow(k.field.type, orgB)
    const data = await rowData(k.model, orgA)
    k.from.forEach((column, i) => {
      if (column !== 'organizationId') data[column] = target[k.to[i]!]
    })
    // Even the unscoped client cannot do it: the composite foreign key includes organizationId
    await expect(delegate(prisma, k.model).create({ data })).rejects.toThrow()
    await expect(delegate(forTenant(orgA), k.model).create({ data })).rejects.toThrow()
  })

  it('an organization signatory must be a member of that organization', async () => {
    const outsider = await createRow('Member', orgB)
    await expect(
      forTenant(orgA).organization.update({ where: { id: orgA }, data: { contractSignatoryMemberId: outsider.id as string } }),
    ).rejects.toThrow()
    const insider = await createRow('Member', orgA)
    await forTenant(orgA).organization.update({ where: { id: orgA }, data: { contractSignatoryMemberId: insider.id as string } })
  })
})

describe('[INV-EVT-01] Postgres assigns Event.seq and Event.createdAt (§4.5: the audit order cannot be chosen by the caller)', () => {
  it('refuses a caller-chosen seq and overrides a backdated createdAt', async () => {
    const org = await prisma.organization.create({
      data: { code: `E-${randomUUID().slice(0, 8)}`, legalNameTh: 'seq test', taxId: '0999999000055', settings: {} },
    })
    const base = await rowData('Event', org.id)
    await expect(prisma.event.create({ data: { ...base, seq: 9_000_000_000n } as never })).rejects.toThrow()
    const backdated = await prisma.event.create({ data: { ...base, id: newId(), createdAt: new Date('2020-01-01T00:00:00Z') } as never })
    expect(backdated.createdAt.getUTCFullYear()).toBeGreaterThan(2020)
    const next = await prisma.event.create({ data: { ...base, id: newId() } as never })
    expect(next.seq).toBeGreaterThan(backdated.seq)
  })
})
