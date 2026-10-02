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
import { forTenant, TenantViolationError } from '@/server/db/tenant'
import { GLOBAL_MODELS_WITH_ORG_COLUMN, TENANT_MODELS } from '@/server/db/tenant-models'

type Field = {
  name: string
  kind: 'scalar' | 'object' | 'enum' | 'unsupported'
  type: string
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
}

const delegateName = (model: string) => model.charAt(0).toLowerCase() + model.slice(1)
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic access to every model delegate
const delegate = (client: unknown, model: string): any => (client as Record<string, unknown>)[delegateName(model)]

function sample(field: Field): unknown {
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

/** Creates one valid row of `modelName` for `organizationId`, creating required parent rows first. */
async function createRow(modelName: string, organizationId: string): Promise<Record<string, unknown>> {
  const model = models.find((m) => m.name === modelName)!
  const data: Record<string, unknown> = {}
  for (const f of model.fields) {
    if (f.kind !== 'object' || !f.relationFromFields?.length) continue
    const fkFields = f.relationFromFields
    const required = fkFields.some((fk) => model.fields.find((x) => x.name === fk)?.isRequired)
    if (!required) continue
    if (f.type === 'Organization') {
      data[fkFields[0]!] = organizationId
      continue
    }
    const parent = await createRow(f.type, organizationId)
    fkFields.forEach((fk, i) => (data[fk] = parent[f.relationToFields![i]!]))
  }
  for (const f of model.fields) {
    if (f.kind === 'object' || data[f.name] !== undefined) continue
    if (f.name === 'organizationId') {
      data[f.name] = organizationId
      continue
    }
    if (f.isId || f.hasDefaultValue || f.isUpdatedAt || !f.isRequired) continue
    data[f.name] = sample(f)
  }
  return delegate(prisma, modelName).create({ data })
}

describe('[INV-TEN-02] tenant tables in the schema', () => {
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
      expect(fields, `${name} unique (${fields.join(', ')})`).toContain('organizationId')
    }
  })
})

describe('[INV-TEN-01] db.forTenant() never crosses organizations', () => {
  const rows = new Map<string, { a: Record<string, unknown>; b: Record<string, unknown> }>()
  let orgA: string
  let orgB: string

  beforeAll(async () => {
    const make = () =>
      prisma.organization.create({ data: { code: `T-${randomUUID().slice(0, 8)}`, legalNameTh: 'tenant test', taxId: '0999999000055', settings: {} } })
    orgA = (await make()).id
    orgB = (await make()).id
    for (const name of tenantModels) rows.set(name, { a: await createRow(name, orgA), b: await createRow(name, orgB) })
  })

  it('sees only its own organization row', async () => {
    const orgs = await forTenant(orgA).organization.findMany()
    expect(orgs.map((o) => o.id)).toEqual([orgA])
    expect(await forTenant(orgA).organization.findUnique({ where: { id: orgB } })).toBeNull()
  })

  it.each(tenantModels)('%s: reads, updates, deletes and creates stay inside the tenant', async (name) => {
    const { a, b } = rows.get(name)!
    const db = delegate(forTenant(orgA), name)

    const visible = (await db.findMany({ where: { id: { in: [a.id, b.id] } } })) as Array<Record<string, unknown>>
    expect(visible.map((r) => r.id)).toEqual([a.id])
    expect(visible.every((r) => r.organizationId === orgA)).toBe(true)
    expect(await db.findFirst({ where: { id: b.id } })).toBeNull()
    expect(await db.findUnique({ where: { id: b.id } })).toBeNull()
    expect(await db.count({ where: { id: b.id } })).toBe(0)

    // Asking for the other tenant's rows explicitly finds nothing (it is not rewritten to this tenant's rows).
    expect(await db.findMany({ where: { organizationId: orgB } })).toEqual([])

    // A harmless "update" (set a column to its current value) must not reach the other tenant's row.
    // Append-only/insert-only tables (Event, CommandLog) refuse UPDATE/DELETE for the app role entirely.
    const model = models.find((m) => m.name === name)!
    const column = model.fields.find((f) => f.kind !== 'object' && !f.isId && f.name !== 'organizationId' && !f.isUpdatedAt)!
    const [privileges] = await prisma.$queryRawUnsafe<Array<{ upd: boolean; del: boolean }>>(
      `select has_table_privilege('bcs_app', '"${name}"', 'UPDATE') as upd, has_table_privilege('bcs_app', '"${name}"', 'DELETE') as del`,
    )
    if (privileges!.upd) {
      expect((await db.updateMany({ where: { id: b.id }, data: { [column.name]: b[column.name] } })).count).toBe(0)
      await expect(db.update({ where: { id: b.id }, data: { [column.name]: b[column.name] } })).rejects.toThrow()
    } else {
      await expect(db.updateMany({ where: { id: b.id }, data: { [column.name]: b[column.name] } })).rejects.toThrow(/permission denied/)
    }
    if (privileges!.del) {
      expect((await db.deleteMany({ where: { id: b.id } })).count).toBe(0)
    } else {
      await expect(db.deleteMany({ where: { id: b.id } })).rejects.toThrow(/permission denied/)
    }

    // Writing a row for another organization is refused before it reaches the database.
    await expect(db.create({ data: { organizationId: orgB } })).rejects.toBeInstanceOf(TenantViolationError)
    await expect(db.updateMany({ where: { id: a.id }, data: { organizationId: orgB } })).rejects.toBeInstanceOf(TenantViolationError)

    // The other tenant's row is untouched.
    expect(await delegate(prisma, name).findUnique({ where: { id: b.id } })).not.toBeNull()
  })
})
