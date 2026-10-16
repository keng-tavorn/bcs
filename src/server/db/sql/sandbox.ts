import type { TenantTx } from '../tenant'

// Raw SQL lives only here (spec §4.8). A UAT sandbox (S6-21 · BR-UAT-01 BR-UAT-04) is a new organization made inside
// the command of its production organization, so the event on the production organization and the new row commit
// together; forTenant reaches no other organization's row, hence these two inserts. The sandbox starts empty — no
// department, position, member, DOA or document — with the CORE module on under the contract.

export async function insertSandboxOrganization(
  tx: TenantTx,
  input: {
    readonly id: string
    readonly code: string
    readonly legalNameTh: string
    readonly taxId: string
    readonly branchCode: string
    readonly timezone: string
    readonly settings: object
    readonly sandboxOfOrganizationId: string
    readonly platformAdminId: string
    readonly contractRef: string
    readonly reason: string
    readonly now: Date
  },
): Promise<'CREATED' | 'CODE_TAKEN'> {
  const taken = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Organization" WHERE "code" = ${input.code}`
  if (taken.length) return 'CODE_TAKEN'
  await tx.$executeRaw`
    INSERT INTO "Organization" ("id", "code", "legalNameTh", "taxId", "branchCode", "timezone", "settings", "kind", "sandboxOfOrganizationId", "updatedAt")
    VALUES (${input.id}::uuid, ${input.code}, ${input.legalNameTh}, ${input.taxId}, ${input.branchCode}, ${input.timezone}, ${JSON.stringify(input.settings)}::jsonb,
            'SANDBOX'::"OrganizationKind", ${input.sandboxOfOrganizationId}::uuid, ${input.now})`
  await tx.$executeRaw`
    INSERT INTO "OrgModule" ("id", "organizationId", "module", "enabled", "enabledAt", "changedByPlatformAdminId", "contractRef", "reason", "updatedAt")
    VALUES (gen_random_uuid(), ${input.id}::uuid, 'CORE'::"ModuleKey", true, ${input.now}, ${input.platformAdminId}::uuid, ${input.contractRef}, ${input.reason}, ${input.now})`
  return 'CREATED'
}
