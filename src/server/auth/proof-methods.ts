import { systemDb } from '@/server/db/system'
import type { IdentityProofMethod } from './pin'

// Which ways of proving who they are again a member can use before setting a PIN (FR-AUTH-005 AC1, /settings/pin step 1;
// proveIdentityForPin of ./step-up.ts checks the proof itself):
//  - PASSWORD: the sign-in identity has a password (Better Auth's credential account);
//  - TOTP: the identity has an authenticator app set up — two-factor sign-in on, and the app confirmed with a code. That is
//    Better Auth's own rule for offering the code at sign-in: a setup started and never confirmed (TwoFactor.verified =
//    false) is no authenticator yet.
// Only whether each exists, never a password hash or a secret. Better Auth's tables are shared by every organization:
// the caller passes the userId of its own organization's member (read through forTenant), and only that identity's rows
// are read.

/** The order the screens offer them in */
const ORDER: readonly IdentityProofMethod[] = ['PASSWORD', 'TOTP']

/** The proofs that can work for this sign-in identity (none for a member who has none yet: an invitation not accepted) */
export async function identityProofMethods(userId: string | null): Promise<readonly IdentityProofMethod[]> {
  if (!userId) return []
  const user = await systemDb.user.findUnique({
    where: { id: userId },
    select: {
      twoFactorEnabled: true,
      // gt '': neither NULL nor empty, as ./step-up.ts reads them (no password, no secret: not available)
      accounts: { where: { providerId: 'credential', password: { gt: '' } }, select: { id: true }, take: 1 },
      twofactors: { where: { secret: { gt: '' }, OR: [{ verified: true }, { verified: null }] }, select: { id: true }, take: 1 },
    },
  })
  if (!user) return []
  const has: Record<IdentityProofMethod, boolean> = { PASSWORD: user.accounts.length > 0, TOTP: user.twoFactorEnabled === true && user.twofactors.length > 0 }
  return ORDER.filter((method) => has[method])
}
