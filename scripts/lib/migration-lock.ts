// Applied migrations are never edited or deleted (spec §6.3, §17.3). scripts/migrations.lock.json records the
// sha256 of every migration.sql (the same checksum Prisma stores in _prisma_migrations). What is committed — in HEAD,
// or in the commit where this branch left main — is frozen twice over: the lock entries committed there, and the
// migration.sql files committed there (read from git itself, so they are frozen even before the lock file is
// committed). Neither `prisma migrate reset` on the dev database nor a fresh CI database can hide an edit.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

export const LOCK_FILE = 'scripts/migrations.lock.json'
export const MIGRATIONS_DIR = 'prisma/migrations'

export type Checksums = Record<string, string>
export interface LockFile {
  comment: string
  migrations: Checksums
}
/** Checksums committed in one git ref: lock-file entries, or migration.sql blobs (by migration name). */
export interface CommittedLock {
  ref: string
  migrations: Checksums
}
export interface CommittedState {
  /** scripts/migrations.lock.json as committed in each ref that has it */
  locks: CommittedLock[]
  /** sha256 of every prisma/migrations/<name>/migration.sql committed in each ref */
  sql: CommittedLock[]
  /** the lock file in the working tree is the one committed in HEAD */
  lockCommitted: boolean
  notes: string[]
}

const COMMENT =
  'sha256 ของ prisma/migrations/<ชื่อ>/migration.sql · เพิ่มรายการด้วย pnpm exec tsx scripts/verify-db.ts lock · รายการที่ commit แล้วห้ามแก้หรือลบ (§17.3)'
const MIGRATION_SQL = /^prisma\/migrations\/([^/]+)\/migration\.sql$/

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

export function migrationChecksums(root: string): Checksums {
  const dir = path.join(root, MIGRATIONS_DIR)
  const sums: Checksums = {}
  if (!existsSync(dir)) return sums
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name, 'migration.sql')
    if (existsSync(file)) sums[name] = sha256(readFileSync(file))
  }
  return sums
}

export function parseLock(text: string): Checksums {
  const data = JSON.parse(text) as Partial<LockFile>
  const migrations = data.migrations ?? {}
  for (const [name, sum] of Object.entries(migrations)) {
    if (typeof sum !== 'string' || !/^[0-9a-f]{64}$/.test(sum)) throw new Error(`${LOCK_FILE}: checksum ของ ${name} ไม่ใช่ sha256`)
  }
  return migrations
}

export function readLock(root: string): Checksums | null {
  const file = path.join(root, LOCK_FILE)
  return existsSync(file) ? parseLock(readFileSync(file, 'utf8')) : null
}

export function formatLock(migrations: Checksums): string {
  const sorted = Object.fromEntries(Object.entries(migrations).sort(([a], [b]) => a.localeCompare(b)))
  return `${JSON.stringify({ comment: COMMENT, migrations: sorted }, null, 2)}\n`
}

function git(root: string, args: string[], input?: string): Buffer | null {
  const r = spawnSync('git', args, { cwd: root, input, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
  return r.status === 0 ? r.stdout : null
}

/** sha256 of every migration.sql committed in `ref`, read as the committed blob bytes (one `git cat-file --batch`). */
function committedMigrationSql(root: string, ref: string): Checksums {
  const tree = git(root, ['ls-tree', '-r', '-z', ref, '--', MIGRATIONS_DIR])?.toString('utf8') ?? ''
  const blobs: Array<{ name: string; id: string }> = []
  for (const entry of tree.split('\0')) {
    // "<mode> blob <id>\t<path>"
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(entry)
    const name = m ? MIGRATION_SQL.exec(m[2]!)?.[1] : undefined
    if (m && name) blobs.push({ name, id: m[1]! })
  }
  const sums: Checksums = {}
  if (blobs.length === 0) return sums
  const out = git(root, ['cat-file', '--batch'], `${blobs.map((b) => b.id).join('\n')}\n`)
  if (!out) throw new Error(`อ่าน migration ที่ commit ใน ${ref} จาก git ไม่ได้`)
  let at = 0
  for (const blob of blobs) {
    const headerEnd = out.indexOf(0x0a, at)
    const header = out.subarray(at, headerEnd).toString('utf8')
    const size = Number(/^[0-9a-f]+ blob (\d+)$/.exec(header)?.[1] ?? NaN)
    if (!Number.isFinite(size)) throw new Error(`git cat-file ตอบ "${header}" สำหรับ ${blob.name}`)
    sums[blob.name] = sha256(out.subarray(headerEnd + 1, headerEnd + 1 + size))
    at = headerEnd + 1 + size + 1
  }
  return sums
}

/**
 * What HEAD and the merge base with main have committed (read-only git): their lock files, their migration.sql
 * blobs, and whether the working-tree lock file is the committed one. Missing refs are skipped with a note.
 */
export function committedState(root: string, baseBranches = ['main', 'origin/main']): CommittedState {
  const notes: string[] = []
  const refs: string[] = []
  const head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])?.toString('utf8').trim()
  if (!head) notes.push('ไม่พบ git HEAD — ตรวจเฉพาะไฟล์กับ lock')
  else {
    refs.push('HEAD')
    const base = baseBranches.map((b) => git(root, ['merge-base', 'HEAD', b])?.toString('utf8').trim()).find(Boolean)
    if (base && base !== head) refs.push(base)
    else if (!base) notes.push(`ไม่พบ branch ${baseBranches.join(' หรือ ')} — ตรวจกับ HEAD เท่านั้น`)
  }
  const locks: CommittedLock[] = []
  const sql: CommittedLock[] = []
  let headLock: string | null = null
  for (const ref of refs) {
    const label = ref === 'HEAD' ? 'HEAD' : ref.slice(0, 8)
    const text = git(root, ['show', `${ref}:${LOCK_FILE}`])?.toString('utf8') ?? null
    if (ref === 'HEAD') headLock = text
    if (text !== null) locks.push({ ref: label, migrations: parseLock(text) })
    sql.push({ ref: label, migrations: committedMigrationSql(root, ref) })
  }
  const working = existsSync(path.join(root, LOCK_FILE)) ? readFileSync(path.join(root, LOCK_FILE), 'utf8') : null
  const normalize = (s: string) => s.replace(/\r\n/g, '\n')
  const lockCommitted = headLock !== null && working !== null && normalize(headLock) === normalize(working)
  return { locks, sql, lockCommitted, notes }
}

