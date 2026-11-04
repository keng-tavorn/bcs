import { TriangleAlert } from 'lucide-react'
import { Badge } from '../../shadcn/badge'
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '../../shadcn/popover'

// The badge "N แจ้งเตือน" on the head of an invoice (NEW-116 · FR-AP-103 AC5): in one place, why the rules the system
// already has raised this invoice — the differences still open, a number the supplier has used, what a payment run would
// flag on the supplier — each with what to do next. It opens when pressed, never by itself (NG-13), and adds no rule.
// Words arrive translated, in the words only: no account number reaches here (BR-AUTH-04).

export interface InvoiceAlertView {
  readonly key: string
  readonly title: string
  readonly text: string
  /** Which line, how much and who it is sent to, when the rule says */
  readonly where: string | null
}

export function InvoiceAlerts({ alerts, button, title, hint }: { alerts: readonly InvoiceAlertView[]; button: string; title: string; hint: string }) {
  if (alerts.length === 0) return null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Badge asChild variant="warn" data-invoice-alerts className="min-h-11 cursor-pointer px-3 text-base hover:underline md:min-h-8 md:text-sm">
          <button type="button">
            <TriangleAlert aria-hidden="true" />
            {button}
          </button>
        </Badge>
      </PopoverTrigger>
      <PopoverContent aria-label={title} align="start" collisionPadding={16} className="flex max-h-[70dvh] w-[min(28rem,calc(100vw-2rem))] flex-col gap-3 overflow-y-auto">
        <PopoverHeader>
          <PopoverTitle className="text-base font-semibold text-ink">{title}</PopoverTitle>
          <PopoverDescription className="text-base text-ink-muted md:text-sm">{hint}</PopoverDescription>
        </PopoverHeader>
        <InvoiceAlertList alerts={alerts} label={title} />
      </PopoverContent>
    </Popover>
  )
}

/** The alerts as a list, in the badge's popover and in the quick view of the list (NEW-117) */
export function InvoiceAlertList({ alerts, label }: { alerts: readonly InvoiceAlertView[]; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-col divide-y divide-line border-y border-line">
      {alerts.map((a) => (
        <li key={a.key} className="flex gap-2 py-2.5">
          <TriangleAlert className="mt-1 size-4 shrink-0 text-warn-ink" aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-0.5 text-base md:text-sm">
            <span className="font-medium break-words text-ink">{a.title}</span>
            {a.where ? <span className="text-ink-muted">{a.where}</span> : null}
            <span className="break-words text-ink">{a.text}</span>
          </div>
        </li>
      ))}
    </ul>
  )
}
