import type { getTranslations } from 'next-intl/server'
import type { SuggestionKind } from '@/lib/assistant-suggestions'
import type { SuggestionDto } from '@/server/services/assistants/suggestions'
import type { AssistantIcon, AssistantNoteView, AssistantTone } from '@/ui/assistants/assistant-note'
import { formatBpPercent } from '@/ui/format'
import type { HomeT } from './home-present'
import { day, nameIn, when, type Locale } from './present'

// The home card "ผู้ช่วยเจอให้คุณ" for the reader (NEW-121 · ADR-078): each suggestion in their language — what was found,
// why, and the one page it leads to. Figures come from the service as they are; a percent is formatted from basis points.

export type PayRunTaskT = Awaited<ReturnType<typeof getTranslations<'payRun.task'>>>

const ICON: Readonly<Record<SuggestionKind, AssistantIcon>> = {
  FOLLOW_OVERDUE: 'AlarmClock',
  SUPPLIER_FLAGS: 'ShieldAlert',
  FOLLOW_DUE_SOON: 'Hourglass',
  REQUEST_FLAG: 'Copy',
  PRICE_HIGH: 'Tag',
  BUDGET_LOW: 'Wallet',
  AGREEMENT_EXPIRING: 'CalendarClock',
}

const TONE = { DANGER: 'danger', WARN: 'warn', INFO: 'info' } as const satisfies Record<SuggestionDto['tone'], AssistantTone>

function words(t: HomeT, tp: PayRunTaskT, locale: Locale, s: SuggestionDto): { title: string; why: string; action: string } {
  const number = (n: string | null) => n ?? t('assistant.untitled')
  switch (s.kind) {
    case 'FOLLOW_OVERDUE':
      return {
        title: t('assistant.FOLLOW_OVERDUE.title', { number: number(s.number) }),
        why: t('assistant.FOLLOW_OVERDUE.why', { name: nameIn(locale, s.waitingFor), when: when(locale, s.dueAt) }),
        action: t('assistant.FOLLOW_OVERDUE.action'),
      }
    case 'FOLLOW_DUE_SOON':
      return {
        title: t('assistant.FOLLOW_DUE_SOON.title', { number: number(s.number), when: when(locale, s.dueAt) }),
        why: t('assistant.FOLLOW_DUE_SOON.why', { name: nameIn(locale, s.waitingFor) }),
        action: t('assistant.FOLLOW_DUE_SOON.action'),
      }
    case 'REQUEST_FLAG':
      return {
        title: t('assistant.REQUEST_FLAG.title', { number: number(s.number), flags: s.flags.map((f) => t(`assistant.REQUEST_FLAG.${f}`)).join(`${t('assistant.REQUEST_FLAG.join')} `) }),
        why: t('assistant.REQUEST_FLAG.why'),
        action: t('assistant.REQUEST_FLAG.action'),
      }
    case 'PRICE_HIGH':
      return {
        title: t('assistant.PRICE_HIGH.title', { number: number(s.number), line: s.lineNo, pct: formatBpPercent(s.deviationBp, { signed: false }) }),
        why: t('assistant.PRICE_HIGH.why', { description: s.description, samples: s.samples, days: s.windowDays }),
        action: t('assistant.PRICE_HIGH.action'),
      }
    case 'AGREEMENT_EXPIRING':
      return {
        title: t('assistant.AGREEMENT_EXPIRING.title', { count: s.count, days: s.days }),
        why: t('assistant.AGREEMENT_EXPIRING.why', { item: nameIn(locale, s.first.item), supplier: nameIn(locale, s.first.supplier), date: day(locale, s.first.validTo) }),
        action: t('assistant.AGREEMENT_EXPIRING.action'),
      }
    case 'BUDGET_LOW':
      return {
        title: t('assistant.BUDGET_LOW.title', { count: s.count, pct: `${s.lowPct}%` }),
        why: t('assistant.BUDGET_LOW.why', { code: s.first.code, left: formatBpPercent(s.first.availableBp, { signed: false }) }),
        action: t('assistant.BUDGET_LOW.action'),
      }
    case 'SUPPLIER_FLAGS': {
      const flag = tp.has(`flag.${s.flags[0]}` as 'flag.REGISTRY_CHANGED') ? tp(`flag.${s.flags[0]}` as 'flag.REGISTRY_CHANGED') : s.flags[0]!
      return {
        title: t('assistant.SUPPLIER_FLAGS.title', { supplier: nameIn(locale, s.supplier), flag: s.flags.length > 1 ? t('assistant.SUPPLIER_FLAGS.more', { flag, count: s.flags.length - 1 }) : flag }),
        why: t('assistant.SUPPLIER_FLAGS.why', { count: s.invoices }),
        action: t('assistant.SUPPLIER_FLAGS.action'),
      }
    }
  }
}

export function assistantNotes(t: HomeT, tp: PayRunTaskT, locale: Locale, items: readonly SuggestionDto[]): AssistantNoteView[] {
  return items.map((s) => {
    const w = words(t, tp, locale, s)
    return { key: s.key, icon: ICON[s.kind], tone: TONE[s.tone], title: w.title, why: w.why, action: { href: s.href, label: w.action } }
  })
}
