import { getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import { formatThaiDay } from '@/core/thai/day'
import { LiffSection } from '../../content'

// The LIFF summary of an approval task on a payment run (S9-06, FR-PAY-101 AC5, BR-PAY-07, ADR-052): the run's number,
// pay date, payer account masked, totals, and the items with flags first, each with its flags and the preparer's reason.
// A plain list of label and value in the LIFF type sizes, no workspace component. The LIFF task page renders it with the
// view it read; the decision below it sends back the flags it showed.

/** The flags of BR-PAY-06, as the view reads them (PaymentFlag of the payment engine) */
type RunFlag = 'REGISTRY_CHANGED' | 'SUPPLIER_INACTIVE' | 'RISK_OVERRIDE_EXPIRED' | 'PREVIOUSLY_EXPORTED' | 'BANK_ACCOUNT_RECENTLY_CHANGED' | 'BANK_CHANGE_PENDING' | 'SHARED_BANK_ACCOUNT'

export interface LiffPaymentRunView {
  readonly number: string | null
  readonly payDate: string
  readonly payer: { readonly code: string | null; readonly bankCode: string; readonly bankName: string | null; readonly last4: string }
  readonly totalWhtSatang: bigint
  readonly totalTransferSatang: bigint
  readonly itemCount: number
  readonly documentCount: number
  readonly items: ReadonlyArray<{ readonly supplierCode: string; readonly supplierName: string; readonly transferSatang: bigint; readonly flags: readonly RunFlag[]; readonly flagReason: string | null; readonly accountLast4: string | null }>
}

export async function LiffPaymentRunSummary({ run }: { run: LiffPaymentRunView | null }) {
  if (!run) return null
  const t = await getTranslations('payRun.task')
  const flagged = run.items.filter((i) => i.flags.length > 0)
  const rows = [
    { label: t('number'), value: run.number ?? '-' },
    { label: t('payDate'), value: formatThaiDay(run.payDate) ?? run.payDate },
    { label: t('payer'), value: `${run.payer.code ? `${run.payer.code} · ` : ''}${run.payer.bankName ?? run.payer.bankCode} ••••${run.payer.last4}` },
    { label: t('suppliers'), value: t('suppliersValue', { items: run.itemCount, documents: run.documentCount }) },
    { label: t('wht'), value: `${formatSatang(run.totalWhtSatang)} ${t('unit')}` },
    { label: t('transfer'), value: `${formatSatang(run.totalTransferSatang)} ${t('unit')}` },
  ]
  return (
    <>
      <LiffSection id="payment-run-summary" title={t('heading')}>
        <dl className="flex flex-col gap-3">
          {rows.map((r) => (
            <div key={r.label} className="flex flex-col">
              <dt className="text-ink-muted">{r.label}</dt>
              <dd className="tabular break-words text-ink">{r.value}</dd>
            </div>
          ))}
        </dl>
      </LiffSection>
      <LiffSection id="payment-run-flags" title={t('flaggedHeading', { count: flagged.length })}>
        {flagged.length === 0 ? (
          <p className="text-ink-muted">{t('noFlags')}</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {flagged.map((i) => (
              <li key={i.supplierCode} className="flex flex-col gap-1 border-l-2 border-warn pl-3">
                <p className="font-medium text-ink">{`${i.supplierCode} · ${i.supplierName}`}</p>
                <p className="tabular text-ink">{`${formatSatang(i.transferSatang)} ${t('unit')}${i.accountLast4 ? ` · ••••${i.accountLast4}` : ''}`}</p>
                <p className="text-warn-ink">{i.flags.map((f) => t(`flag.${f}`)).join(' · ')}</p>
                <p className="break-words text-ink-muted">{i.flagReason ? t('reason', { reason: i.flagReason }) : t('noReason')}</p>
              </li>
            ))}
          </ul>
        )}
      </LiffSection>
    </>
  )
}
