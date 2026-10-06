import { cn } from '../cn'

// The DOA reference of a route or a decision, "DOA-DEMO ฉบับ 1 ข้อ PR-02" (FR-DOA-005 AC2), as plain words: the stamps of
// the timeline are the page's one signature element (§9.9), so a reference outside them is quiet — a link to the version
// only when the reader may open that page (`href`); otherwise the same words as text, so nobody follows a link that ends
// in a refusal.

const TEXT = 'font-medium text-ink'
const LINK = 'font-medium text-primary underline underline-offset-4 hover:no-underline'

export function DoaRef({ label, href, className }: { label: string; href?: string | null; className?: string }) {
  return href ? (
    <a href={href} className={cn(LINK, className)}>
      {label}
    </a>
  ) : (
    <span className={cn(TEXT, className)}>{label}</span>
  )
}
