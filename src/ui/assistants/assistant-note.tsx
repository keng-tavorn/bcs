import { AlarmClock, CalendarClock, Copy, Hourglass, ShieldAlert, Tag, Wallet } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { cn } from '../cn'
import { Button } from '../shadcn/button'
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '../shadcn/item'

// One thing an assistant of BCS found (NEW-121 · ADR-078), the same look wherever an assistant speaks: the icon of the
// work on a tinted ground, what was found, why, one way to the page where it is dealt with, and "ไม่ใช่เรื่องนี้". The
// tone is said by the words and the icon too, never by colour alone (§9.9). Sparkles is not used: §12.5 keeps it for
// words an AI wrote, and these come from the rules.

export const ASSISTANT_ICONS = { AlarmClock, Hourglass, Copy, Tag, CalendarClock, Wallet, ShieldAlert } as const
export type AssistantIcon = keyof typeof ASSISTANT_ICONS
export type AssistantTone = 'danger' | 'warn' | 'info'

const GROUND: Readonly<Record<AssistantTone, string>> = { danger: 'bg-danger-bg text-danger-ink', warn: 'bg-warn-bg text-warn-ink', info: 'bg-info-bg text-info-ink' }

export interface AssistantNoteView {
  readonly key: string
  readonly icon: AssistantIcon
  readonly tone: AssistantTone
  readonly title: string
  readonly why: string
  readonly action: { readonly href: string; readonly label: string }
}

export function AssistantNote({ note, dismiss }: { note: AssistantNoteView; dismiss?: ReactNode }) {
  const Icon = ASSISTANT_ICONS[note.icon]
  return (
    <Item role="listitem" size="sm" className="items-start rounded-none border-0 border-b border-line px-1 last:border-b-0" data-assistant-note={note.key}>
      <ItemMedia>
        <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-md', GROUND[note.tone])}>
          <Icon className="size-5" aria-hidden="true" />
        </span>
      </ItemMedia>
      <ItemContent className="min-w-0 gap-1">
        <ItemTitle className="text-base font-medium break-words text-ink md:text-sm">{note.title}</ItemTitle>
        <ItemDescription className="line-clamp-none text-base break-words text-ink-muted md:text-sm">{note.why}</ItemDescription>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" className="min-h-11 lg:min-h-9">
            <Link href={note.action.href}>{note.action.label}</Link>
          </Button>
          {dismiss}
        </div>
      </ItemContent>
    </Item>
  )
}
