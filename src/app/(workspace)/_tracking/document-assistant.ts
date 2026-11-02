import type { getTranslations } from 'next-intl/server'
import { ASSISTANT_DUE_SOON_MS } from '@/lib/assistant-suggestions'
import type { PriceReferenceDto } from '@/server/queries/price-reference'
import type { MemberRefDto } from '@/server/queries/requests'
import type { RequestFlagDto } from '@/server/services/requests/duplicates'
import type { AssistantNoteView } from '@/ui/assistants/assistant-note'
import type { AssistantPanelView } from '@/ui/assistants/document-panel'
import { formatBpPercent } from '@/ui/format'
import type { BriefView } from '../../_lib/brief-present'
import type { PayRunTaskT } from './assistant-present'
import { memberName, when, type Locale } from './present'

// The panel "จากผู้ช่วย" of the request and PO pages (NEW-122 · ADR-079), in the reader's language. What the assistants
// found comes from what the page has already read under the reader's rights — the step waiting now and its due time,
// the request's duplicate and split flags (listRequestFlags), the reference price of the decider's own task
// (getPriceReference) — so nothing is read twice and nothing new is decided. The AI's parts (the Approval Brief, the
// shortcuts to "ถาม BCS AI") come only when the module and the agent are on.

export type PanelT = Awaited<ReturnType<typeof getTranslations<'assistantPanel'>>>
export type ApInvoiceT = Awaited<ReturnType<typeof getTranslations<'apInvoice'>>>
export type PanelDocument = 'REQUEST' | 'PURCHASE_ORDER' | 'INVOICE'

export interface WaitingStep {
  readonly assignee: MemberRefDto | null
  readonly onBehalfOf: MemberRefDto | null
  readonly dueAt: Date | null
  readonly overdue: boolean
}

/** The step waiting now when its time is out, or ends within a day (the home card's measure); none otherwise */
export function stepNote(t: PanelT, locale: Locale, now: Date, me: string, waiting: WaitingStep | null, href: string): AssistantNoteView | null {
  if (!waiting?.dueAt || !waiting.assignee) return null
  const overdue = waiting.overdue || waiting.dueAt.getTime() <= now.getTime()
  if (!overdue && waiting.dueAt.getTime() - now.getTime() > ASSISTANT_DUE_SOON_MS) return null
  const kind = overdue ? 'STEP_OVERDUE' : 'STEP_DUE_SOON'
  const mine = waiting.assignee.id === me || waiting.onBehalfOf?.id === me
  return {
    key: kind,
    icon: overdue ? 'AlarmClock' : 'Hourglass',
    tone: overdue ? 'danger' : 'warn',
    title: t(`${kind}.title`, { when: when(locale, waiting.dueAt) }),
    why: mine ? t(`${kind}.whyMine`) : t(`${kind}.why`, { name: memberName(locale, waiting.assignee) }),
    action: { href, label: t('step.action') },
  }
}

/** The request's duplicate or split flags of its latest route, as its approver's page shows them (BR-DUP-05) */
export function flagNote(t: PanelT, flags: readonly RequestFlagDto[], href: string): AssistantNoteView | null {
  const kinds = [...new Set(flags.map((f) => f.kind))].sort()
  if (kinds.length === 0) return null
  return {
    key: `REQUEST_FLAG:${kinds.join('+')}`,
    icon: 'Copy',
    tone: 'warn',
    title: t('REQUEST_FLAG.title', { flags: kinds.map((k) => t(`REQUEST_FLAG.${k}`)).join(`${t('REQUEST_FLAG.join')} `) }),
    why: t('REQUEST_FLAG.why', { matched: [...new Set(flags.flatMap((f) => f.matched.map((m) => m.label)))].join(', ') }),
    action: { href, label: t('REQUEST_FLAG.action') },
  }
}

/** The line furthest above its reference price, as the decider's own panel on the task page reads it (BR-PRC) */
export function priceNote(t: PanelT, reference: PriceReferenceDto, href: string): AssistantNoteView | null {
  const high = reference.lines.filter((l) => l.alert === 'HIGH' && l.deviationBp !== null).sort((a, b) => b.deviationBp! - a.deviationBp! || a.lineNo - b.lineNo)[0]
  if (!high) return null
  return {
    key: `PRICE_HIGH:${high.lineNo}`,
    icon: 'Tag',
    tone: 'warn',
    title: t('PRICE_HIGH.title', { line: high.lineNo, pct: formatBpPercent(high.deviationBp!, { signed: false }) }),
    why: t('PRICE_HIGH.why', { description: high.description, samples: high.count, days: reference.windowDays }),
    action: { href, label: t('PRICE_HIGH.action') },
  }
}

