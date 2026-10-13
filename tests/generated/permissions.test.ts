// Permission tests generated from spec §2.4 (S1-08): the table is parsed from spec.md here, its capabilities and
// role × scope cells are counted by this test (never hard-coded), compared with src/server/authz/permissions.ts,
// and isAllowed() is checked against an independent reading of the spec — allow and deny for every capability.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isAllowed, type Principal, type ResourceScope } from '@/server/authz'
import { CAPABILITIES, PERMISSIONS, STORED_ROLES, type Capability, type Grant, type Scope } from '@/server/authz/permissions'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const spec = readFileSync(path.join(ROOT, 'spec.md'), 'utf8')

// ---------- parse §2.4 ----------

const section = spec.slice(spec.indexOf('### 2.4'), spec.indexOf('### 2.5'))
const rows = section
  .split('\n')
  .filter((l) => l.startsWith('| `'))
  .map((l) => l.split('|').map((c) => c.trim()))
  .map((cells) => ({ caps: [...cells[1]!.matchAll(/`([a-z][A-Za-z]*(?:\.[A-Za-z]+)+)`/g)].map((m) => m[1]!), grantees: cells[2]! }))

const ROLE_RE = /(?<![A-Z_])(PROCUREMENT|FINANCE|BUDGET_ADMIN|RECEIVER|EXECUTIVE|AUDITOR|ORG_ADMIN|DEPT_HEAD|PLATFORM_ADMIN)(?![A-Z_])/g
const SCOPE_RE = /(?<![A-Z_])(OWN|ASSIGNED|DEPT|ORG)(?![A-Z_])/g
// Phrases in §2.4 that mean "a member, by relation to the document" (requester, follower, assignee, delegator…)
const MEMBER_PHRASES = ['ทุก member', 'ผู้ขอ', 'ผู้ติดตาม', 'ผู้ได้รับงาน', 'ผู้มอบ', 'ผู้ตรวจรับที่ได้รับมอบหมาย']
const DOA_PHRASES = ['เฉพาะผู้ที่ DOA กำหนด', 'ตาม DOA ข้อ', 'เฉพาะผู้ที่ workflow ฉบับที่มีผลกำหนด']

// Reading rules for cells written as prose (each documented against the spec text):
// - a member segment without a scope in parentheses:
const MEMBER_SCOPE_WITHOUT_PARENS: Partial<Record<Capability, Scope>> = {
  'budget.view': 'OWN', // "ผู้ขอเห็นยอดคงเหลือของบรรทัดงบที่เลือกในฟอร์ม" — their own request form
  'gr.post': 'OWN', // "ผู้ขอของ PR ต้นทาง ถ้า sodPolicy.requesterMayReceive …" — requester of the source PR
  'supplier.view': 'ORG', // "ทุก member เห็นชื่อและข้อมูลพื้นฐาน" — every supplier, basic fields
}
// - roles named only to say they do NOT get the capability here:
const NOT_A_GRANT: Partial<Record<Capability, RegExp>> = {
  'delegation.manage': /ORG_ADMIN ตั้งแทนผู้อื่นได้ผ่าน/, // only through admin.orgAuthority.propose
}

type Key = string // "ROLE:FINANCE@ORG", "ANY_MEMBER@OWN", "DEPT_HEAD@DEPT", "PLATFORM_ADMIN@ORG", "DOA_ASSIGNEE@ASSIGNED"

function parseCell(cap: Capability, cell: string): Set<Key> {
  const keys = new Set<Key>()
  if (DOA_PHRASES.some((p) => cell.includes(p))) {
    keys.add('DOA_ASSIGNEE@ASSIGNED')
    return keys
  }
  for (const segment of cell.split(' · ')) {
    if (NOT_A_GRANT[cap]?.test(segment)) continue
    const head = segment.split(' — ')[0]!
    const paren = /\(([^)]*)\)/.exec(head)?.[1] ?? ''
    const scopes = [...paren.matchAll(SCOPE_RE)].map((m) => m[1] as Scope)
    const named = [...head.matchAll(ROLE_RE)].map((m) => m[1]!)
    for (const name of named) {
      const own = name === 'DEPT_HEAD' ? ['DEPT'] : scopes.length ? scopes : ['ORG']
      for (const scope of own) keys.add(name === 'DEPT_HEAD' || name === 'PLATFORM_ADMIN' ? `${name}@${scope}` : `ROLE:${name}@${scope}`)
    }
    if (named.length === 0 && MEMBER_PHRASES.some((p) => head.includes(p))) {
      const own = scopes.length ? scopes : [MEMBER_SCOPE_WITHOUT_PARENS[cap]]
      for (const scope of own) {
        if (!scope) throw new Error(`${cap}: member segment without a scope: ${segment}`)
        keys.add(`ANY_MEMBER@${scope}`)
      }
    }
  }
  return keys
}

const specTable = new Map<Capability, Set<Key>>()
for (const row of rows) for (const cap of row.caps) specTable.set(cap as Capability, parseCell(cap as Capability, row.grantees))

function grantKey(g: Grant): Key {
  const who = g.grantee.kind === 'ROLE' ? `ROLE:${g.grantee.role}` : g.grantee.kind
  return `${who}@${g.scope}`
}
const fileTable = new Map<Capability, Set<Key>>(CAPABILITIES.map((c) => [c, new Set((PERMISSIONS[c] as readonly Grant[]).map(grantKey))]))

