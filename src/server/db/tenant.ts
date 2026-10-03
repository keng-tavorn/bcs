import { prisma } from './client'
import { RELATIONS } from './relations.generated'
import { TENANT_MODELS } from './tenant-models'

// db.forTenant(orgId) — the only way services and queries reach tenant data (spec §4.8, ADR-029).
// 1. Every query on a tenant model gets `organizationId` added to its filter and every create gets it set;
//    a write that names another organization is refused.
// 2. Only tenant tables and the tenant's own Organization row are reachable. Queries on identity or platform
//    tables (Better Auth's User/Session/Account/TwoFactor, PlatformAdmin, BreakGlassSession…), and any include,
//    select, relation filter or relation ordering that leads into one of them, are refused: those tables are
//    shared by all organizations, so following them leads to other tenants' rows. Identity changes that a
//    service needs go through src/server/db/sql/identity.ts.
// 3. Nested relation writes (connect, create, update… inside `data`) are refused: use scalar foreign keys.
//    Postgres enforces composite (organizationId, id) foreign keys, so a scalar key cannot point into another
//    organization either.
// 4. Event.seq and Event.createdAt are assigned by Postgres (identity column and trigger), never by callers.

const WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'upsert',
])
const DATA_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn'])
const REACHABLE_MODELS: ReadonlySet<string> = new Set([...TENANT_MODELS, 'Organization'])
const LOGICAL_KEYS = new Set(['AND', 'OR', 'NOT'])
const LIST_FILTER_KEYS = ['some', 'every', 'none']
const ONE_FILTER_KEYS = ['is', 'isNot']

export class TenantViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TenantViolationError'
  }
}

type Row = Record<string, unknown>

function isRecord(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
}

function relationOf(model: string, field: string) {
  return RELATIONS[model]?.[field]
}

function assertReachable(model: string, path: string): void {
  if (!REACHABLE_MODELS.has(model)) {
    throw new TenantViolationError(`${path} leads to ${model}, a platform or identity table that forTenant cannot reach`)
  }
}

/** include / select trees, including `_count: { select: { relation: … } }`. */
function checkProjection(model: string, tree: unknown, path: string): void {
  if (!isRecord(tree)) return
  for (const [key, value] of Object.entries(tree)) {
    if (value === false || value === undefined) continue
    if (key === '_count') {
      if (isRecord(value) && isRecord(value.select)) {
        for (const [field, sub] of Object.entries(value.select)) {
          const target = relationOf(model, field)
          if (!target) continue
          assertReachable(target.model, `${path}._count.${field}`)
          if (isRecord(sub)) checkWhere(target.model, sub.where, `${path}._count.${field}.where`)
        }
      }
      continue
    }
    const target = relationOf(model, key)
    if (!target) continue
    assertReachable(target.model, `${path}.${key}`)
    if (isRecord(value)) checkReadArgs(target.model, value, `${path}.${key}`)
  }
}

function checkWhere(model: string, where: unknown, path: string): void {
  if (Array.isArray(where)) {
    where.forEach((w, i) => checkWhere(model, w, `${path}[${i}]`))
    return
  }
  if (!isRecord(where)) return
  for (const [key, value] of Object.entries(where)) {
    if (LOGICAL_KEYS.has(key)) {
      checkWhere(model, value, `${path}.${key}`)
      continue
    }
    const target = relationOf(model, key)
    if (!target) continue
    assertReachable(target.model, `${path}.${key}`)
    if (!isRecord(value)) continue
    const filterKeys = target.list ? LIST_FILTER_KEYS : ONE_FILTER_KEYS
    const present = filterKeys.filter((k) => k in value)
    for (const k of present) checkWhere(target.model, value[k], `${path}.${key}.${k}`)
    if (present.length === 0 && !target.list) checkWhere(target.model, value, `${path}.${key}`)
  }
}

function checkOrderBy(model: string, orderBy: unknown, path: string): void {
  if (Array.isArray(orderBy)) {
    orderBy.forEach((o, i) => checkOrderBy(model, o, `${path}[${i}]`))
    return
  }
  if (!isRecord(orderBy)) return
  for (const [key, value] of Object.entries(orderBy)) {
    const target = relationOf(model, key)
    if (!target) continue
    assertReachable(target.model, `${path}.${key}`)
    if (isRecord(value) && !target.list) checkOrderBy(target.model, value, `${path}.${key}`)
  }
}

