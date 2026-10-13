import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ERROR_CODES, HTTP_STATUS } from '@/core/result'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import '@/server/events/schemas'
import { getEventDefinition } from '@/server/events/registry'
import { AiAssistInput, applyAiAssist, assertNoPendingAiReview } from '@/server/services/ai/assist-contract'

// The shared contracts P1-07 lays for the lanes (docs/sub-specs/P1.md "สัญญากลางอื่น"): request.drafted version 2,
// the empty AI-assist contract (BR-AI-17 of S13), the error AI_REVIEW_PENDING (§14.2) and the numbering keys one per
// line. gr.post's new fields are tested with the database in tests/integration/receiving.test.ts.

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const tx = {} as TenantTx
const ctx = {} as Ctx
const subject = { type: 'GOODS_RECEIPT', id: '0199a000-0000-7000-8000-000000000001' }
const assist = { agentActionId: '0199a000-0000-7000-8000-000000000002', confirmedPaths: ['lines.0.received'] }

describe('[P1-07] request.drafted version 2 (source, agentActionId)', () => {
  const def = getEventDefinition('request.drafted')!

  it('is version 2 and still reads a version 1 event, whose source is MANUAL', () => {
    expect(def.schemaVersion).toBe(2)
    expect(def.schema.parse({ requestTypeCode: 'BUY_GOODS', lines: 1 })).toEqual({ requestTypeCode: 'BUY_GOODS', lines: 1, source: 'MANUAL' })
  })

  it('takes the sources of S6 S13 S17 and refuses others', () => {
    for (const source of ['REORDER', 'RENEWAL', 'CHAT_INTAKE']) expect(def.schema.safeParse({ requestTypeCode: 'X', lines: 0, source }).success).toBe(true)
    expect(def.schema.parse({ requestTypeCode: 'X', lines: 0, source: 'CHAT_INTAKE', agentActionId: assist.agentActionId })).toMatchObject({ agentActionId: assist.agentActionId })
    expect(def.schema.safeParse({ requestTypeCode: 'X', lines: 0, source: 'EMAIL' }).success).toBe(false)
    expect(def.schema.safeParse({ requestTypeCode: 'X', lines: 0, agentActionId: 'not-a-uuid' }).success).toBe(false)
  })
})

describe('[P1-07] the empty AI-assist contract until S13 (assist-contract.ts)', () => {
  it('no input changes nothing; an input before S13 is MODULE_DISABLED; nothing is ever pending', async () => {
    expect(await applyAiAssist(tx, ctx, subject)).toEqual({ ok: true, data: [] })
    expect(await applyAiAssist(tx, ctx, subject, assist)).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED', details: { module: 'AI' } } })
    expect(await assertNoPendingAiReview(tx, ctx, subject)).toEqual({ ok: true, data: true })
    expect(AiAssistInput.safeParse({ ...assist, extra: 1 }).success).toBe(false)
  })

  it('AI_REVIEW_PENDING is in ERROR_CODES (409) with words in Thai and English', () => {
    expect(ERROR_CODES).toContain('AI_REVIEW_PENDING')
    expect(HTTP_STATUS.AI_REVIEW_PENDING).toBe(409)
    for (const lang of ['th', 'en']) {
      const errors = JSON.parse(readFileSync(path.join(ROOT, `messages/src/${lang}/errors.json`), 'utf8')) as Record<string, string>
      expect(errors.AI_REVIEW_PENDING).toContain('{count}')
    }
  })
})

describe('[P1-07] lists the lanes add to keep one entry per line', () => {
  it('numbering in org-settings.ts has one key per line, sorted', () => {
    const text = readFileSync(path.join(ROOT, 'src/lib/org-settings.ts'), 'utf8')
    const block = /numbering: z\n\s+\.object\(\{\n([\s\S]*?)\n\s+\}\)/.exec(text)![1]!
    // A key a lane adds is optional (S6 BT OB): numberingRule.optional()
    const keys = block.split('\n').map((l) => /^\s+([A-Z_]+): numberingRule(?:\.optional\(\))?,$/.exec(l)?.[1])
    expect(keys.every(Boolean)).toBe(true)
    expect(keys).toEqual([...keys].sort())
  })
})
