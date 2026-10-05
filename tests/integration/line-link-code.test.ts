import { createHash, createHmac, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { lineMessageProblems } from '@/integrations/line'
import { MS_PER_MINUTE, MS_PER_SECOND } from '@/lib/constants'
import { checkLineLinkCode, LINE_LINK_CODE_MAX_LENGTH, LINE_LINK_CODE_TTL_MS, lineLinkCodeHash, signLineLinkCode } from '@/server/line/link-code'
import { lineLinkedMessages } from '@/server/line/link-messages'

// S5-04 · the one-time link code of FR-LINE-001 AC1 (§9.2 step 1): an HMAC with BETTER_AUTH_SECRET over the
// organization, the member, the time it was issued and a nonce — nothing written when it is issued; 10 minutes on the
// security clock; one spelling per code, so its hash (what the link stores to spend it once) cannot be dodged. And the
// welcome BCS sends in the chat once linked, within LINE's limits.

const T0 = new Date('2026-10-05T03:00:00.000Z')
const subject = { organizationId: randomUUID(), memberId: randomUUID() }
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const parts = (code: string) => code.split('.')
const withPart = (code: string, index: number, value: string) => parts(code).map((p, i) => (i === index ? value : p)).join('.')

describe('[FR-LINE-001/AC1] the link code names its organization and member, lives 10 minutes and has one spelling', () => {
  it('reads back what it names, until 10 minutes after it was issued', () => {
    const { code, expiresAt } = signLineLinkCode(subject, T0)
    expect(code).toMatch(/^l1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}\.\d+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/)
    expect(code.length).toBeLessThanOrEqual(LINE_LINK_CODE_MAX_LENGTH)
    expect(expiresAt).toEqual(new Date(T0.getTime() + 10 * MS_PER_MINUTE))
    const read = { ok: true, ...subject, issuedAt: T0, expiresAt, codeHash: createHash('sha256').update(code).digest('hex') }
    expect(checkLineLinkCode(code, T0)).toEqual(read)
    expect(checkLineLinkCode(code, new Date(T0.getTime() + LINE_LINK_CODE_TTL_MS - 1))).toEqual(read)
    expect(checkLineLinkCode(code, new Date(T0.getTime() + LINE_LINK_CODE_TTL_MS))).toEqual({ ok: false, reason: 'EXPIRED' })
    // A server a few seconds behind still takes it; a code from further ahead is refused
    expect(checkLineLinkCode(code, new Date(T0.getTime() - 29 * MS_PER_SECOND))).toMatchObject({ ok: true })
    expect(checkLineLinkCode(code, new Date(T0.getTime() - 31 * MS_PER_SECOND))).toEqual({ ok: false, reason: 'EXPIRED' })
    expect(lineLinkCodeHash(code)).toBe(read.codeHash)
  })

  it('is new every time: two codes of one member differ, and so do their hashes', () => {
    const a = signLineLinkCode(subject, T0).code
    const b = signLineLinkCode(subject, T0).code
    expect(a).not.toBe(b)
    expect(lineLinkCodeHash(a)).not.toBe(lineLinkCodeHash(b))
  })

  it('refuses a changed part (NOT_VALID), another server’s signature (NOT_VALID) and any second spelling of a code (MALFORMED)', () => {
    const { code } = signLineLinkCode(subject, T0)
    const [, org, member, at, nonce, mac] = parts(code) as [string, string, string, string, string, string]
    const someone = Buffer.from(randomUUID().replace(/-/g, ''), 'hex').toString('base64url')
    expect(checkLineLinkCode(withPart(code, 2, someone), T0)).toEqual({ ok: false, reason: 'NOT_VALID' })
    expect(checkLineLinkCode(withPart(code, 1, someone), T0)).toEqual({ ok: false, reason: 'NOT_VALID' })
    expect(checkLineLinkCode(withPart(code, 3, String(Number(at) + 1)), T0)).toEqual({ ok: false, reason: 'NOT_VALID' })
    const otherServer = createHmac('sha256', 'another-server-secret').update(['bcs/line-link-code/v1', org, member, at, nonce].join('|')).digest('base64url')
    expect(checkLineLinkCode(withPart(code, 5, otherServer), T0)).toEqual({ ok: false, reason: 'NOT_VALID' })
    // The same bytes spelled another way: an unused low bit of the last character set
    const respell = (part: string) => part.slice(0, -1) + ALPHABET[ALPHABET.indexOf(part.at(-1)!) ^ 1]!
    for (const index of [1, 2, 4, 5]) {
      const changed = withPart(code, index, respell(parts(code)[index]!))
      expect(Buffer.from(parts(changed)[index]!, 'base64url')).toEqual(Buffer.from(parts(code)[index]!, 'base64url'))
      expect(checkLineLinkCode(changed, T0), `part ${index}`).toEqual({ ok: false, reason: 'MALFORMED' })
    }
    expect(checkLineLinkCode(withPart(code, 3, `0${at}`), T0)).toEqual({ ok: false, reason: 'MALFORMED' })
    expect(checkLineLinkCode(code.replace(/^l1\./, 'l2.'), T0)).toEqual({ ok: false, reason: 'MALFORMED' })
    expect(checkLineLinkCode(`${code}.x`, T0)).toEqual({ ok: false, reason: 'MALFORMED' })
    expect(checkLineLinkCode(code.slice(0, -1), T0)).toEqual({ ok: false, reason: 'MALFORMED' })
    expect(checkLineLinkCode(`${code}${'A'.repeat(LINE_LINK_CODE_MAX_LENGTH)}`, T0)).toEqual({ ok: false, reason: 'MALFORMED' })
    expect(checkLineLinkCode('', T0)).toEqual({ ok: false, reason: 'MALFORMED' })
    expect(mac).toHaveLength(43)
  })

  it('names organizations and members by their uuid only', () => {
    expect(() => signLineLinkCode({ organizationId: 'ORG-1', memberId: subject.memberId }, T0)).toThrow(TypeError)
    expect(() => signLineLinkCode({ organizationId: subject.organizationId, memberId: '../member' }, T0)).toThrow(TypeError)
  })
})

describe('[FR-LINE-001/AC1] the welcome BCS sends once linked fits LINE and names nobody (BR-NOTI-01)', () => {
  it('is within LINE’s limits, in Thai then English, without a name, an organization or a button', () => {
    const messages = lineLinkedMessages()
    expect(lineMessageProblems(messages)).toEqual([])
    expect(messages).toEqual([{ type: 'text', text: expect.stringContaining('ผูกบัญชี BCS กับ LINE นี้แล้ว') }])
    expect(JSON.stringify(messages)).toContain('Your BCS account is now linked to this LINE account.')
    // No action of any kind: in particular no postback, which would need an action token (BR-TOK-02)
    expect(JSON.stringify(messages)).not.toContain('postback')
  })
})
