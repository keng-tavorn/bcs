import type { getTranslations } from 'next-intl/server'
import { followUpDraftAnchor, followUpRowAnchor } from '@/lib/follow-up'
import type { FollowUpDto } from '@/server/services/assistants/follow-up'
import type { FollowUpItemView } from '@/ui/assistants/follow-up-list'
import { nameIn, when, type Locale } from '../_tracking/present'

// The follow-up assistant's rows in the reader's language (NEW-124 · ADR-082): what the service found, said as the
// reasons a task still waits, and the nudge a person may read, change and send — written here from the templates of
// messages/src/*/followUp.json, which pass the checker of BR-AI-27 (tests/unit/follow-up.test.ts), never by an AI.

export type FollowUpT = Awaited<ReturnType<typeof getTranslations<'followUp'>>>

/** Why the task still waits, in the order a reader asks it: who has it, why it did not move, what the system did */
export function reasonsOf(t: FollowUpT, locale: Locale, me: string, f: FollowUpDto): string[] {
  const name = nameIn(locale, f.assignee.name)
  const reasons: string[] = []
  if (f.onBehalfOf) {
    const principal = nameIn(locale, f.onBehalfOf.name)
    reasons.push(f.onBehalfOf.until ? t('reason.actingUntil', { name, principal, until: when(locale, f.onBehalfOf.until) }) : t('reason.acting', { name, principal }))
  } else {
    reasons.push(t('reason.holder', { name }))
  }
  if (f.holderAwayUntil) reasons.push(t('reason.away', { name, until: when(locale, f.holderAwayUntil) }))
  if (f.slaRemindedAt) reasons.push(t('reason.slaReminded', { name, when: when(locale, f.slaRemindedAt) }))
  if (f.overdueAt) reasons.push(t('reason.overdueTold', { name, when: when(locale, f.overdueAt) }))
  if (f.escalatedAt) {
    const names = f.coAssignees.map((n) => nameIn(locale, n)).join(', ')
    reasons.push(names ? t('reason.escalatedWith', { when: when(locale, f.escalatedAt), names }) : t('reason.escalated', { when: when(locale, f.escalatedAt) }))
  } else if (f.escalatesAt) {
    reasons.push(t('reason.escalates', { when: when(locale, f.escalatesAt) }))
  }
  if (f.today) {
    const at = when(locale, f.today.lastAt)
    const byMe = f.today.lastById === me
    reasons.push(byMe ? t('reason.sentTodayMe', { when: at }) : t('reason.sentToday', { name: f.today.lastBy ? nameIn(locale, f.today.lastBy) : '-', when: at }))
  }
  return reasons
}

/** The drafted nudge: to the holder, about the document by its kind and number, with the due time — nothing else */
export function draftOf(t: FollowUpT, locale: Locale, f: FollowUpDto): string {
  const document = t(`document.${f.document.type}`)
  const number = f.document.number ?? f.document.title
  return t(f.overdue ? 'draft.OVERDUE' : 'draft.DUE_SOON', { name: nameIn(locale, f.assignee.name), document, number, due: when(locale, f.dueAt) })
}

export function followUpItems(t: FollowUpT, locale: Locale, me: string, items: readonly FollowUpDto[]): FollowUpItemView[] {
  return items.map((f) => {
    const name = nameIn(locale, f.assignee.name)
    const document = t(`document.${f.document.type}`)
    const number = f.document.number ?? ''
    return {
      taskId: f.taskId,
      anchor: followUpRowAnchor(f.taskId),
      overdue: f.overdue,
      title: [`${document} ${number}`.trim(), f.document.title].filter(Boolean).join(' · '),
      href: f.document.href,
      open: t('open', { document }),
      due: f.overdue ? t('overdue', { when: when(locale, f.dueAt) }) : t('dueSoon', { when: when(locale, f.dueAt) }),
      relation: t(`relation.${f.relation}`),
      reasons: reasonsOf(t, locale, me, f),
      hold: f.hold ? (f.hold.reason === 'SENT_TODAY' ? t('hold.SENT_TODAY', { when: when(locale, f.hold.nextAt) }) : t('hold.TOLD_RECENTLY', { name, when: when(locale, f.hold.nextAt) })) : null,
      draft: {
        taskId: f.taskId,
        anchor: followUpDraftAnchor(f.taskId),
        to: t('draft.to', { name }),
        text: draftOf(t, locale, f),
        hint: t('draft.hint', { name }),
        confirmTitle: t('draft.confirmTitle', { name }),
        confirm: { LINE: t('draft.confirmLINE', { name, document, number }), EMAIL: t('draft.confirmEMAIL', { name, document, number }) },
        sent: t('draft.sent', { name }),
      },
    }
  })
}
