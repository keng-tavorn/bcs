// Prisma's text filters startsWith, contains and endsWith become a LIKE (ILIKE with mode 'insensitive') whose pattern is
// the value with % around it, and Prisma 7 does not escape the value: a `_` in it matches any one character and a `%`
// any text. A position code VP_OPS would then find the tasks of position VPXOPS, a search for "50%" every text with "50"
// in it, and a token prefix liff_ a token "liffA…". Every value given to those filters goes through escapeLike(), so it
// matches itself only (tests/unit/like-escape.test.ts checks that src does so). Raw SQL writes its own pattern
// (src/server/db/sql/identity.ts).

/** Postgres LIKE's escape character: a backslash, unless a query names another one (none here does) */
const LIKE_ESCAPE = '\\'
const LIKE_SPECIAL = /[\\%_]/g

/**
 * The value for Prisma's startsWith, contains or endsWith that matches exactly this text: a backslash before every \, %
 * and _, as Postgres LIKE and ILIKE read them by default.
 */
export function escapeLike(value: string): string {
  return value.replace(LIKE_SPECIAL, (special) => `${LIKE_ESCAPE}${special}`)
}
