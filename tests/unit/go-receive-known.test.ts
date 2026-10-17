import { beforeEach, describe, expect, it, vi } from 'vitest'

// BR-APP-06 on a shared phone (ADR-073 pre-review): the PO versions a member's own receipts were answered with lift only
// that member's receipts recorded on an older copy. Before, one map for the whole phone let member 2's receipt lift
// member 1's stale receipt of the same goods past CONFLICT_VERSION, and the goods were received twice.

const kv = new Map<string, unknown>()
vi.mock('idb-keyval', () => ({
  createStore: () => 'store',
  get: async (key: string) => kv.get(key),
  set: async (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
  del: async (key: string) => void kv.delete(key),
}))

const { forgetMember, readKnown, writeKnown } = await import('@/ui/go-receive/store')

beforeEach(() => kv.clear())

describe('[BR-APP-06] the versions a phone knows are each member\'s own', () => {
  it('member 2\'s answered receipt is not member 1\'s: member 1\'s receipt keeps the version of its own copy', async () => {
    expect(await writeKnown('M2', { 'PO-X': 6 })).toBe(true)
    expect(await readKnown('M1')).toEqual({})
    expect(await readKnown('M2')).toEqual({ 'PO-X': 6 })
    await writeKnown('M1', { 'PO-Y': 2 })
    expect(await readKnown('M2')).toEqual({ 'PO-X': 6 })
  })

  it('a map kept before members (versions by PO alone) counts as none; signing a member out forgets theirs', async () => {
    kv.set('sent-versions', { 'PO-X': 6 })
    expect(await readKnown('M1')).toEqual({})
    await writeKnown('M1', { 'PO-X': 4 })
    await writeKnown('M2', { 'PO-X': 6 })
    // member 1 still has a receipt waiting on the phone (with none left, every member's versions go)
    kv.set('queue', [{ key: 'k1', by: 'M1', poId: 'PO-X', photos: [] }])
    await forgetMember('M2')
    expect(await readKnown('M2')).toEqual({})
    expect(await readKnown('M1')).toEqual({ 'PO-X': 4 })
  })
})
