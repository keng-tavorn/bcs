'use client'

import { AlarmClock, FileOutput, FilePen, MessageCircleQuestion, PackageCheck, Receipt, Send, ShoppingCart, Undo2 } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { cn } from '../cn'

// "สิ่งที่ต้องทำ" (spec §9.10, FR-VIS-006 AC2): one row per kind of work, each its icon on a tinted ground, what waits and
// how many, the whole row a link to the list of exactly those — the most pressing first, six at most with "ดูทั้งหมด" for
// the rest. The tone is said by the words and the icon too, never by colour alone (§9.9).

export const TODO_ICONS = { AlarmClock, Undo2, MessageCircleQuestion, PackageCheck, ShoppingCart, Send, Receipt, FileOutput, FilePen } as const

export interface TodoRowView {
  readonly key: string
  readonly href: string
  readonly text: string
  readonly icon: keyof typeof TODO_ICONS
  readonly tone: 'danger' | 'warn' | 'neutral'
}

/** Rows shown before "ดูทั้งหมด" (§9.10) */
export const TODO_SHOWN = 6

const ICON_GROUND = { danger: 'bg-danger-bg text-danger-ink', warn: 'bg-warn-bg text-warn-ink', neutral: 'bg-primary-tint text-primary' } as const

export function TodoList({ rows, label, more, less }: { rows: readonly TodoRowView[]; label: string; more: string; less: string }) {
  const [all, setAll] = useState(false)
  const shown = all ? rows : rows.slice(0, TODO_SHOWN)
  return (
    <div className="flex flex-col gap-2">
      <ul aria-label={label} className="flex flex-col">
        {shown.map((row) => {
          const Icon = TODO_ICONS[row.icon]
          return (
            <li key={row.key} className="border-b border-line last:border-b-0">
              <Link href={row.href} className="flex min-h-12 items-center gap-3 rounded-md px-1 py-2 text-ink hover:bg-primary-tint">
                <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-md', ICON_GROUND[row.tone])}>
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <span className="font-medium underline-offset-4 hover:underline">{row.text}</span>
              </Link>
            </li>
          )
        })}
      </ul>
      {rows.length > TODO_SHOWN ? (
        <button type="button" aria-expanded={all} onClick={() => setAll(!all)} className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
          {all ? less : more}
        </button>
      ) : null}
    </div>
  )
}
