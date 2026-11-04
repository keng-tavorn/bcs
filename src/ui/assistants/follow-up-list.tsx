import { AlarmClock, Hourglass } from 'lucide-react'
import Link from 'next/link'
import { cn } from '../cn'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '../shadcn/item'
import { FollowUpDraft, type FollowUpDraftView, type SendFollowUp } from './follow-up-draft'

// The rows of the follow-up assistant (NEW-124 · ADR-082) in the look of ADR-078: the icon of the work on a tinted
// ground (an alarm clock past the due time, an hourglass before it — said in the words too, never by colour alone), the
// document and its due time, why it still waits, and the nudge a person may draft and send. Nothing opens by itself
// (NG-13): a draft opens when pressed, or when a link to it was followed. Strings arrive translated.

export interface FollowUpItemView {
  readonly taskId: string
  /** The row's anchor (the home card and the document's panel link to it) */
  readonly anchor: string
  readonly overdue: boolean
  readonly title: string
  readonly href: string
  readonly open: string
  readonly due: string
  readonly relation: string
  readonly reasons: readonly string[]
  /** Why a nudge may not go now and when it may; null: it may */
  readonly hold: string | null
  readonly draft: FollowUpDraftView
}

const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline lg:min-h-9'

export function FollowUpList({ items, label, reasons, send }: { items: readonly FollowUpItemView[]; label: string; reasons: string; send: SendFollowUp }) {
  return (
    <ItemGroup aria-label={label} className="gap-0">
      {items.map((item) => {
        const Icon = item.overdue ? AlarmClock : Hourglass
        return (
          <Item key={item.taskId} id={item.anchor} role="listitem" size="sm" className="scroll-mt-24 items-start rounded-none border-0 border-b border-line px-1 py-4 last:border-b-0" data-follow-up={item.taskId}>
            <ItemMedia>
              <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-md', item.overdue ? 'bg-danger-bg text-danger-ink' : 'bg-warn-bg text-warn-ink')}>
                <Icon className="size-5" aria-hidden="true" />
              </span>
            </ItemMedia>
            <ItemContent className="min-w-0 gap-2">
              <ItemTitle className="text-base font-medium break-words text-ink">
                <h3>{item.title}</h3>
              </ItemTitle>
              <ItemDescription className="line-clamp-none text-base break-words text-ink md:text-sm">
                <span className={item.overdue ? 'font-medium text-danger' : 'font-medium text-warn-ink'}>{item.due}</span>
                <span className="text-ink-muted"> · {item.relation}</span>
              </ItemDescription>
              <ul aria-label={reasons} className="flex list-disc flex-col gap-1 pl-5 text-base text-ink-muted md:text-sm">
                {item.reasons.map((r) => (
                  <li key={r} className="break-words">
                    {r}
                  </li>
                ))}
              </ul>
              <div className="flex flex-col gap-2">
                <Link href={item.href} className={cn(linkClass, 'self-start')}>
                  {item.open}
                </Link>
                <FollowUpDraft view={item.draft} hold={item.hold} send={send} />
              </div>
            </ItemContent>
          </Item>
        )
      })}
    </ItemGroup>
  )
}
