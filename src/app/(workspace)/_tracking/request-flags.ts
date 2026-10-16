import type { getTranslations } from 'next-intl/server'
import type { RequestFlagDto } from '@/server/services/requests/duplicates'
import type { RequestFlagsView, RequestFlagView } from '@/ui/request-flags/view'
import { money } from './present'

// listRequestFlags' DTO in the words of the approver's pages (S6-13 · FR-INT-103 AC2 AC3 · BR-DUP-05), for the web task
// page, the web request page and the LIFF task page alike: null when the request has no flag, so the page shows nothing.
// The combined amount stays satang text until formatSatang writes it (BigInt, never a JS number). `hrefOf` gives the
// matched request's page in the reader's app (/requests/<id> on the web, /liff/requests/<id> in LIFF).

export type RequestFlagsT = Awaited<ReturnType<typeof getTranslations<'requestFlags'>>>

export function requestFlagsView(t: RequestFlagsT, flags: readonly RequestFlagDto[], hrefOf: (requestId: string) => string): RequestFlagsView | null {
  if (flags.length === 0) return null
  const rule = (code: string | null) => code ?? t('split.noRule')
  return {
    title: t('title'),
    intro: t('intro'),
    matchedLabel: t('matched'),
    flags: flags.map((f): RequestFlagView => ({
      key: `${f.routeNo}-${f.kind}`,
      kind: f.kind,
      badge: t(`badge.${f.kind}`),
      detail: f.kind === 'SPLIT' ? (f.combinedSatang === null ? t('split.detailNoAmount') : t('split.detail', { amount: money(BigInt(f.combinedSatang)) })) : t('duplicate.detail'),
      note:
        f.kind === 'SPLIT'
          ? { label: t('split.rulesLabel'), value: t('split.rules', { individual: rule(f.individualRule), combined: rule(f.combinedRule) }) }
          : { label: t('duplicate.reasonLabel'), value: f.reason?.trim() || t('duplicate.noReason') },
      matched: f.matched.map((m) => ({ href: hrefOf(m.id), label: m.label })),
    })),
  }
}
