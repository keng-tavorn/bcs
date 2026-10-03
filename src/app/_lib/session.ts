import { headers } from 'next/headers'
import { cache } from 'react'
import { resolvePlatformSession, resolveSession } from '@/server/auth/session'

// One session lookup per request, shared by the layout and the page (resolveSession also refreshes lastActiveAt).
export const getSession = cache(async () => resolveSession(await headers()))

// The BCS team's session for /platform/* (an active PlatformAdmin row for the signed-in identity).
export const getPlatformSession = cache(async () => resolvePlatformSession(await headers()))
