import { FlaskConical } from 'lucide-react'

// The trial-system banner (S6-21 · FR-PLT-101 AC1 · BR-UAT-01): on top of every workspace page of an organization of kind
// SANDBOX, so nobody takes its data for the real system's. It cannot be closed, carries an icon and words (never colour
// alone, NFR-A11Y-03) in the warn pair of §9.10, and is a named region rather than a live one: it says how the page
// stands, not something that just happened. The LIFF pages draw their own twin (src/ui/liff/uat-banner.tsx, ADR-052).
export function UatBanner({ text }: { text: string }) {
  return (
    <div role="region" aria-label={text} className="flex items-start gap-2 border-b border-warn bg-warn-bg px-4 py-2 text-base text-warn-ink lg:px-6">
      <FlaskConical className="mt-1 size-4 shrink-0" aria-hidden="true" />
      <p className="font-semibold">{text}</p>
    </div>
  )
}
