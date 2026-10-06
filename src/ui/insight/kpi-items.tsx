import Link from 'next/link'
import { StateLine, type StateKind } from '../request-view/status'

// The documents behind one KPI figure (spec §9.9: every number leads to its list): each document links to its page for
// readers who may open it, says who decided or holds it, when and through which channel, the DOA version and rule a
// decision cites, and why it is counted — an icon with words. Rows separated by rules, no cards. Strings arrive
// translated.

export interface KpiItemView {
  readonly id: string
  readonly title: string
  readonly href: string | null
  readonly lines: readonly string[]
  readonly doa: { readonly text: string; readonly href: string | null } | null
  readonly mark: { readonly kind: StateKind; readonly text: string } | null
}

const linkClass = 'font-semibold break-words text-primary underline underline-offset-4 hover:no-underline'

export function KpiItems({ items, label }: { items: readonly KpiItemView[]; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-col divide-y divide-line border-y border-line">
      {items.map((item) => (
        <li key={item.id} className="flex flex-col gap-1 py-3">
          {item.href ? (
            <Link href={item.href} className={linkClass}>
              {item.title}
            </Link>
          ) : (
            <p className="font-semibold break-words text-ink">{item.title}</p>
          )}
          {item.lines.map((line) => (
            <p key={line} className="text-base text-ink md:text-sm">
              {line}
            </p>
          ))}
          {item.doa ? (
            <p className="text-base md:text-sm">
              {item.doa.href ? (
                <Link href={item.doa.href} className="text-primary underline underline-offset-4 hover:no-underline">
                  {item.doa.text}
                </Link>
              ) : (
                <span className="text-ink">{item.doa.text}</span>
              )}
            </p>
          ) : null}
          {item.mark ? (
            <StateLine kind={item.mark.kind} className="text-base md:text-sm">
              {item.mark.text}
            </StateLine>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