interface LockInput {
  files: Checksums
  lock: Checksums | null
  /** lock-file entries committed in HEAD / the merge base */
  committed: readonly CommittedLock[]
  /** migration.sql checksums committed in HEAD / the merge base */
  committedSql?: readonly CommittedLock[]
  /** strict (finish line): the lock file itself must be committed */
  strict?: boolean
  lockCommitted?: boolean
}

/** Every way the migration files, the lock file and what git has committed can disagree. */
export function migrationLockProblems(input: LockInput): string[] {
  const problems: string[] = []
  const lock = input.lock ?? {}
  if (!input.lock) problems.push(`ไม่มี ${LOCK_FILE} — รัน pnpm exec tsx scripts/verify-db.ts lock แล้ว commit ไฟล์นั้น`)
  for (const [name, sum] of Object.entries(lock)) {
    if (!(name in input.files)) problems.push(`migration ${name} ถูกลบหลังล็อก (ห้ามลบ migration ที่ apply แล้ว)`)
    else if (input.files[name] !== sum) problems.push(`migration ${name} ถูกแก้หลังล็อก (ห้ามแก้ migration ที่ apply แล้ว — สร้าง migration ใหม่แทน)`)
  }
  const unlocked = Object.keys(input.files).filter((name) => !(name in lock))
  if (input.lock && unlocked.length) {
    problems.push(`migration ใหม่ยังไม่ได้ล็อก: ${unlocked.join(', ')} — รัน pnpm exec tsx scripts/verify-db.ts lock แล้ว commit ${LOCK_FILE}`)
  }
  for (const { ref, migrations } of input.committed) {
    for (const [name, sum] of Object.entries(migrations)) {
      if (!(name in lock)) problems.push(`${LOCK_FILE} ลบรายการ ${name} ที่ commit แล้วใน ${ref}`)
      else if (lock[name] !== sum) problems.push(`${LOCK_FILE} แก้ checksum ของ ${name} ที่ commit แล้วใน ${ref}`)
    }
  }
  // A migration.sql committed in git is frozen even while the lock file is not committed yet
  for (const { ref, migrations } of input.committedSql ?? []) {
    for (const [name, sum] of Object.entries(migrations)) {
      if (!(name in input.files)) problems.push(`migration ${name} ที่ commit แล้วใน ${ref} ถูกลบ (ห้ามลบ migration ที่ apply แล้ว)`)
      else if (input.files[name] !== sum) problems.push(`migration ${name} ต่างจากที่ commit ใน ${ref} (ห้ามแก้ migration ที่ apply แล้ว — สร้าง migration ใหม่แทน)`)
      if (input.lock && name in lock && lock[name] !== sum) problems.push(`${LOCK_FILE} รายการ ${name} ต้องเป็น checksum ที่ commit ใน ${ref}`)
    }
  }
  if (input.strict && input.lockCommitted === false) {
    problems.push(`${LOCK_FILE} ยังไม่ได้ commit หรือมีการแก้ที่ยังไม่ commit — โหมด strict ต้องตรวจกับ lock ที่ commit แล้ว (commit พร้อม migration)`)
  }
  return problems
}

/**
 * The lock file after adding new migrations. Entries that are not committed yet follow the file (work in
 * progress on this machine); committed entries and committed migration.sql never change, so editing a committed
 * migration stays a problem.
 */
export function nextLock(input: LockInput): { lock: Checksums; problems: string[] } {
  const frozen: Checksums = {}
  for (const { migrations } of input.committed) Object.assign(frozen, migrations)
  for (const { migrations } of input.committedSql ?? []) for (const [name, sum] of Object.entries(migrations)) frozen[name] ??= sum
  const lock: Checksums = { ...frozen }
  for (const [name, sum] of Object.entries(input.files)) if (!(name in frozen)) lock[name] = sum
  const problems = migrationLockProblems({ ...input, lock, strict: false })
  return { lock, problems }
}
