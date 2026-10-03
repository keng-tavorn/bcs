import { twoFactorClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

// Browser client for Better Auth's endpoints under /api/auth (same origin). Sign-in, the 2FA step, password reset
// and authenticator setup go through it; everything about organizations goes through our own server actions.
export const authClient = createAuthClient({ plugins: [twoFactorClient()] })

export function errorStatus(error: { status?: number } | null | undefined): number {
  return error?.status ?? 0
}
