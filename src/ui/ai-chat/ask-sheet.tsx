'use client'

import { useChat, type UIMessage } from '@ai-sdk/react'
import { Send, Sparkles } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { onAskAi } from '../shell/shell-events'
import { Badge } from '../shadcn/badge'
import { Bubble, BubbleContent } from '../shadcn/bubble'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '../shadcn/input-group'
import { Marker, MarkerContent, MarkerIcon } from '../shadcn/marker'
import { Message, MessageContent, MessageHeader } from '../shadcn/message'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../shadcn/sheet'
import { AskError, askTransport, type AskTransport } from './transport'

// "ถาม BCS AI" (FR-AI-309 AC2 AC3, FR-AI-307 AC3 AC4, §12.5): the chat sheet ⌘K opens with the member's question. The
// answer streams in from POST /api/ai/ask — sentences checked one by one on the server — with the rows and links the
// tools returned; when a sentence failed, the rows alone as a table; nothing in the member's access → "ไม่พบข้อมูลใน
// สิทธิ์ของคุณ". The AI's label is --info with Sparkles; waiting is a role="status". Workspace only (ADR-052). The
// transport is a prop so a screen test streams scripted answers without a key (@shadcn/helpers, ADR-060).

interface AnswerData {
  readonly kind: 'ANSWER' | 'TABLE' | 'NOT_FOUND' | 'SCOPE'
  readonly tables: ReadonlyArray<{ readonly tool: string; readonly rows: ReadonlyArray<{ readonly href: string | null; readonly cells: ReadonlyArray<{ readonly key: string; readonly text: string }> }> }>
}

const textOf = (m: UIMessage) => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
const dataOf = (m: UIMessage): AnswerData | null => {
  const part = m.parts.find((p) => p.type === 'data-answer') as { data?: AnswerData } | undefined
  return part?.data ?? null
}

export function AskAiSheet({ transport }: { transport?: AskTransport }) {
  const t = useTranslations('aiAssist.ask')
  const chatTransport = useMemo(() => transport ?? askTransport(), [transport])
  const { messages, sendMessage, status, error } = useChat({ transport: chatTransport })
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')

  useEffect(
    () =>
      onAskAi((question) => {
        setOpen(true)
        void sendMessage({ text: question })
      }),
    [sendMessage],
  )

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const question = draft.trim()
    if (!question || status === 'submitted' || status === 'streaming') return
    setDraft('')
    void sendMessage({ text: question })
  }

  const cell = (key: string) => (t.has(`cells.${key}` as 'cells.number') ? t(`cells.${key}` as 'cells.number') : key)
  const errorCode = error instanceof AskError ? error.message : error ? 'FAILED' : null

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-info" aria-hidden="true" />
            {t('title')}
          </SheetTitle>
          <SheetDescription>{t('description')}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
          {messages.map((m) => {
            const mine = m.role === 'user'
            const data = mine ? null : dataOf(m)
            const said = textOf(m).trim()
            return (
              <Message key={m.id} align={mine ? 'end' : 'start'}>
                <MessageContent>
                  <MessageHeader className="flex items-center gap-2">
                    {mine ? (
                      t('you')
                    ) : (
                      <Badge variant="info">
                        <Sparkles aria-hidden="true" />
                        {t('ai')}
                      </Badge>
                    )}
                  </MessageHeader>
                  {said ? (
                    <Bubble variant={mine ? 'tinted' : 'muted'} align={mine ? 'end' : 'start'}>
                      <BubbleContent className="whitespace-pre-line">{said}</BubbleContent>
                    </Bubble>
                  ) : null}
                  {data?.kind === 'NOT_FOUND' ? <p>{t('notFound')}</p> : null}
                  {data?.kind === 'SCOPE' && !said ? <p>{t('scope')}</p> : null}
                  {data?.kind === 'TABLE' ? <p className="text-ink-muted">{t('tableNote')}</p> : null}
                  {data && data.tables.length ? (
                    <section aria-label={t('sources')} className="flex flex-col gap-2">
                      {data.tables.map((table) => (
                        <ul key={table.tool} className="flex flex-col divide-y divide-line rounded-md border border-line">
                          {table.rows.map((row, i) => (
                            <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 p-2">
                              <span className="flex min-w-0 flex-wrap gap-x-3">
                                {row.cells.map((c) => (
                                  <span key={c.key} className="break-words">
                                    <span className="text-ink-muted">{cell(c.key)}</span> {c.text}
                                  </span>
                                ))}
                              </span>
                              {row.href ? (
                                <a href={row.href} className="min-h-11 content-center font-medium text-primary underline underline-offset-4">
                                  {t('open')}
                                </a>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ))}
                    </section>
                  ) : null}
                </MessageContent>
              </Message>
            )
          })}
          {status === 'submitted' || status === 'streaming' ? (
            <Marker role="status">
              <MarkerIcon>
                <Sparkles aria-hidden="true" />
              </MarkerIcon>
              <MarkerContent>{t('thinking')}</MarkerContent>
            </Marker>
          ) : null}
          {errorCode ? (
            <p role="alert" className="text-danger">
              {t.has(`errors.${errorCode}` as 'errors.FAILED') ? t(`errors.${errorCode}` as 'errors.FAILED') : t('errors.FAILED')}
            </p>
          ) : null}
        </div>
        <form onSubmit={onSubmit} className="border-t border-line p-4">
          <InputGroup>
            <InputGroupInput aria-label={t('inputLabel')} placeholder={t('inputLabel')} maxLength={500} value={draft} onChange={(e) => setDraft(e.currentTarget.value)} />
            <InputGroupAddon align="inline-end">
              <InputGroupButton type="submit" aria-label={t('send')} size="icon-xs">
                <Send aria-hidden="true" />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
      </SheetContent>
    </Sheet>
  )
}
