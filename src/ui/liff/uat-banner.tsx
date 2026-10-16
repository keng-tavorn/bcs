import { NoticeIcon } from './notice'

// The trial-system banner of LIFF pages (S6-21 · FR-PLT-101 AC1 · BR-UAT-01): the twin of the workspace's
// src/ui/shell/uat-banner.tsx in the light LIFF set (ADR-052) — markup only, no JavaScript in the page's first load
// (§9.4). On top of every LIFF page of an organization of kind SANDBOX; it cannot be closed, and says it with an icon and
// words (NFR-A11Y-03) in the warn pair of §9.10.
export function LiffUatBanner({ text }: { readonly text: string }) {
  return (
    <div role="region" aria-label={text} className="flex items-start gap-2 border-b border-warn bg-warn-bg px-4 py-2 text-base text-warn-ink">
      <NoticeIcon tone="warning" />
      <p className="font-semibold">{text}</p>
    </div>
  )
}
