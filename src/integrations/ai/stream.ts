import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'

// The answer of a question as the chat of @ai-sdk/react reads it (FR-AI-309 AC2, ADR-144): the sentences were checked
// one by one before anything is sent (BR-AI-27); they go out one after the other, with the tools' rows and links as a
// data part the chat draws as a table. Only this folder imports `ai` (P-3).

export function answerStreamResponse(answer: { readonly sentences: readonly string[]; readonly data: unknown }): Response {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: 'data-answer', data: answer.data } as never)
      if (answer.sentences.length === 0) return
      writer.write({ type: 'text-start', id: 'answer' })
      for (const sentence of answer.sentences) writer.write({ type: 'text-delta', id: 'answer', delta: `${sentence}\n` })
      writer.write({ type: 'text-end', id: 'answer' })
    },
  })
  return createUIMessageStreamResponse({ stream })
}
