import { Bell } from 'lucide-react'
import { cn } from '../cn'
import { SHELL_PANELS } from './panels'

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
    // One group with the user menu (SHELL_PANELS): opening the bell closes that menu, and the other way round
    <details name={SHELL_PANELS} className="group md:relative">
      <summary
        className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-full px-2.5 font-medium text-ink transition-colors duration-150 hover:bg-surface lg:min-h-10 [&::-webkit-details-marker]:hidden"
        aria-label={unread > 0 ? `${labels.button} · ${labels.unreadCount}` : labels.button}
      >
        <Bell className="size-5" aria-hidden="true" />
        {/* The top bar has room for the word on a wide screen only; the summary's aria-label says it at every width */}
        <span className="hidden xl:inline">{labels.button}</span>
        {unread > 0 ? (
          // The count of new notifications, in the colour of the "new" mark inside (danger is kept for overdue, not approved
          // and short budget, §9.9); one 26 px line box at both sizes, at least 1.6 times its text (1.63 at 16 px)
          <span className="rounded-full bg-primary px-2 text-base leading-[1.625rem] font-semibold text-primary-foreground tabular-nums md:text-sm" aria-hidden="true">
            {unread}
          </span>
        ) : null}
      </summary>
      {/* Under the top bar across a phone's width; beside the bell from a medium screen */}
      <div className="fixed inset-x-4 top-14 z-30 mt-2 flex max-h-[70dvh] flex-col md:absolute md:inset-x-auto md:top-auto md:right-0 md:w-[26rem] shadow-md overflow-y-auto rounded-md border border-line bg-bg">
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
