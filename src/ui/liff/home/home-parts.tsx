import type { ReactNode } from 'react'
import { REQUEST_BADGES, STEP_BADGES, type StepBadgeKey } from '../../document/badge-looks'
import { LiffLink } from '../liff-link'
import { LiffNotice } from '../notice'
import { LiffStatusBadge } from '../status-badge'
import { LiffWebLink } from '../web-link'
import { LiffRetryButton } from './retry-button'

// The parts of /liff/home (FR-LINE-302 · BR-LINE-18 · §9.4 §9.9): "สิ่งที่ต้องทำ" "รอฉันอนุมัติ" "ที่ฉันติดตาม" in one
// column for a phone in LINE, as rows separated by rules (no cards), every link at least 44 px high. Server components:
// the only client code is the light link, the link that opens a web page outside LINE (../web-link.tsx) and the retry
// button of a part that could not load (AC3). The rows come from src/app/liff/home/present.ts, built from the web
// home's rows (the same services and queries, AC1).

export interface LiffDestination {
  readonly href: string
  /** false: a web page with no LIFF page, opened outside LINE (AC2) */
  readonly inLiff: boolean
}

export interface LiffTodoRow {
  readonly key: string
  readonly text: string
  readonly tone: 'danger' | 'warn' | 'neutral'
  readonly to: LiffDestination
}

export interface LiffApprovalRow {
  readonly id: string
  readonly href: string
  readonly title: string
  readonly kindLabel: string
  readonly meta: string | null
  readonly amount: string | null
  readonly sla: { readonly key: StepBadgeKey; readonly label: string }
  readonly forName: string | null
}

export interface LiffApprovals {
  readonly count: number
  readonly overdue: number
  readonly info: number
  readonly rows: readonly LiffApprovalRow[]
}

export interface LiffFollowingRow {
  readonly id: string
  readonly to: LiffDestination
  readonly title: string
  readonly status: string
  readonly statusLabel: string
  readonly now: string
}

const ROW_LINK = 'inline-flex min-h-11 items-center self-start font-semibold break-words text-primary underline underline-offset-4 hover:no-underline'
const PLAIN_LINK = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
const LIST = 'flex flex-col divide-y divide-line border-y border-line'

/** A LIFF page by the light link; a web page outside LINE, saying so to a screen reader */
export function LiffTo({ to, className, webHint, children }: { readonly to: LiffDestination; readonly className?: string; readonly webHint: string; readonly children: ReactNode }) {
  if (to.inLiff) {
    return (
      <LiffLink href={to.href} className={className ?? PLAIN_LINK}>
        {children}
      </LiffLink>
    )
  }
  return (
    <LiffWebLink href={to.href} className={className ?? PLAIN_LINK}>
      {children}
      <span className="sr-only"> ({webHint})</span>
    </LiffWebLink>
  )
}

/** "สิ่งที่ต้องทำ": each row says what waits and how many, and opens where it is done */
export function LiffTodoList({ rows, label, webHint }: { readonly rows: readonly LiffTodoRow[]; readonly label: string; readonly webHint: string }) {
  return (
    <ul aria-label={label} className={LIST}>
      {rows.map((row) => (
        <li key={row.key} className="py-1">
          <LiffTo to={row.to} webHint={webHint} className={row.tone === 'danger' ? `${ROW_LINK} text-danger-ink` : ROW_LINK}>
            {row.text}
          </LiffTo>
        </li>
      ))}
    </ul>
  )
}

/** Nothing waits for the member: the next steps they can take (AC4 · §9.9 principle 8) */
export function LiffHomeEmpty({ title, hint, start, mine }: { readonly title: string; readonly hint: string; readonly start: { readonly href: string; readonly label: string } | null; readonly mine: { readonly href: string; readonly label: string } }) {
  return (
    <div className="flex flex-col gap-2 border-y border-line py-4">
      <p className="font-medium text-ink">{title}</p>
      <p className="text-ink-muted">{hint}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {start ? (
          <LiffLink href={start.href} className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-4 font-medium text-primary-foreground underline-offset-4 hover:underline">
            {start.label}
          </LiffLink>
        ) : null}
        <LiffLink href={mine.href} className={PLAIN_LINK}>
          {mine.label}
        </LiffLink>
      </div>
    </div>
  )
}

export interface LiffApprovalsLabels {
  readonly list: string
  /** "ทั้งหมด 3 · เกินกำหนด 1 · รอผู้ขอตอบ 0" */
  readonly summary: string
  readonly empty: string
  readonly all: { readonly href: string; readonly text: string } | null
}

/** "รอฉันอนุมัติ": every task waiting for the member — approvals, the REVIEW and committee tasks of S6 (AC5) — each opening its LIFF decision page */
export function LiffApprovalsList({ data, labels }: { readonly data: LiffApprovals; readonly labels: LiffApprovalsLabels }) {
  if (data.count === 0) return <p className="text-ink-muted">{labels.empty}</p>
  return (
    <>
      <p className="font-medium text-ink">{labels.summary}</p>
      <ul aria-label={labels.list} className={LIST}>
        {data.rows.map((row) => (
          <li key={row.id} className="flex flex-col gap-1 py-3">
            <LiffLink href={row.href} className={ROW_LINK}>
              {row.title}
            </LiffLink>
            <p className="break-words text-ink-muted">{[row.kindLabel, row.meta].filter(Boolean).join(' · ')}</p>
            {row.amount ? <p className="money text-ink">{row.amount}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
              <LiffStatusBadge look={STEP_BADGES[row.sla.key]} label={row.sla.label} />
              {row.forName ? <span className="rounded-sm border border-line px-1.5 text-ink">{row.forName}</span> : null}
            </div>
          </li>
        ))}
      </ul>
      {labels.all ? (
        <LiffLink href={labels.all.href} className={PLAIN_LINK}>
          {labels.all.text}
        </LiffLink>
      ) : null}
    </>
  )
}

export interface LiffFollowingLabels {
  readonly list: string
  readonly summary: string
  readonly status: string
  readonly now: string
  readonly webHint: string
  readonly all: { readonly to: LiffDestination; readonly text: string }
}

/** "ที่ฉันติดตาม": the requests the member sent or follows that moved last, each opening its LIFF page with its timeline */
export function LiffFollowingList({ rows, labels }: { readonly rows: readonly LiffFollowingRow[]; readonly labels: LiffFollowingLabels }) {
  return (
    <>
      <p className="font-medium text-ink">{labels.summary}</p>
      <ul aria-label={labels.list} className={LIST}>
        {rows.map((row) => (
          <li key={row.id} className="flex flex-col gap-1 py-3">
            <LiffTo to={row.to} webHint={labels.webHint} className={ROW_LINK}>
              {row.title}
            </LiffTo>
            <p>
              <span className="sr-only">{labels.status}: </span>
              <LiffStatusBadge look={REQUEST_BADGES[row.status]} label={row.statusLabel} />
            </p>
            <p className="break-words text-ink">
              <span className="sr-only">{labels.now}: </span>
              {row.now}
            </p>
          </li>
        ))}
      </ul>
      <LiffTo to={labels.all.to} webHint={labels.webHint}>
        {labels.all.text}
      </LiffTo>
    </>
  )
}

/** A part that could not load says so inside itself with a way to try again; the other parts stay (AC3) */
export function LiffHomeError({ title, hint, retry }: { readonly title: string; readonly hint: string; readonly retry: string }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <LiffNotice tone="danger">
        <p className="font-medium">{title}</p>
        <p className="text-ink-muted">{hint}</p>
      </LiffNotice>
      <LiffRetryButton label={retry} />
    </div>
  )
}
