import { describe, expect, it, vi } from 'vitest'
import { err } from '@/core/result'
import { prisma } from '@/server/db/client'
import { apOrg, codedDraft, receive, sentPo, submit } from '../support/ap'

// S8-03 · BR-AP-03: invoice.submit asks the AI-review gate of assist-contract.ts first. Until S13 the gate always says
// ok, so this test puts a gate that answers AI_REVIEW_PENDING in its place: the invoice is not submitted, gets no
// number and moves no money.

vi.mock('@/server/services/ai/assist-contract', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/services/ai/assist-contract')>()
  // Only the invoice's gate answers so: the request and the PO of the setup go through the real one (S13-03)
  return {
    ...original,
    assertNoPendingAiReview: vi.fn(async (...args: Parameters<typeof original.assertNoPendingAiReview>) =>
      args[2].type === 'INVOICE' ? err('AI_REVIEW_PENDING', 'values wait for review', { count: 2 }) : original.assertNoPendingAiReview(...args),
    ),
  }
})

describe('[FR-AP-101/AC5] values the AI filled in and nobody confirmed stop the submit (AI_REVIEW_PENDING)', () => {
  it('refuses the submit and writes nothing', async () => {
    const ap = await apOrg()
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    await receive(ap, po, { 0: '1' })
    const draft = await codedDraft(ap, po, { no: 'AIG-1', vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })
    expect(await submit(ap, draft)).toMatchObject({ ok: false, error: { code: 'AI_REVIEW_PENDING', details: { count: 2 } } })
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: draft.invoiceId } })).toMatchObject({ status: 'DRAFT', number: null })
  })
})
