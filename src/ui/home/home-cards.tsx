import { ArrowDownRight, ArrowUpRight, Equal } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { REQUEST_BADGES, StatusBadge } from '../document/badges'
import { Card, CardContent, CardHeader, CardTitle } from '../shadcn/card'
import { Skeleton } from '../shadcn/skeleton'

// The cards of the home page (spec §9.10 "หน้าแรก", FR-VIS-006): white cards with a 1 px border on the page's --surface,
// each titled at 16 px weight 600, each loading on its own behind a skeleton (AC6). "งานอนุมัติทันเวลา" says each
// percent with an arrow and words — up, down or the same — never colour alone (AC3); "ที่ฉันติดตาม" lists the requests
// that moved last with their status badge and whom they wait for (AC4).

const LINK = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

export function HomeCard({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <Card role="region" aria-labelledby={id} className="min-w-0 gap-3 bg-bg text-base">
      <CardHeader>
        <CardTitle>
          <h2 id={id} className="text-base font-semibold">
            {title}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  )
}

/** A card while its figures load: its title and grey lines, and a word for screen readers */
export function HomeCardSkeleton({ id, title, loading }: { id: string; title: string; loading: string }) {
  return (
    <HomeCard id={id} title={title}>
      <p role="status" className="sr-only">
        {loading}
      </p>
      <Skeleton className="h-6 w-3/4" />
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-6 w-1/2" />
    </HomeCard>
  )
}

export interface OnTimeRowView {
  readonly key: string
  readonly label: string
  readonly href: string
  /** "80%", or null when nothing counted in the last 30 days */
  readonly value: string | null
  readonly delta: { readonly direction: 'up' | 'down' | 'same'; readonly text: string } | null
  readonly counts: string | null
  /** Said instead of a value when nothing counted */
  readonly none: string
}

const DELTA_ICON = { up: ArrowUpRight, down: ArrowDownRight, same: Equal } as const

export function OnTimeRows({ rows, label }: { rows: readonly OnTimeRowView[]; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-col">
      {rows.map((row) => {
        const Icon = row.delta ? DELTA_ICON[row.delta.direction] : null
        return (
          <li key={row.key} className="border-b border-line last:border-b-0">
            <Link href={row.href} className="flex min-h-12 flex-col gap-0.5 rounded-md px-1 py-2 text-ink hover:bg-primary-tint">
              <span className="flex items-baseline justify-between gap-3">
                <span className="font-medium underline-offset-4 hover:underline">{row.label}</span>
                {row.value ? <span className="text-xl font-semibold tabular-nums">{row.value}</span> : null}
              </span>
              {row.value ? (
                <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-ink-muted">
                  {row.delta && Icon ? (
                    <span className="inline-flex items-center gap-1">
                      <Icon className="size-4 shrink-0" aria-hidden="true" />
                      {row.delta.text}
                    </span>
                  ) : null}
                  {row.counts ? <span>{row.counts}</span> : null}
                </span>
              ) : (
                <span className="text-ink-muted">{row.none}</span>
              )}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

export interface FollowingRowView {
  readonly id: string
  readonly href: string
  readonly title: string
  readonly status: string
  readonly statusLabel: string
  /** Whom it waits for now (FR-INT-008 AC1) */
  readonly now: string
}

export function FollowingRows({ rows, label, all }: { rows: readonly FollowingRowView[]; label: string; all: { href: string; text: string } }) {
  return (
    <>
      <ul aria-label={label} className="flex flex-col">
        {rows.map((row) => (
          <li key={row.id} className="border-b border-line last:border-b-0">
            <Link href={row.href} className="flex flex-col gap-1 rounded-md px-1 py-3 text-ink hover:bg-primary-tint">
              <span className="font-medium break-words underline-offset-4 hover:underline">{row.title}</span>
              <span className="flex flex-wrap items-center gap-2">
                <StatusBadge look={REQUEST_BADGES[row.status]} label={row.statusLabel} />
                <span className="text-ink-muted">{row.now}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <Link href={all.href} className={LINK}>
        {all.text}
      </Link>
    </>
  )
}
