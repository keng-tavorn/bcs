import Link from 'next/link'
import { cn } from '../cn'

// The two lists of the supplier register (S7-09 · docs/sub-specs/S7.md "แท็บ ใบสมัคร"): the suppliers and their
// applications, as links that read as tabs (each list is a page of its own, so no script is needed). Shown only when the
// organization has SUPPLIER on and the reader may see applications.

export function SupplierSectionTabs({ label, current, items }: { readonly label: string; readonly current: string; readonly items: readonly { readonly key: string; readonly href: string; readonly label: string; readonly note?: string }[] }) {
  return (
    <nav aria-label={label} className="border-b border-line">
      <ul className="flex flex-wrap gap-x-6">
        {items.map((i) => (
          <li key={i.key}>
            <Link
              href={i.href}
              aria-current={i.key === current ? 'page' : undefined}
              className={cn('-mb-px inline-flex min-h-11 items-center gap-2 border-b-2 font-medium lg:min-h-10', i.key === current ? 'border-primary text-ink' : 'border-transparent text-ink-muted hover:text-ink')}
            >
              {i.label}
              {i.note ? <span className="text-base font-normal text-ink-muted md:text-sm">{i.note}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
