import { toNextJsHandler } from 'better-auth/next-js'
import { auth } from '@/server/auth/auth'

// Better Auth endpoints (sign-in, two-factor, password reset). GET endpoints only read (session, callbacks).
export const runtime = 'nodejs'

export const { GET, POST } = toNextJsHandler(auth)
