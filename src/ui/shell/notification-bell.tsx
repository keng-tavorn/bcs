import { Bell } from 'lucide-react'
import { cn } from '../cn'

// The bell (FR-NOTI-001 AC1): the member's latest notifications, newest first, each opening its document and marking
// itself read on the way; "mark all read" clears the count. Works without JavaScript (details + forms that POST).
// Unread items carry the word "new" next to a dot, not colour alone (NFR-A11Y-03). Strings arrive translated.

export interface BellItem {
  readonly id: string
  readonly title: string
  readonly body: string | null
  readonly href: string | null
  /** Already formatted for the reader (Thai Buddhist calendar or English) */
  readonly when: string
  readonly unread: boolean
}

export interface NotificationBellProps {
  readonly items: readonly BellItem[]
  readonly unread: number
  readonly labels: {
    readonly button: string
    readonly unreadCount: string
    readonly panelTitle: string
    readonly newItem: string
    readonly markAllRead: string
    readonly empty: string
    readonly emptyHint: string
  }
  readonly openAction: (formData: FormData) => Promise<void>
  readonly markAllReadAction: (formData: FormData) => Promise<void>
}

export function NotificationBell({ items, unread, labels, openAction, markAllReadAction }: NotificationBellProps) {
  return (
    <details className="group relative">
      <summary
        className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md border border-input bg-bg px-3 font-medium text-ink [&::-webkit-details-marker]:hidden"
        aria-label={unread > 0 ? `${labels.button} · ${labels.unreadCount}` : labels.button}
      >
        <Bell className="size-5" aria-hidden="true" />
        <span>{labels.button}</span>
        {unread > 0 ? (
          <span className="rounded-full bg-danger px-2 text-base leading-6 font-semibold text-white tabular-nums md:text-sm" aria-hidden="true">
            {unread}
          </span>
        ) : null}
      </summary>
      <div className="absolute right-0 z-30 mt-2 flex max-h-[70dvh] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-y-auto rounded-md border border-line bg-bg">
        <div className="flex flex-col items-start gap-1 border-b border-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <h2 className="text-lg font-semibold text-ink">{labels.panelTitle}</h2>
          {unread > 0 ? (
            <form action={markAllReadAction}>
              <button type="submit" className="min-h-11 font-medium text-primary underline underline-offset-4 hover:no-underline">
                {labels.markAllRead}
              </button>
            </form>
          ) : null}
        </div>
        {items.length === 0 ? (
          <div className="flex flex-col gap-1 px-4 py-6">
            <p className="font-medium text-ink">{labels.empty}</p>
            <p className="text-ink-muted">{labels.emptyHint}</p>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((item) => (
              <li key={item.id}>
                <form action={openAction}>
                  <input type="hidden" name="id" value={item.id} />
                  <input type="hidden" name="href" value={item.href ?? ''} />
                  <button type="submit" className="flex w-full flex-col items-start gap-1 px-4 py-3 text-left hover:bg-surface focus-visible:bg-surface">
                    <span className="flex items-center gap-2">
                      {item.unread ? (
                        <span className="inline-flex items-center gap-1 text-base font-semibold text-primary md:text-sm">
                          <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
                          {labels.newItem}
                        </span>
                      ) : null}
                      <span className={cn('text-ink', item.unread ? 'font-semibold' : 'font-normal')}>{item.title}</span>
                    </span>
                    {item.body ? <span className="text-ink-muted">{item.body}</span> : null}
                    <span className="text-base text-ink-muted md:text-sm">{item.when}</span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  )
}
