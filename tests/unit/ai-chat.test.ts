import { Chat } from '@ai-sdk/react'
import { createChat } from '@shadcn/helpers/ai-sdk'
import { describe, expect, it } from 'vitest'
import { answerStreamResponse } from '@/integrations/ai'
import { sseChunks } from '@/ui/ai-chat/transport'

// S13-10 (FR-AI-309 AC2, ADR-060): the chat of "ถาม BCS AI" streams the answer and its rows, tested without a key — the
// scripted transport of @shadcn/helpers plays the answer — and the browser's reader of POST /api/ai/ask reads back
// exactly what the server's stream wrote.

const answer = { kind: 'ANSWER', tables: [{ tool: 'my_requests', rows: [{ href: '/requests/r1', cells: [{ key: 'number', text: 'PR-2569-00001' }] }] }] }

describe('[FR-AI-309/AC2] the chat streams the sentences and the rows, no key needed', () => {
  it('a scripted answer reaches the chat as text and the answer data', async () => {
    const script = createChat().user('ฉันมีคำขออะไรบ้าง').assistant(({ writer }) => {
      writer.data({ type: 'data-answer', data: answer } as never).text('คุณมีคำขอ 1 รายการ')
    })
    const chat = new Chat({ transport: script.transport({ delayMs: undefined }) })
    await chat.sendMessage({ text: 'ฉันมีคำขออะไรบ้าง' })
    const reply = chat.messages.at(-1)!
    expect(reply.role).toBe('assistant')
    expect(reply.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')).toBe('คุณมีคำขอ 1 รายการ')
    expect(reply.parts.find((p) => p.type === 'data-answer')).toMatchObject({ data: answer })
  })

  it('the reader of the browser reads the server stream back chunk by chunk', async () => {
    const response = answerStreamResponse({ sentences: ['ประโยคแรก', 'ประโยคสอง'], data: answer })
    const reader = response.body!.pipeThrough(new TextDecoderStream()).pipeThrough(sseChunks()).getReader()
    const chunks: Array<{ type: string; delta?: string; data?: unknown }> = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value as never)
    }
    expect(chunks.find((c) => c.type === 'data-answer')).toMatchObject({ data: answer })
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta)).toEqual(['ประโยคแรก\n', 'ประโยคสอง\n'])
    const empty = answerStreamResponse({ sentences: [], data: { kind: 'NOT_FOUND', tables: [] } })
    expect(await empty.text()).not.toContain('text-delta')
  })
})