/** What the invoice page has found already (getApInvoicePage, under its own rule of who reads the invoice) */
export interface InvoiceFacts {
  readonly id: string
  readonly supplierId: string
  readonly exceptions: ReadonlyArray<{ readonly type: string; readonly status: string }>
  readonly duplicateNumber: boolean
  readonly paymentFlags: readonly string[]
}

/**
 * The invoice's alerts as the assistant that checks documents tells them (the rules of NEW-116, nothing new): its open
 * differences, a number its supplier used already, and the supplier's flags a payment run would show — each with one way
 * to where it is dealt with
 */
export function invoiceNotes(t: PanelT, ta: ApInvoiceT, tp: PayRunTaskT, invoice: InvoiceFacts): AssistantNoteView[] {
  const page = `/finance/invoices/${invoice.id}`
  const notes: AssistantNoteView[] = []
  if (invoice.exceptions.length) {
    const open = invoice.exceptions.some((e) => e.status === 'OPEN')
    const types = [...new Set(invoice.exceptions.map((e) => e.type))].map((type) => (ta.has(`exceptions.type.${type}` as 'exceptions.type.PRICE_OVER') ? ta(`exceptions.type.${type}` as 'exceptions.type.PRICE_OVER') : type))
    notes.push({
      key: `INVOICE_DIFFERENCES:${invoice.exceptions.length}`,
      icon: 'Scale',
      tone: open ? 'warn' : 'info',
      title: t('INVOICE_DIFFERENCES.title', { count: invoice.exceptions.length }),
      // A difference whose variance approval was asked for waits for its approver
      why: open ? t('INVOICE_DIFFERENCES.why', { types: types.join(' · ') }) : t('INVOICE_DIFFERENCES.whyAsked'),
      action: { href: `${page}#invoice-exceptions`, label: t('INVOICE_DIFFERENCES.action') },
    })
  }
  if (invoice.duplicateNumber) {
    notes.push({ key: 'INVOICE_DUPLICATE_NUMBER', icon: 'Copy', tone: 'warn', title: ta('alerts.duplicateNumberTitle'), why: ta('alerts.duplicateNumberText'), action: { href: `${page}?tab=details#invoice-header`, label: t('INVOICE_DUPLICATE_NUMBER.action') } })
  }
  const flags = invoice.paymentFlags
  if (flags.length) {
    const flag = (f: string) => (tp.has(`flag.${f}` as 'flag.REGISTRY_CHANGED') ? tp(`flag.${f}` as 'flag.REGISTRY_CHANGED') : f)
    notes.push({
      key: `INVOICE_SUPPLIER_FLAGS:${[...flags].sort().join('+')}`,
      icon: 'ShieldAlert',
      tone: 'danger',
      title: flags.length > 1 ? t('SUPPLIER_FLAGS.titleMore', { flag: flag(flags[0]!), count: flags.length - 1 }) : t('SUPPLIER_FLAGS.title', { flag: flag(flags[0]!) }),
      why: tp.has(`flagExplain.${flags[0]}` as 'flagExplain.REGISTRY_CHANGED') ? tp(`flagExplain.${flags[0]}` as 'flagExplain.REGISTRY_CHANGED') : t('SUPPLIER_FLAGS.why'),
      action: { href: `/suppliers/${invoice.supplierId}`, label: t('SUPPLIER_FLAGS.action') },
    })
  }
  return notes
}

/** The shortcuts to "ถาม BCS AI" with the document's number; none without a number or while the agent is off */
export function askPart(t: PanelT, document: PanelDocument, number: string | null, asking: boolean): AssistantPanelView['ask'] {
  if (!asking || !number) return null
  return {
    title: t('ask.title'),
    hint: t('ask.hint'),
    draft: t(`ask.draft.${document}`, { number }),
    summarize: t(`ask.summarize.${document}`, { number }),
    labels: { ask: t('ask.ask'), summarize: t('ask.summarizeButton') },
  }
}

/** The whole panel: the Brief for the one who decides (with what they said of it), what was found, the shortcuts */
export function assistantPanel(t: PanelT, parts: { brief: BriefView | null; notes: ReadonlyArray<AssistantNoteView | null>; ask: AssistantPanelView['ask'] }): AssistantPanelView {
  const brief = parts.brief
  return {
    title: t('title'),
    brief: brief ? { ...brief, feedback: brief.agentActionId ? { agentActionId: brief.agentActionId, given: brief.feedback } : null } : null,
    found: { title: t('found.title'), list: t('found.list'), none: t('found.none'), notes: parts.notes.filter((n): n is AssistantNoteView => n !== null) },
    ask: parts.ask,
  }
}
