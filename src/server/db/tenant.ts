import { prisma } from './client'
import { TENANT_MODELS } from './tenant-models'

// db.forTenant(orgId) — the only way services and queries reach tenant data (spec §4.8, ADR-029).
// Every query on a tenant model gets `organizationId` added to its filter, and every create gets it set;
// a write that names another organization is refused. Use scalar (unchecked) inputs and avoid nested
// creates: nested writes bypass this hook, so they must set organizationId explicitly.

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

export class TenantViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TenantViolationError'
  }
}

type Row = Record<string, unknown>

function ensureSameTenant(model: string, data: unknown, organizationId: string): void {
  const rows = Array.isArray(data) ? data : [data]
  for (const row of rows as Row[]) {
    const value = row?.organizationId
    if (value !== undefined && value !== organizationId) {
      throw new TenantViolationError(`${model}: write for another organization was refused`)
    }
  }
}

export function scopeTenantArgs(model: string, operation: string, args: Row, organizationId: string): Row {
  if (model === 'Organization') {
    // A tenant can see and change only its own organization row; creation belongs to the platform.
    if (operation.startsWith('create') || operation === 'upsert') {
      throw new TenantViolationError('Organization rows are created by PLATFORM_ADMIN only')
    }
    if (WHERE_OPERATIONS.has(operation)) return { ...args, where: { ...(args.where as Row), id: organizationId } }
    return args
  }
  if (!TENANT_MODELS.has(model)) return args

  const next: Row = { ...args }
  if (WHERE_OPERATIONS.has(operation)) next.where = { ...(args.where as Row), organizationId }
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
