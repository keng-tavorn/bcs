import { getTranslations } from 'next-intl/server'
import type { Ctx } from '@/server/context'
import { approvalBriefOf } from '@/server/services/ai'

// The Approval Brief of a task as its boxes show it (FR-AI-301 AC1, §12.5): the web's decision bar and the LIFF task
// page (src/ui/tasks/ai-brief.tsx, src/ui/liff/ai-brief-box.tsx) get plain words, so neither box reads a service. No
// box at all when the task has no Brief (agent off, not an approval step) or the reader may not see one.

export interface BriefView {
  readonly title: string
  readonly note: string
  /** "กำลังสรุป" while the AI writes; the facts are shown meanwhile */
  readonly pending: string | null
  readonly sentences: readonly string[] | null
  /** Shown instead of the sentences when there are none to show */
  readonly factsOnly: string | null
  readonly factsTitle: string
  readonly facts: ReadonlyArray<{ readonly label: string; readonly value: string }>
}

const MONEY_FACTS = ['amount', 'budgetRemaining', 'supplierLastPoAmount']

export async function briefView(ctx: Ctx, taskId: string): Promise<BriefView | null> {
  const r = await approvalBriefOf(ctx, taskId)
  if (!r.ok || r.data.status === 'NONE') return null
  const t = await getTranslations('aiAssist.brief')
  const value = (key: string, text: string) =>
    MONEY_FACTS.includes(key) ? t('values.baht', { amount: text }) : t.has(`values.${text}` as 'values.YES') ? t(`values.${text}` as 'values.YES') : text
  return {
    title: t('title'),
    note: t('note'),
    pending: r.data.status === 'PENDING' ? t('pending') : null,
    sentences: r.data.sentences,
    factsOnly: r.data.sentences === null && r.data.status !== 'PENDING' ? t('factsOnly') : null,
    factsTitle: t('factsTitle'),
    facts: r.data.facts.filter((f) => t.has(`facts.${f.key}` as 'facts.amount')).map((f) => ({ label: t(`facts.${f.key}` as 'facts.amount'), value: value(f.key, f.text) })),
  }
}
