import { cn } from '../cn'

// Where the goods of a request go and the supplier its requester suggested (S4-02), as label–value pairs that line up
// with the request's other facts (Facts). A value that was not chosen is said in words, in the secondary colour.

export interface PlaceFact {
  readonly label: string
  readonly value: string
  /** A second line, e.g. the site's address */
  readonly detail: string | null
  /** false: the value says that nothing was chosen */
  readonly set: boolean
}

export function PlaceFacts({ items }: { items: readonly PlaceFact[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-8 gap-y-3 lg:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="flex min-w-0 flex-col">
          <dt className="text-base text-ink-muted md:text-sm">{item.label}</dt>
          <dd className={cn('break-words', item.set ? 'text-ink' : 'text-ink-muted')}>
            {item.value}
            {/* The address under the place: content at the body's size (§9.9: 15 px on the web) */}
            {item.detail ? <span className="block text-ink-muted">{item.detail}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  )
}