// ---------- principals and resources ----------

const D1 = 'dept-1'
const D2 = 'dept-2'
const ME = 'me'
const member = (roles: readonly string[] = [], heads: readonly string[] = []): Principal => ({
  kind: 'member',
  memberId: ME,
  roles: new Set(roles) as never,
  headOfDepartmentIds: new Set(heads),
  departmentIds: new Set([D1]),
})
const PRINCIPALS: Array<[string, Principal]> = [
  ['plain member', member()],
  ...STORED_ROLES.map((r) => [`role ${r}`, member([r])] as [string, Principal]),
  ['DEPT_HEAD of dept-1', member([], [D1])],
  ['PLATFORM_ADMIN', { kind: 'platform', platformAdminId: 'pa' }],
  ['inactive member', { kind: 'inactive', memberId: ME }],
  ['system', { kind: 'system' }],
]
const RESOURCES: Array<[string, ResourceScope | undefined]> = [
  ['own document', { ownerMemberIds: [ME], departmentId: D2 }],
  ['assigned document', { ownerMemberIds: ['other'], assigneeMemberIds: [ME], departmentId: D2 }],
  ['task I may decide', { ownerMemberIds: ['other'], assigneeMemberIds: [ME], deciderMemberIds: [ME], departmentId: D2 }],
  ['document of dept-1', { ownerMemberIds: ['other'], departmentId: D1 }],
  ['unrelated document', { ownerMemberIds: ['other'], assigneeMemberIds: ['other'], deciderMemberIds: ['other'], departmentId: D2 }],
  ['no resource', undefined],
]

/** The spec's answer, from the parsed table only (independent of permissions.ts and isAllowed). */
function oracle(keys: Set<Key>, p: Principal, r: ResourceScope | undefined): boolean {
  for (const key of keys) {
    const [who, scope] = key.split('@') as [string, Scope]
    if (who === 'DOA_ASSIGNEE') {
      if (p.kind === 'member' && (r?.deciderMemberIds ?? []).includes(ME)) return true
      continue
    }
    if (who === 'PLATFORM_ADMIN') {
      if (p.kind === 'platform') return true
      continue
    }
    if (p.kind !== 'member') continue
    if (who.startsWith('ROLE:') && !p.roles.has(who.slice(5) as never)) continue
    if (who === 'DEPT_HEAD' && p.headOfDepartmentIds.size === 0) continue
    if (!r) return true
    if (scope === 'ORG') return true
    if (scope === 'OWN' && (r.ownerMemberIds ?? []).includes(ME)) return true
    if (scope === 'ASSIGNED' && (r.assigneeMemberIds ?? []).includes(ME)) return true
    if (scope === 'DEPT' && r.departmentId && (who === 'DEPT_HEAD' ? p.headOfDepartmentIds : p.departmentIds).has(r.departmentId)) return true
  }
  return false
}

// ---------- tests ----------

describe('[S1-08] spec §2.4 ↔ src/server/authz/permissions.ts', () => {
  it('finds every capability of §2.4 itself and the file has exactly those', () => {
    const fromSpec = [...specTable.keys()].sort()
    expect(fromSpec.length).toBeGreaterThan(40)
    expect([...fileTable.keys()].sort()).toEqual(fromSpec)
  })

  it('counts the same role × scope cells in both', () => {
    const count = (t: Map<Capability, Set<Key>>) => [...t.values()].reduce((n, s) => n + s.size, 0)
    expect(count(fileTable)).toBe(count(specTable))
  })

  it.each([...specTable.keys()].sort())('%s: grantees and scopes match the spec cell', (cap) => {
    expect([...fileTable.get(cap)!].sort()).toEqual([...specTable.get(cap)!].sort())
  })
})

describe('[BR-AUTH-01] isAllowed() follows §2.4 — allow and deny for every capability', () => {
  it.each([...specTable.keys()].sort())('%s', (cap) => {
    const keys = specTable.get(cap)!
    let allowed = 0
    let denied = 0
    for (const [pName, p] of PRINCIPALS) {
      for (const [rName, r] of RESOURCES) {
        const expected = oracle(keys, p, r)
        expect(isAllowed(p, cap, r), `${cap} · ${pName} · ${rName}`).toBe(expected)
        if (expected) allowed++
        else denied++
      }
    }
    expect(allowed, `${cap} has an allowed case`).toBeGreaterThan(0)
    expect(denied, `${cap} has a denied case`).toBeGreaterThan(0)
  })

  it('no role ever grants a decision: approval.decide and variance.decide need the task deciders', () => {
    for (const cap of ['approval.decide', 'variance.decide'] as const) {
      for (const r of STORED_ROLES) {
        expect(isAllowed(member([r]), cap)).toBe(false)
        expect(isAllowed(member([r]), cap, { ownerMemberIds: [ME], assigneeMemberIds: [ME], departmentId: D1 })).toBe(false)
      }
      expect(isAllowed(member(), cap, { deciderMemberIds: [ME] })).toBe(true)
    }
  })

  it('a capability that is not in the table is refused', () => {
    expect(isAllowed(member([...STORED_ROLES]), 'not.a.capability' as Capability)).toBe(false)
  })
})
