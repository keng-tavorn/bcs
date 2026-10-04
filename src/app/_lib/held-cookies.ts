// The Cookie header of a request written again from the cookies Next.js holds now: src/app/_lib/session.ts says why (a
// server action that changed the session cookie renders its page again in the same request, and only cookies() knows
// the new value). Kept apart from session.ts, which needs a request, so tests/integration/tasks-step-up.test.ts runs it
// with Next.js's own cookie stores and Better Auth's own session lookup.

/** A cookie as Next.js's cookies() holds it: its name and its value, decoded */
export interface HeldCookie {
  readonly name: string
  readonly value: string
}

/**
 * `incoming` with its Cookie header written from `held`: each value URI-encoded, as a browser sends what a Set-Cookie gave
 * it (Better Auth decodes it again); a cookie with an empty value — deleted during the request — is left out
 */
export function withHeldCookies(incoming: Headers, held: readonly HeldCookie[]): Headers {
  const merged = new Headers(incoming)
  const cookie = held
    .filter((c) => c.value !== '')
    .map((c) => `${c.name}=${encodeURIComponent(c.value)}`)
    .join('; ')
  if (cookie) merged.set('cookie', cookie)
  else merged.delete('cookie')
  return merged
}
