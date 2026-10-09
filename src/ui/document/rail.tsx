import Link from 'next/link'
import type { ReactNode } from 'react'
import { Card, CardContent } from '../shadcn/card'
import { Message, MessageContent, MessageGroup, MessageHeader } from '../shadcn/message'
import { StatusBadge, type BadgeLook } from './badges'

// The right column of the document page (FR-INT-012 AC2, §9.10 "แถบขวา") and the PO cards of the overview: the summary as
// pairs of label and value (with the attachments, so a decision can be made on one screen), the comments, and a PO with
// its number, amount and status. Strings arrive translated; cards have a 1 px --line border and no shadow (§9.9).

export interface SummaryPair {
  readonly label: string
  readonly value: ReactNode
}

export function SummaryList({ items, label }: { items: readonly SummaryPair[]; label: string }) {
  return (
    <dl aria-label={label} className="flex flex-col divide-y divide-line border-y border-line">
      {items.map((item) => (
        <div key={item.label} className="flex flex-col gap-0.5 py-2.5">
          <dt className="text-base text-ink-muted md:text-sm">{item.label}</dt>
          <dd className="min-w-0 break-words text-ink">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export interface CommentItem {
  readonly key: string
  readonly kind: string
  readonly text: string
  readonly by: string
}

export function CommentList({ comments, label, empty }: { comments: readonly CommentItem[]; label: string; empty: string }) {
  if (comments.length === 0) return <p className="text-ink-muted">{empty}</p>
  return (
    <MessageGroup role="list" aria-label={label} className="gap-4">
      {comments.map((c) => (
        <Message key={c.key} role="listitem" className="text-base md:text-sm">
          <MessageContent className="flex min-w-0 flex-col gap-1">
            <MessageHeader className="flex flex-wrap gap-x-2 text-ink-muted">
              <span className="font-medium text-ink">{c.kind}</span>
              <span>{c.by}</span>
            </MessageHeader>
            <p className="rounded-md border border-line bg-surface px-3 py-2 break-words whitespace-pre-line text-ink">{c.text}</p>
          </MessageContent>
        </Message>
      ))}
    </MessageGroup>
  )
}

export interface PoCardView {
  readonly id: string
  readonly title: string
  readonly href: string | null
  readonly amount: string
  readonly badge: { readonly look: BadgeLook | undefined; readonly label: string }
  readonly lines?: readonly string[]
}

export function PoCards({ pos, label }: { pos: readonly PoCardView[]; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-col gap-3">
      {pos.map((po) => (
        <li key={po.id}>
          <Card className="gap-1 rounded-md border border-line py-3 shadow-none ring-0">
            <CardContent className="flex flex-col gap-1 px-3 text-base md:text-[0.9375rem]">
              <div className="flex flex-wrap items-start justify-between gap-2">
                {po.href ? (
                  <Link href={po.href} className="font-semibold text-primary underline underline-offset-4 hover:no-underline">
                    {po.title}
                  </Link>
                ) : (
                  <span className="font-semibold text-ink">{po.title}</span>
                )}
                <StatusBadge look={po.badge.look} label={po.badge.label} />
              </div>
              <p className="tabular text-ink">{po.amount}</p>
              {(po.lines ?? []).map((line) => (
                <p key={line} className="text-ink-muted">
                  {line}
                </p>
              ))}
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  )
}
