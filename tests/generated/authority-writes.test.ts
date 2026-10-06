// Write-path policy generated from the code (spec §15.3 "นโยบาย", BR-DOA-17, EG-8): every place that writes
// PositionAssignment, Department.parentId or a Delegation is found by scanning src/ (counted here, never listed by
// hand), and each must be one of the paths the spec allows — the org-authority apply path, the immediate edits of
// positions without authority (which check positionHasAuthority first), the delegator's own delegation, and the
// demo seed. A new write anywhere else fails this test until it is routed through ORG_AUTHORITY_CHANGE.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const SRC = path.join(ROOT, 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return full.includes(`${path.sep}generated`) ? [] : sourceFiles(full)
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : []
  })
}

interface WriteSite {
  readonly file: string
  readonly line: number
  readonly model: 'positionAssignment' | 'department' | 'delegation'
  readonly op: string
  /** The call's argument text, up to its closing parenthesis */
  readonly call: string
  /** Offset of the call in the file */
  readonly at: number
}

const WRITE = /\.(positionAssignment|department|delegation)\.(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\(/g

/** The text of a call from its opening parenthesis to the matching closing one */
function callText(text: string, open: number): string {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return text.slice(open, i + 1)
  }
  return text.slice(open)
}

function scan(file: string, text: string): WriteSite[] {
  return [...text.matchAll(WRITE)].map((m) => ({
    file,
    line: text.slice(0, m.index).split('\n').length,
    model: m[1] as WriteSite['model'],
    op: m[2]!,
    call: callText(text, m.index + m[0].length - 1),
    at: m.index,
  }))
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/')
const files = sourceFiles(SRC).map((file) => ({ file: rel(file), text: readFileSync(file, 'utf8') }))
const sites = files.flatMap(({ file, text }) => scan(file, text))
const textOf = (file: string) => files.find((f) => f.file === file)!.text

const ORG_AUTHORITY = 'src/server/services/org-authority/index.ts'
const ORG_STRUCTURE = 'src/server/services/org-structure/index.ts'
const DELEGATIONS = 'src/server/services/delegations/index.ts'
const SEED = 'src/server/seed/org-structure.ts'

/** The enclosing defineCommand({...}) block of an offset, or null */
function commandAround(text: string, at: number): string | null {
  const start = text.lastIndexOf('defineCommand(', at)
  if (start < 0) return null
  const block = callText(text, start + 'defineCommand'.length)
  return start + block.length > at ? block : null
}

/** The enclosing top-level function (export function / async function / const … = async) of an offset */
function functionAround(text: string, at: number): string {
  const starts = [...text.slice(0, at).matchAll(/^(?:export )?(?:async )?function (\w+)|^(?:export )?const (\w+) = (?:async )?\(/gm)]
  const last = starts.at(-1)
  return last ? (last[1] ?? last[2] ?? '') : ''
}

describe('[§15.3] writes to position holders, department parents and delegations come only from the allowed paths', () => {
  it('finds the write sites (counted from the code)', () => {
    const count = (model: WriteSite['model']) => sites.filter((s) => s.model === model).length
    // There is something to check: holders are written by the apply path, the basic edits and the seed
    expect(count('positionAssignment')).toBeGreaterThanOrEqual(4)
    expect(count('department')).toBeGreaterThanOrEqual(3)
    expect(count('delegation')).toBeGreaterThanOrEqual(3)
  })

  it('PositionAssignment: the org-authority apply path, the edits of positions without authority, and the seed only', () => {
    for (const site of sites.filter((s) => s.model === 'positionAssignment')) {
      const where = `${site.file}:${site.line}`
      expect([ORG_AUTHORITY, ORG_STRUCTURE, SEED], where).toContain(site.file)
      if (site.file === ORG_AUTHORITY) expect(functionAround(textOf(site.file), site.at), where).toBe('applyChange')
    }
    // Every immediate edit checks first that the position carries no authority (FR-ADM-002 AC2): a write sits in a
    // command that called positionHasAuthority before it, or in the endCurrent helper, whose calls are such commands
    const text = textOf(ORG_STRUCTURE)
    const WRITES = /await endCurrent\(|\.positionAssignment\.(create|update|updateMany|upsert|delete|deleteMany)\(/g
    const writes = [...text.matchAll(WRITES)]
    expect(writes.length).toBeGreaterThanOrEqual(3)
    for (const m of writes) {
      const where = `${ORG_STRUCTURE} offset ${m.index}`
      const command = commandAround(text, m.index)
      if (command === null) {
        expect(functionAround(text, m.index), where).toBe('endCurrent')
        continue
      }
      const start = text.lastIndexOf('defineCommand(', m.index)
      const check = text.indexOf('positionHasAuthority(', start)
      expect(check, `${where}: positionHasAuthority before the write`).toBeGreaterThan(start)
      expect(check, where).toBeLessThan(m.index)
    }
  })

  it('Department.parentId: changed only by the org-authority apply path; a new department is a leaf (basic edit or seed)', () => {
    for (const site of sites.filter((s) => s.model === 'department')) {
      const where = `${site.file}:${site.line}`
      const touchesParent = /parentId/.test(site.call)
      if (site.op.startsWith('create')) {
        expect([ORG_STRUCTURE, SEED], where).toContain(site.file)
      } else if (touchesParent) {
        expect(site.file, where).toBe(ORG_AUTHORITY)
        expect(functionAround(textOf(site.file), site.at), where).toBe('applyChange')
      } else {
        expect([ORG_STRUCTURE, ORG_AUTHORITY], where).toContain(site.file)
      }
    }
  })

  it('Delegation: the delegator for themselves, or the org-authority apply path for someone else', () => {
    for (const site of sites.filter((s) => s.model === 'delegation')) {
      const where = `${site.file}:${site.line}`
      expect([DELEGATIONS, ORG_AUTHORITY], where).toContain(site.file)
      if (site.file === ORG_AUTHORITY) {
        expect(functionAround(textOf(site.file), site.at), where).toBe('applyChange')
        expect(site.call, where).toContain("createdVia: 'ORG_AUTHORITY_CHANGE'")
      } else if (site.op === 'create') {
        // The delegator is the member acting, never someone the actor names (GC-SOD-08)
        expect(site.call, where).toMatch(/delegatorMemberId: delegator\b/)
        expect(site.call, where).toContain("createdVia: 'SELF'")
        expect(textOf(site.file)).toContain("const delegator = ctx.actor.type === 'USER' ? ctx.actor.memberId : null")
      }
    }
  })

  it('no raw SQL writes these tables', () => {
    const raw = /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"(PositionAssignment|Department|Delegation)"/i
    for (const { file, text } of files) expect(raw.test(text), file).toBe(false)
  })

  it('the scanner sees a write it must refuse (canary)', () => {
    const found = scan('src/app/x.ts', 'await tx.positionAssignment.create({ data: { memberId } })\nawait db.department.update({ data: { parentId: p } })')
    expect(found.map((s) => [s.model, s.op, /parentId/.test(s.call)])).toEqual([
      ['positionAssignment', 'create', false],
      ['department', 'update', true],
    ])
  })
})

describe('[FR-DOA-007/AC3] a DOA version keeps the rules and policies it was approved with', () => {
  const VERSION_WRITE = /\.(doaVersion|doaRule)\.(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\(/g
  // What makes up a version's authority: its rules and its policies; changing one needs a new version (4-eyes, BR-DOA-08)
  const POLICY = /\b(sodPolicy|amountBasis|selfApprovalPolicy|collapseDuplicateApprovers|stepUpThresholdSatang|escalationPolicy|sourceYaml|checksum|versionNo|code)\b/

  /** The object after `data:` in a call, or '' */
  function dataOf(call: string): string {
    const at = call.indexOf('data:')
    if (at < 0) return ''
    const open = call.indexOf('{', at)
    let depth = 0
    for (let i = open; i < call.length; i++) {
      if (call[i] === '{') depth++
      else if (call[i] === '}' && --depth === 0) return call.slice(open, i + 1)
    }
    return call.slice(open)
  }

  const writes = files.flatMap(({ file, text }) =>
    [...text.matchAll(VERSION_WRITE)].map((m) => ({ file, line: text.slice(0, m.index).split('\n').length, model: m[1]!, op: m[2]!, call: callText(text, m.index + m[0].length - 1) })),
  )

  it('updates of a version touch its status, dates and approval fields only; rules are never changed or deleted', () => {
    expect(writes.filter((w) => w.model === 'doaVersion' && w.op.startsWith('update')).length).toBeGreaterThanOrEqual(3)
    for (const w of writes) {
      const where = `${w.file}:${w.line}`
      if (w.model === 'doaRule') {
        expect(w.op, where).toMatch(/^create/)
        continue
      }
      if (w.op.startsWith('create')) continue
      expect(w.op, where).not.toMatch(/^(delete|upsert)/)
      expect(POLICY.test(dataOf(w.call)), `${where} changes a rule or policy of an existing version`).toBe(false)
    }
  })

  it('reads the data part of a call (canary)', () => {
    expect(POLICY.test(dataOf("tx.doaVersion.update({ where: { code: c }, data: { status: 'PUBLISHED' } })"))).toBe(false)
    expect(POLICY.test(dataOf('tx.doaVersion.update({ where: { id }, data: { sodPolicy: relaxed } })'))).toBe(true)
  })
})
