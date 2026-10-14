import { getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import { LiffSection } from '../../content'

// The LIFF summary of an approval task on a PO change (S8-13, ADR-052): the PO number, the change number and the PO's
// new total only — nothing per line; the web task page has the lines before and after. No workspace component: a plain
// list of label and value in the LIFF type sizes. The LIFF task page of S6 renders it with the view it read.

export interface LiffPoChangeView {
  readonly changeNo: number
  readonly po: { readonly number: string | null }
  readonly new: { readonly grossSatang: bigint }
}

export async function LiffPoChangeSummary({ change }: { change: LiffPoChangeView | null }) {
  if (!change) return null
  const t = await getTranslations('poChange.task')
  const rows = [
    { label: t('po'), value: change.po.number ?? '-' },
    { label: t('changeNo'), value: t('changeNoValue', { no: change.changeNo }) },
    { label: t('gross'), value: `${formatSatang(change.new.grossSatang)} ${t('unit')}` },
  ]
  return (
    <LiffSection id="po-change-summary" title={t('heading')}>
      <dl className="flex flex-col gap-3">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-col">
            <dt className="text-ink-muted">{r.label}</dt>
            <dd className="tabular break-words text-ink">{r.value}</dd>
          </div>
        ))}
      </dl>
    </LiffSection>
  )
}
