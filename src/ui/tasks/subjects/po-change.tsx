import { getLocale, getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai'
import { Amounts, Facts, Section, type Fact } from '@/ui/request-view/facts'

// The body of an approval task on a change of a sent PO (S8-13, FR-AP-107 AC2, BR-POC-02): the PO, its supplier, the
// change's number and reason, every changed line before and after (quantity × unit price and the line's amount), then
// the PO's totals after the change — the amount DOA PO_CHANGE routes on — beside its total before. On the web; the LIFF
// summary is src/ui/liff/tasks/subjects/po-change.tsx. Flat sections, amounts right-aligned in tabular digits (§9.9).

/** The view the page reads (getPoChangeTaskView of src/server/queries/po-changes.ts has this shape) */
export interface PoChangeTaskView {
  readonly changeNo: number
  readonly reason: string | null
  readonly deliveryDate: string | null
  readonly notesToSupplier: string | null
  readonly autoApproved: boolean
  readonly po: { readonly number: string | null }
  readonly supplier: { readonly nameTh: string }
  readonly old: { readonly grossSatang: bigint }
  readonly new: { readonly netSatang: bigint; readonly vatSatang: bigint; readonly grossSatang: bigint }
  readonly lines: ReadonlyArray<{
    readonly lineNo: number
    readonly description: string
    readonly uom: string
    readonly oldQuantity: string
    readonly newQuantity: string
    readonly oldUnitPriceSatang: bigint
    readonly newUnitPriceSatang: bigint
    readonly oldNetSatang: bigint
    readonly newNetSatang: bigint
  }>
}

export async function PoChangeBody({ change }: { change: PoChangeTaskView }) {
  const [t, tc, locale] = await Promise.all([getTranslations('poChange.task'), getTranslations('poChange.changes'), getLocale()])
  const money = (s: bigint) => formatSatang(s)
  const facts: Fact[] = [
    { label: t('po'), value: change.po.number ?? '-' },
    { label: t('changeNo'), value: t('changeNoValue', { no: change.changeNo }) },
    { label: t('supplier'), value: change.supplier.nameTh },
    ...(change.deliveryDate ? [{ label: t('deliveryDate'), value: locale === 'en' ? formatEnglishBeDate(change.deliveryDate) : formatThaiDate(change.deliveryDate) }] : []),
    ...(change.reason ? [{ label: t('reason'), value: <span className="whitespace-pre-line">{change.reason}</span> }] : []),
    ...(change.notesToSupplier ? [{ label: t('notes'), value: <span className="whitespace-pre-line">{change.notesToSupplier}</span> }] : []),
  ]
  return (
    <div className="@container flex flex-col gap-6">
      <Facts items={facts} />
      {change.lines.length > 0 ? (
        <Section id="po-change-lines" title={t('linesTitle')}>
          <ul className="flex flex-col gap-1">
            {change.lines.map((l) => (
              <li key={l.lineNo} className="tabular break-words text-ink">
                {tc('line', {
                  no: l.lineNo,
                  description: l.description,
                  uom: l.uom,
                  oldQuantity: l.oldQuantity,
                  newQuantity: l.newQuantity,
                  oldPrice: money(l.oldUnitPriceSatang),
                  newPrice: money(l.newUnitPriceSatang),
                })}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section id="po-change-amounts" title={t('amountsTitle')}>
        <Amounts
          heading={t('unit')}
          unit={t('unit')}
          rows={[
            { label: t('oldGross'), value: money(change.old.grossSatang) },
            { label: t('net'), value: money(change.new.netSatang) },
            { label: t('vat'), value: money(change.new.vatSatang) },
            { label: t('gross'), value: money(change.new.grossSatang), total: true },
          ]}
        />
        <p className="text-base text-ink-muted md:text-sm">{t('approveHint')}</p>
      </Section>
    </div>
  )
}
