import type { ReactNode } from 'react'
import type { FlagKind, FlagLink, RequestFlagsView } from './view'

// The flags of a sent request (S6-13 · FR-INT-103 AC2 AC3 · BR-DUP-05) on its approver's pages: each one its badge (an
// icon and words, never colour alone, NFR-A11Y-03), what it means, the requester's reason or the DOA rules, and the
// requests it matched as links. Plain elements only, no shadcn/ui and no client code (ADR-052, §9.4): the page passes
// the badge and the link of its own kind — the workspace's StatusBadge and next/link, or LiffStatusBadge and LiffLink.

export function RequestFlagList({
  view,
  badge,
  link,
}: {
  view: RequestFlagsView
  badge: (flag: { kind: FlagKind; label: string }) => ReactNode
  link: (to: FlagLink) => ReactNode
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-ink-muted">{view.intro}</p>
      <ul className="flex flex-col divide-y divide-line border-t border-line">
        {view.flags.map((flag) => (
          <li key={flag.key} data-flag={flag.kind} className="flex flex-col gap-2 py-3">
            {badge({ kind: flag.kind, label: flag.badge })}
            <p className="break-words text-ink">{flag.detail}</p>
            {flag.note ? (
              <p className="break-words whitespace-pre-line text-ink">
                <span className="text-ink-muted">{`${flag.note.label}: `}</span>
                {flag.note.value}
              </p>
            ) : null}
            {flag.matched.length ? (
              <div className="flex flex-col">
                <p className="text-ink-muted">{view.matchedLabel}</p>
                <ul aria-label={view.matchedLabel} className="flex flex-wrap gap-x-4">
                  {flag.matched.map((m) => (
                    <li key={m.href}>{link(m)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
