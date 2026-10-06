import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createTranslator, type AbstractIntlMessages } from 'next-intl'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { saveLineChannelSettings, testLineConnection } from '@/server/services/line-channel'
import { createMember, createOrg } from '../support/factory'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET, withFakeLine } from '../support/fake-line'

// S5-01 · FR-ADM-006 AC3, the one reason tests/integration/line-channel-connection.test.ts cannot give: this BCS
// environment has no LIFF app (NEXT_PUBLIC_LIFF_ID and LINE_LIFF_CHANNEL_ID empty, ADR-024), so whatever LIFF ID the
// organization saved, the LIFF pages cannot open and liff.ts cannot verify a sign-in. The test must say so, not PASS.

// Emptied before any module reads the environment (getEnv() keeps what it read first), and put back after this file
const BEFORE = vi.hoisted(() => {
  const before = { NEXT_PUBLIC_LIFF_ID: process.env.NEXT_PUBLIC_LIFF_ID, LINE_LIFF_CHANNEL_ID: process.env.LINE_LIFF_CHANNEL_ID }
  process.env.NEXT_PUBLIC_LIFF_ID = ''
  process.env.LINE_LIFF_CHANNEL_ID = ''
  return before
})
afterAll(() => {
  for (const [name, value] of Object.entries(BEFORE)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

const NOW = new Date('2026-10-05T03:00:00Z')
withFakeLine()

describe('[FR-ADM-006/AC3] the LIFF check fails while this BCS environment has no LIFF app', () => {
  it('reports envNotSet with what to do, in Thai and English, whatever LIFF ID the organization saved', async () => {
    const org = await createOrg()
    const admin = await createMember(org.id, 'ผู้ดูแล')
    await prisma.roleAssignment.create({ data: { organizationId: org.id, memberId: admin.id, role: 'ORG_ADMIN', grantedAt: NOW } })
    const ctx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: admin.id }, channel: 'WEB', now: NOW })
    const values = { providerId: '1650000001', messagingChannelId: '1650000002', channelSecret: TEST_CHANNEL_SECRET, channelAccessToken: TEST_ACCESS_TOKEN, active: true }
    const saved = await saveLineChannelSettings(ctx, { ...values, liffId: '1650000003-AbCdEfGh', liffChannelId: '1650000003' }, { idempotencyKey: randomUUID(), sender: null })
    expect(saved.ok).toBe(true)

    const result = await testLineConnection(ctx)
    if (!result.ok) throw new Error(`connection test refused: ${result.error.code}`)
    const liff = result.data.checks.find((c) => c.id === 'liffId')!
    expect(liff).toEqual({ id: 'liffId', status: 'FAIL', reason: 'envNotSet', messageKey: 'checks.liffId.envNotSet', params: { liffId: '1650000003-AbCdEfGh' } })
    expect(result.data.passed).toBe(false)

    for (const locale of ['th', 'en'] as const) {
      const messages = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', '..', 'messages', `${locale}.json`), 'utf8')) as AbstractIntlMessages
      const problems: string[] = []
      const translate = createTranslator({ locale, messages, namespace: 'lineSettings', onError: (error) => problems.push(error.message) }) as unknown as (
        key: string,
        params: Record<string, string | number>,
      ) => string
      const text = translate(liff.messageKey, { ...liff.params })
      expect(problems, locale).toEqual([])
      expect(text, locale).toMatch(/NEXT_PUBLIC_LIFF_ID/)
      expect(text, locale).not.toMatch(/[{}]/)
    }
  })
})
