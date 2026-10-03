// Models whose rows belong to one organization (INV-TEN-02). Maintained by hand when the schema changes;
// tests/generated/tenant-isolation.test.ts reads the Prisma DMMF itself and fails if this list drifts.
export const TENANT_MODELS: ReadonlySet<string> = new Set([
  'OrgModule',
  'Member',
  'RoleAssignment',
  'Event',
  'Outbox',
  'CommandLog',
  'FileObject',
  'FileLink',
  'Notification',
  'MemberInvitation',
  'Comment',
])

// Have an organizationId column but are platform tables reached only through platform code (spec §4.8).
export const GLOBAL_MODELS_WITH_ORG_COLUMN: ReadonlySet<string> = new Set(['BreakGlassSession'])
