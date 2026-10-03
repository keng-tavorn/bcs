import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { nextCookies } from 'better-auth/next-js'
import { twoFactor } from 'better-auth/plugins'
import { systemClock } from '@/lib/clock'
import { MS_PER_SECOND, PASSWORD_MIN_LENGTH, PASSWORD_RESET_TTL_SECONDS, SESSION_ABSOLUTE_MS } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { newId } from '@/lib/ids'
import { prisma } from '@/server/db/client'
import { recordAuthEvent } from './auth-events'
import { liffIdToken } from './liff'
import { beginLoginAttempt, clientIp, ipPrefix, normalizeEmail, settleLoginAttempt } from './lockout'
import { sendPasswordResetEmail } from './emails'

// Better Auth is identity only (spec §5.1): email + password, TOTP, sessions. Organization membership,
// roles and permissions live in our own tables (Member, RoleAssignment, src/server/authz).

const env = getEnv()

const TWO_FACTOR_STEPS = new Set(['/two-factor/verify-totp', '/two-factor/verify-backup-code'])

/** The sign-in attempt a request reserved in the before hook (lockout.ts), read back by the after hook. Keyed by the
 *  per-request copy of Better Auth's context that both hooks of one request receive. */
const reservedAttempts = new WeakMap<object, { attemptId: string; email: string }>()

/** The parts of a Better Auth hook context used to find the account that is waiting for its second step. */
interface TwoFactorHookContext {
  getSignedCookie(key: string, secret: string): Promise<string | null | false | undefined>
  readonly context: {
    readonly secret: string
    createAuthCookie(name: string): { name: string }
    readonly internalAdapter: {
      findVerificationValue(identifier: string): Promise<{ value: string } | null | undefined>
      findUserById(id: string): Promise<{ email: string } | null | undefined>
    }
  }
}

/** E-mail of the account behind Better Auth's signed two_factor cookie (sign-in in progress); '' when there is none,
 *  e.g. a signed-in member confirming TOTP setup. */
async function pendingTwoFactorEmail(ctx: TwoFactorHookContext): Promise<string> {
  const signed = await ctx.getSignedCookie(ctx.context.createAuthCookie('two_factor').name, ctx.context.secret)
  if (!signed) return ''
  const verification = await ctx.context.internalAdapter.findVerificationValue(signed)
  if (!verification) return ''
  const user = await ctx.context.internalAdapter.findUserById(verification.value)
  return user ? normalizeEmail(user.email) : ''
}

