import { argon2Sync, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PIN_HASH_PARAMS, PinHashError, hashPin, isCheckablePinHash, verifyPin } from '@/server/auth/pin'
import { keyId } from '@/server/crypto/secret-box'

// src/server/auth/pin.ts: the transaction PIN is stored as argon2id of Node 24 with a pepper from ENCRYPTION_KEY
// (FR-AUTH-005 AC1, NFR-SEC-09). Keys are passed in, so no environment is needed. The tag is recomputed here with
// node:crypto directly, from the documented parameters, so the test does not trust the code under test for them.

const KEY_A = new Uint8Array(32).fill(7)
const KEY_B = new Uint8Array(32).fill(9)
const ringA = { current: KEY_A }
const ringB = { current: KEY_B }
const PIN = '739164'
const STORED = /^\$argon2id\$v=19\$m=19456,t=2,p=1,keyid=([0-9a-f]{8})\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/

describe('[FR-AUTH-005/AC1] the PIN is stored as argon2id, never as itself', () => {
  it('uses the documented cost: argon2id, 19 MiB, 2 passes, 1 lane (OWASP)', () => {
    expect(PIN_HASH_PARAMS).toEqual({ memoryKib: 19_456, passes: 2, parallelism: 1 })
  })

  it('writes a PHC string with the key id, a 16-byte salt and a 32-byte tag, and no trace of the PIN', async () => {
    const stored = await hashPin(PIN, ringA)
    const m = STORED.exec(stored)
    expect(m, stored).not.toBeNull()
    expect(m![1]).toBe(keyId(KEY_A))
    expect(stored).not.toContain(PIN)
    // Recomputed independently: argon2id of the PIN with the stored salt, the documented cost and the pepper
    // HMAC-SHA256(key, "bcs/transaction-pin/argon2-secret/v1")
    const salt = Buffer.from(m![2]!, 'base64')
    const pepper = createHmac('sha256', KEY_A).update('bcs/transaction-pin/argon2-secret/v1').digest()
    const tag = argon2Sync('argon2id', { message: PIN, nonce: salt, parallelism: 1, tagLength: 32, memory: 19_456, passes: 2, secret: pepper })
    expect(tag.toString('base64').replace(/=+$/, '')).toBe(m![3])
  })

  it('salts every hash: the same PIN twice gives two different texts, and both check', async () => {
    const [one, two] = [await hashPin(PIN, ringA), await hashPin(PIN, ringA)]
    expect(one).not.toBe(two)
    expect(await verifyPin(PIN, one, ringA)).toBe(true)
    expect(await verifyPin(PIN, two, ringA)).toBe(true)
  })

  it('accepts only the right PIN', async () => {
    const stored = await hashPin(PIN, ringA)
    for (const wrong of ['739165', '000000', '73916', '7391640', '', 'abcdef', ' 739164']) expect(await verifyPin(wrong, stored, ringA), JSON.stringify(wrong)).toBe(false)
  })

  it('needs the key: a copy of the database alone checks no guess (the pepper is not stored)', async () => {
    const stored = await hashPin(PIN, ringA)
    // The same text under another key's id does not check, even with the right PIN
    const relabelled = stored.replace(/keyid=[0-9a-f]{8}/, `keyid=${keyId(KEY_B)}`)
    expect(await verifyPin(PIN, relabelled, ringB)).toBe(false)
    // A key the server no longer holds: the PIN cannot be checked and must be set again
    await expect(verifyPin(PIN, stored, ringB)).rejects.toMatchObject({ name: 'PinHashError', reason: 'UNKNOWN_KEY' })
    // After a rotation the old key, kept as previous, still checks the PINs it made
    expect(await verifyPin(PIN, stored, { current: KEY_B, previous: [KEY_A] })).toBe(true)
  })

  it('refuses a stored text that is damaged or asks for an unreasonable cost, before running Argon2', async () => {
    const stored = await hashPin(PIN, ringA)
    // The tag's last character carries 2 spare bits that must be zero; setting one gives the same bytes, spelled otherwise
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const respelled = `${stored.slice(0, -1)}${B64[B64.indexOf(stored.at(-1)!) + 1]}`
    const damaged = [
      respelled,
      stored.replace('$argon2id$', '$argon2i$'),
      stored.replace('v=19', 'v=16'),
      stored.replace(/,keyid=[0-9a-f]{8}/, ''),
      stored.replace('m=19456', 'm=99999999'),
      stored.replace('m=19456', 'm=4'),
      stored.replace('t=2', 't=0'),
      stored.replace('t=2', 't=999'),
      stored.replace('p=1', 'p=0'),
      stored.replace('p=1', 'p=64'),
      stored.slice(0, -2),
      `${stored.slice(0, -1)}=`,
      '',
      'not a hash',
    ]
    for (const text of damaged) {
      await expect(verifyPin(PIN, text, ringA), text).rejects.toBeInstanceOf(PinHashError)
      await expect(verifyPin(PIN, text, ringA), text).rejects.toMatchObject({ reason: 'MALFORMED' })
    }
  })

  it('tells without running Argon2 whether a stored text can be checked here, as the step-up asks before it counts a try', async () => {
    const stored = await hashPin(PIN, ringA)
    expect(isCheckablePinHash(stored, ringA)).toBe(true)
    expect(isCheckablePinHash(stored, { current: KEY_B, previous: [KEY_A] }), 'the old key kept after a rotation').toBe(true)
    expect(isCheckablePinHash(stored, ringB), 'a key the server no longer holds').toBe(false)
    for (const damaged of ['', 'not a hash', stored.replace('m=19456', 'm=99999999'), stored.replace('$argon2id$', '$argon2i$'), stored.slice(0, -2)]) {
      expect(isCheckablePinHash(damaged, ringA), damaged).toBe(false)
    }
  })

  it('refuses to hash anything but six digits, without repeating it', async () => {
    for (const value of ['12345', '1234567', 'abcdef', ' 739164']) {
      const error = await hashPin(value, ringA).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(TypeError)
      expect((error as Error).message).not.toContain(value.trim())
    }
  })
})
