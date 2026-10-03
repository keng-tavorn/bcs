import { cn } from '../cn'

// The DOA reference of a route or a decision, "DOA-DEMO ฉบับ 1 ข้อ PR-02" (FR-DOA-005 AC2), drawn like the stamps of the
// timeline. It links to the version only when the reader may open that page (`href`); otherwise it is the same label as
// text, so nobody follows a link that ends in a refusal.

const LOOK = 'inline-block rounded-sm border-2 border-primary px-1.5 py-0.5 font-semibold text-primary'

export function DoaRef({ label, href, className }: { label: string; href?: string | null; className?: string }) {
  return href ? (
    <a href={href} className={cn(LOOK, 'underline-offset-4 hover:underline', className)}>
      {label}
    </a>
  ) : (
    <span className={cn(LOOK, className)}>{label}</span>
  )
}
