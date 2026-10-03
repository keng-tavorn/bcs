import type { TenantTx } from '../tenant'

// Better Auth's identity tables (Session, TwoFactor, User) are shared by every organization, so forTenant refuses
// them. A service that must revoke access does it here: each statement joins through the Member row of the given
// organization, so it can only reach the identity of that organization's member, and it runs inside the caller's
// command transaction (deactivation and 2FA reset revoke access atomically: FR-AUTH-002 AC3, FR-AUTH-003 AC2).

export async function deleteMemberSessions(tx: TenantTx, organizationId: string, memberId: string): Promise<number> {
  return tx.$executeRaw`
    DELETE FROM "Session" s USING "Member" m
    WHERE m."id" = ${memberId}::uuid AND m."organizationId" = ${organizationId}::uuid AND s."userId" = m."userId"`
}

export async function deleteMemberSession(tx: TenantTx, organizationId: string, memberId: string, sessionId: string): Promise<number> {
  return tx.$executeRaw`
    DELETE FROM "Session" s USING "Member" m
    WHERE s."id" = ${sessionId}::uuid AND m."id" = ${memberId}::uuid AND m."organizationId" = ${organizationId}::uuid
      AND s."userId" = m."userId"`
}

/** Removes the member's authenticator and backup codes; they must enroll again at next sign-in. */
export async function removeMemberTwoFactor(tx: TenantTx, organizationId: string, memberId: string): Promise<void> {
  await tx.$executeRaw`
    DELETE FROM "TwoFactor" t USING "Member" m
    WHERE m."id" = ${memberId}::uuid AND m."organizationId" = ${organizationId}::uuid AND t."userId" = m."userId"`
  await tx.$executeRaw`
    UPDATE "User" u SET "twoFactorEnabled" = false, "updatedAt" = now() FROM "Member" m
    WHERE m."id" = ${memberId}::uuid AND m."organizationId" = ${organizationId}::uuid AND u."id" = m."userId"`
}

/**
 * Active memberships of the same identity in other organizations. Changing a shared identity (its 2FA) would
 * change how the person signs in to those organizations too, which one organization's admin must not do.
 */
export async function countOtherActiveMemberships(tx: TenantTx, organizationId: string, memberId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*)::bigint AS n FROM "Member" other JOIN "Member" m ON other."userId" = m."userId"
    WHERE m."id" = ${memberId}::uuid AND m."organizationId" = ${organizationId}::uuid
      AND other."organizationId" <> m."organizationId" AND other."status" <> 'DEACTIVATED'`
  return Number(rows[0]?.n ?? 0)
}
