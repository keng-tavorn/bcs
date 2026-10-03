import { describe, expect, it } from 'vitest'
import th from '../../messages/th.json'
import { MEMBER_ERROR_KEYS, memberErrorKey, memberErrorValues, toFailure, type AdminFailure } from '@/ui/admin/outcome'

// What an admin form says for each refusal (§9.9 rule 7: say what happened and how to fix it; §14.2 texts).

const failure = (code: string, extra: Partial<AdminFailure> = {}): AdminFailure => ({ ok: false, code, ...extra })

describe('[FR-ADM-001/AC1] admin forms explain every refusal', () => {
  it('an ended session asks to sign in again instead of "try again", which can never work', () => {
    expect(memberErrorKey(failure('UNAUTHENTICATED'))).toBe('UNAUTHENTICATED')
    expect(th.admin.members.errors.UNAUTHENTICATED).toMatch(/เข้าสู่ระบบอีกครั้ง/)
  })

  it('an unexpected error shows its §14.2 reference', () => {
    const f = toFailure({ code: 'INTERNAL', details: { requestId: 'req-123' } })
    expect(f.requestId).toBe('req-123')
    expect(memberErrorKey(f)).toBe('INTERNAL')
    expect(memberErrorValues(f)).toEqual({ requestId: 'req-123' })
    expect(th.admin.members.errors.INTERNAL).toContain('{requestId}')
  })

  it('a role that is no longer held is not reported as a missing member', () => {
    expect(memberErrorKey(failure('NOT_FOUND', { field: 'role' }))).toBe('ROLE_NOT_HELD')
    expect(memberErrorKey(failure('NOT_FOUND'))).toBe('NOT_FOUND')
  })

  it('a key reused with other input is its own message', () => {
    expect(memberErrorKey(failure('IDEMPOTENCY_CONFLICT'))).toBe('CONFLICT')
  })

  it('every key has a Thai message', () => {
    for (const key of MEMBER_ERROR_KEYS) expect(th.admin.members.errors[key], key).toBeTruthy()
  })
})
