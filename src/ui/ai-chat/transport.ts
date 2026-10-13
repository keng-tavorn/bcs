import type { UIMessage, UseChatOptions } from '@ai-sdk/react'

// The chat's way to POST /api/ai/ask (FR-AI-309 AC4, §5.5): the browser sends the messages and reads the answer's
// event stream back, chunk by chunk, as useChat expects. Written here because the AI SDK itself stays in the adapter
// (ADR-060): this file only speaks the stream's wire format, server-sent events of JSON chunks ending with [DONE].

export type AskTransport = NonNullable<Extract<UseChatOptions<UIMessage>, { transport?: unknown }>['transport']>
type Chunk = Awaited<ReturnType<AskTransport['sendMessages']>> extends ReadableStream<infer C> ? C : never

/** Server-sent events of JSON chunks into chunks: each event is `data: <json>`; `[DONE]` ends the stream */
export function sseChunks(): TransformStream<string, Chunk> {
  let buffer = ''
  return new TransformStream<string, Chunk>({
    transform(text, controller) {
      buffer += text
      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''
      for (const event of events) {
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice('data:'.length).trim()
          if (data && data !== '[DONE]') controller.enqueue(JSON.parse(data) as Chunk)
        }
      }
    },
  })
}

/** The error of an answer that did not stream: its code, as the chat's error message (a gate's, RATE_LIMITED, …) */
export class AskError extends Error {}

export function askTransport(api = '/api/ai/ask'): AskTransport {
  return {
    async sendMessages({ messages, chatId, abortSignal }) {
      const response = await fetch(api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: chatId, messages }), signal: abortSignal ?? null, credentials: 'same-origin' })
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null
        throw new AskError(body?.error?.code ?? 'FAILED')
      }
      return response.body.pipeThrough(new TextDecoderStream()).pipeThrough(sseChunks())
    },
    async reconnectToStream() {
      return null
    },
  }
}