export const auth = betterAuth({
  appName: 'BCS',
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  advanced: {
    database: { generateId: () => newId() },
    cookiePrefix: 'bcs',
    // Secure cookies whenever the app is served over https (NFR-SEC-02), however the scheme was written
    useSecureCookies: new URL(env.APP_URL).protocol === 'https:',
  },
  emailAndPassword: {
    enabled: true,
    // Accounts are created by invitation only (FR-AUTH-001 AC1)
    disableSignUp: true,
    minPasswordLength: PASSWORD_MIN_LENGTH,
    maxPasswordLength: 128,
    autoSignIn: false,
    resetPasswordTokenExpiresIn: PASSWORD_RESET_TTL_SECONDS,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      await sendPasswordResetEmail({ email: user.email, url })
    },
  },
  session: {
    // Absolute lifetime 12 h, never extended; idle limits are enforced in resolveSession (FR-AUTH-003 AC1)
    expiresIn: SESSION_ABSOLUTE_MS / MS_PER_SECOND,
    disableSessionRefresh: true,
    cookieCache: { enabled: false },
    additionalFields: { lastActiveAt: { type: 'date', required: false, input: false } },
  },
  rateLimit: {
    enabled: true,
    storage: 'database',
    window: 60,
    max: 120,
    // Both sign-in steps are limited by our own account/IP lockout instead (lockout.ts: only failures count, 5 per
    // account checked at most, also in parallel). Better Auth's per-address rules count every request until the
    // address has been quiet for a whole window, so a room signing in one after another on one Wi-Fi would be
    // refused. The other two-factor routes keep the plugin's rule (3 per 10 s): enabling 2FA checks the password.
    customRules: { '/sign-in/email': false, '/two-factor/verify-totp': false, '/two-factor/verify-backup-code': false },
  },
  databaseHooks: {
    user: {
      update: {
        // Better Auth turns twoFactorEnabled on only when a user confirms TOTP setup (verify-totp while enrolling)
        after: async (user, ctx) => {
          if (ctx?.path === '/two-factor/verify-totp' && user.twoFactorEnabled === true) {
            await recordAuthEvent('auth.2fa_enabled', normalizeEmail(user.email), { method: 'TOTP' }, systemClock.now())
          }
        },
      },
    },
  },
  // nextCookies() must stay last
  plugins: [twoFactor({ issuer: 'BCS', backupCodeOptions: { amount: 10, storeBackupCodes: 'encrypted' } }), liffIdToken(), nextCookies()],
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // Members cannot switch their own 2FA off; an ORG_ADMIN resets it with a reason (FR-AUTH-002 AC3)
      if (ctx.path === '/two-factor/disable') throw new APIError('FORBIDDEN', { message: 'TWO_FACTOR_RESET_BY_ADMIN', code: 'FORBIDDEN' })
      if (ctx.path !== '/sign-in/email' && !TWO_FACTOR_STEPS.has(ctx.path)) return
      // The second step of a sign-in is locked like the first: signing in again with the password gives no new tries
      const email = ctx.path === '/sign-in/email' ? normalizeEmail((ctx.body as { email?: unknown } | undefined)?.email) : await pendingTwoFactorEmail(ctx)
      if (TWO_FACTOR_STEPS.has(ctx.path) && !email) return
      const ip = clientIp(ctx.headers)
      const verdict = await beginLoginAttempt(email, ip, systemClock.now())
      if (!verdict.allowed) {
        await recordAuthEvent('auth.login_locked', email, { reason: verdict.reason, ip: ipPrefix(ip) }, systemClock.now())
        // The forms tell an account lock from an address lock and say when to try again (§9.9 rule 7)
        throw new APIError('TOO_MANY_REQUESTS', { message: 'LOGIN_LOCKED', code: 'LOGIN_LOCKED', reason: verdict.reason, retryAt: verdict.retryAt.toISOString() })
      }
      reservedAttempts.set(ctx.context, { attemptId: verdict.attemptId, email })
    }),
    after: createAuthMiddleware(async (ctx) => {
      const now = systemClock.now()
      const reserved = reservedAttempts.get(ctx.context)
      const failed = ctx.context.returned instanceof APIError
      if (reserved) await settleLoginAttempt(reserved.attemptId, !failed)
      if (ctx.path === '/sign-in/email') {
        const email = normalizeEmail((ctx.body as { email?: unknown } | undefined)?.email)
        const ip = clientIp(ctx.headers)
        await recordAuthEvent(failed ? 'auth.login_failed' : 'auth.login_succeeded', email, { ip: ipPrefix(ip), step: 'password' }, now)
      }
      if (TWO_FACTOR_STEPS.has(ctx.path)) {
        const user = failed ? undefined : (ctx.context.returned as { user?: { email?: string } } | undefined)?.user
        if (user?.email) await recordAuthEvent('auth.login_succeeded', normalizeEmail(user.email), { step: 'two_factor' }, now)
        // A wrong code during sign-in is a failed attempt of that account (NFR-SEC-05: OTP may be wrong 5 times)
        if (failed && reserved) await recordAuthEvent('auth.login_failed', reserved.email, { ip: ipPrefix(clientIp(ctx.headers)), step: 'two_factor' }, now)
      }
    }),
  },
})

export type Auth = typeof auth