function checkReadArgs(model: string, args: Row, path: string): void {
  checkProjection(model, args.include, `${path}.include`)
  checkProjection(model, args.select, `${path}.select`)
  checkWhere(model, args.where, `${path}.where`)
  checkOrderBy(model, args.orderBy, `${path}.orderBy`)
}

function refuseNestedWrites(model: string, data: unknown, path: string): void {
  const rows = Array.isArray(data) ? data : [data]
  for (const row of rows) {
    if (!isRecord(row)) continue
    for (const key of Object.keys(row)) {
      if (relationOf(model, key)) {
        throw new TenantViolationError(`${path}.${key}: nested relation writes are refused through forTenant; set the scalar foreign key`)
      }
    }
  }
}

function ensureSameTenant(model: string, data: unknown, organizationId: string): void {
  const rows = Array.isArray(data) ? data : [data]
  for (const row of rows as Row[]) {
    const value = row?.organizationId
    if (value !== undefined && value !== organizationId) {
      throw new TenantViolationError(`${model}: write for another organization was refused`)
    }
  }
}

/**
 * Adds a condition to the caller's filter without replacing anything the caller asked for: a query for
 * another organization's row must find nothing, not silently return this tenant's row instead.
 * AND is valid in unique filters too (findUnique/update/delete/upsert), so the shape works everywhere.
 */
function andWhere(where: unknown, condition: Row): Row {
  const base = (where ?? {}) as Row
  const existing = base.AND === undefined ? [] : Array.isArray(base.AND) ? base.AND : [base.AND]
  return { ...base, AND: [...existing, condition] }
}

export function scopeTenantArgs(model: string, operation: string, args: Row, organizationId: string): Row {
  if (!REACHABLE_MODELS.has(model)) {
    throw new TenantViolationError(`${model} is a platform or identity table: forTenant cannot reach it`)
  }
  checkReadArgs(model, args, `${model}.${operation}`)
  if (DATA_OPERATIONS.has(operation)) refuseNestedWrites(model, args.data, `${model}.${operation}.data`)
  if (operation === 'upsert') {
    refuseNestedWrites(model, args.create, `${model}.upsert.create`)
    refuseNestedWrites(model, args.update, `${model}.upsert.update`)
  }

  if (model === 'Organization') {
    // A tenant can see and change only its own organization row; creating and removing belong to the platform.
    if (operation.startsWith('create') || operation === 'upsert' || operation.startsWith('delete')) {
      throw new TenantViolationError('Organization rows are created and removed by PLATFORM_ADMIN only')
    }
    if (WHERE_OPERATIONS.has(operation)) return { ...args, where: andWhere(args.where, { id: organizationId }) }
    return args
  }

  const next: Row = { ...args }
  if (WHERE_OPERATIONS.has(operation)) next.where = andWhere(args.where, { organizationId })
  if (operation === 'create') {
    ensureSameTenant(model, args.data, organizationId)
    next.data = { ...(args.data as Row), organizationId }
  }
  if (operation === 'createMany' || operation === 'createManyAndReturn') {
    ensureSameTenant(model, args.data, organizationId)
    const rows = Array.isArray(args.data) ? args.data : [args.data]
    next.data = (rows as Row[]).map((row) => ({ ...row, organizationId }))
  }
  if (operation === 'upsert') {
    ensureSameTenant(model, args.create, organizationId)
    next.create = { ...(args.create as Row), organizationId }
  }
  if (['update', 'updateMany', 'updateManyAndReturn', 'upsert'].includes(operation)) {
    const data = (operation === 'upsert' ? args.update : args.data) as Row | undefined
    if (data && 'organizationId' in data && data.organizationId !== organizationId) {
      throw new TenantViolationError(`${model}: moving rows to another organization was refused`)
    }
  }
  return next
}

export function forTenant(organizationId: string) {
  if (!organizationId) throw new TenantViolationError('organizationId is required')
  return prisma.$extends({
    name: 'tenant',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          return query(scopeTenantArgs(model, operation, (args ?? {}) as Row, organizationId) as typeof args)
        },
      },
    },
  })
}

export type TenantDb = ReturnType<typeof forTenant>
/** The transaction client of a tenant-scoped interactive transaction. */
export type TenantTx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0]
