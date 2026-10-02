import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createLogger, scrubText } from '@/lib/logger'

// NFR-SEC-09: logs must never contain passwords, PINs, tokens, secrets, full bank account numbers or national
// ID numbers. Every secret below is planted somewhere a careless log call could put it.
function capture() {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(chunk.toString())
      done()
    },
  })
  return { logger: createLogger(stream, 'trace'), output: () => lines.join('') }
}

const SECRETS = {
  password: 'Sup3rS3cret!pass',
  pin: '482913',
  sessionToken: 'sess_9f8e7d6c5b4a3210',
  channelSecret: 'chsec_abcdef0123456789',
  bankAccount: '1234567890',
  nationalId: '1101700203451',
  actionSecret: 'Zx9QmA7LkP2wR5tY',
  bearer: 'eyJhbGciOiJIUzI1NiJ9.payload.sig',
}

describe('[NFR-SEC-09] logger redaction', () => {
  it('redacts sensitive keys at any depth', () => {
    const { logger, output } = capture()
    logger.info(
      {
        user: { email: 'a@demo.bcs.local', password: SECRETS.password, profile: { pin: SECRETS.pin } },
        auth: { token: SECRETS.sessionToken, nested: [{ channelSecret: SECRETS.channelSecret }] },
        payee: { bankAccountNumber: SECRETS.bankAccount, nationalId: SECRETS.nationalId },
        headers: { authorization: `Bearer ${SECRETS.bearer}`, cookie: 'better-auth.session_token=abc' },
      },
      'member updated',
    )
    const out = output()
    for (const value of Object.values(SECRETS)) expect(out).not.toContain(value)
    expect(out).toContain('a@demo.bcs.local')
    expect(out).toContain('member updated')
  })

  it('scrubs secrets inside free text, messages and errors', () => {
    const { logger, output } = capture()
    logger.warn(`opened /a/0193f1a2-7c00-7000-8000-000000000001.${SECRETS.actionSecret} with account ${SECRETS.bankAccount}`)
    logger.error({ err: new Error(`bad citizen id ${SECRETS.nationalId} token=${SECRETS.sessionToken}`) }, 'failed')
    logger.info({ url: `https://x.example.com/cb?code=abc&token=${SECRETS.sessionToken}`, note: `Bearer ${SECRETS.bearer}` })
    const out = output()
    for (const value of [SECRETS.actionSecret, SECRETS.bankAccount, SECRETS.nationalId, SECRETS.sessionToken, SECRETS.bearer]) {
      expect(out).not.toContain(value)
    }
  })

  it('logs BigInt money and child bindings without throwing', () => {
    const { logger, output } = capture()
    logger.child({ requestId: 'req-1', organizationId: 'org-1' }).info({ amountSatang: 4494000n }, 'reserved')
    const line = JSON.parse(output().trim()) as Record<string, unknown>
    expect(line).toMatchObject({ requestId: 'req-1', organizationId: 'org-1', amountSatang: '4494000', msg: 'reserved' })
  })

  it('leaves ordinary text alone', () => {
    expect(scrubText('PR-2569-00001 approved by VP for 45,000.00 baht')).toBe('PR-2569-00001 approved by VP for 45,000.00 baht')
  })
})
