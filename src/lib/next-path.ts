// Where to go after signing in (an e-mail action link sends people to sign in first, BR-TOK-03): only a path of this
// site — "/a/…", "/tasks/…" — never another site ("//evil", "https://…", "/\evil"), so a link cannot send someone
// away after they sign in.

const SAFE_PATH = /^\/(?![/\\])[A-Za-z0-9\-._~/%?=&]*$/
const MAX_LENGTH = 300

export function safeNextPath(value: unknown): string | null {
  return typeof value === 'string' && value.length <= MAX_LENGTH && SAFE_PATH.test(value) ? value : null
}
