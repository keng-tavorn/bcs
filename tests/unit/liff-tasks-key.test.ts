import { webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { newDecisionKey } from '@/ui/liff/tasks/key'

// S5-06 · the idempotencyKey of what the LIFF decision page sends — a decision, a question to the requester (spec §4.3,
// FR-PLT-012; FR-LINE-003 AC1 "in the LINE app on iOS and Android", AC2): the deciding commands take a uuid and nothing
// else (src/app/(workspace)/_tracking/commands.ts, z.uuid()), and a key they refuse is refused for good, as every retry
// sends another key of the same kind. So it is a uuid on every WebView of the LINE app, also one without
// crypto.randomUUID (iOS before 15.4, Android System WebView before 92). tests/e2e/liff-tasks.spec.ts decides on a page
// whose browser has no crypto.randomUUID.

/** The commands' check of the key */
const Key = z.uuid()

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('[FR-LINE-003/AC1] [FR-LINE-003/AC2] the key of a decision sent from LIFF is a uuid the commands take, on every WebView', () => {
  it('without crypto.randomUUID: a version-4 uuid made from 128 random bits, never the same twice', () => {
    vi.stubGlobal('crypto', { getRandomValues: (array: Uint8Array) => webcrypto.getRandomValues(array) })
    expect(typeof globalThis.crypto.randomUUID).toBe('undefined')
    const keys = Array.from({ length: 500 }, () => newDecisionKey())
    for (const key of keys) {
      expect(Key.safeParse(key).success, key).toBe(true)
      expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('with crypto.randomUUID: the uuid it makes', () => {
    const uuid = '6f1c2b0e-8d4a-4f3e-9b7c-2a5d8e1f0c3b'
    vi.stubGlobal('crypto', {
      randomUUID: () => uuid,
      getRandomValues: () => {
        throw new Error('not needed where randomUUID exists')
      },
    })
    expect(newDecisionKey()).toBe(uuid)
    vi.unstubAllGlobals()
    expect(Key.safeParse(newDecisionKey()).success).toBe(true)
  })

  it('32 hexadecimal digits without dashes — what a key made of random bits looks like unformatted — are refused by the commands', () => {
    expect(Key.safeParse('1281c94657cc99fd56ab2639b8e6595f').success).toBe(false)
  })
})
