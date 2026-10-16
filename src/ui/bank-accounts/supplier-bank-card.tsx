import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai'
import { Notice } from '../form/notice'
import { Panel } from '../page/page'
import { Facts, type Fact } from '../request-view/facts'
import { Button } from '../shadcn/button'
import type { RevealOutcome } from './outcome'
import { RevealNumbers } from './reveal'

// The card "บัญชีรับเงิน" of a supplier's page (S9-09, FR-PAY-102 AC7 AC8, docs/sub-specs/S9.md "หน้าจอ"): the account the
// supplier is paid into — bank, the number masked to its last four digits, the account's name, its branch and the day it
// came into force — with "ดูเลขเต็ม" for FINANCE (logged), a request still open for the supplier, and "เสนอเปลี่ยนบัญชี"
// (or "เสนอเพิ่มบัญชี" when there is none) for FINANCE, which opens the proposal form with the supplier chosen. Shown only
// when the organization has PAY and the reader has bankAccount.view (getSupplierBankCard gives null otherwise); every
// button is a convenience, the services check again.

/** The card's data (getSupplierBankCard of src/server/services/bank-accounts/view.ts has this shape) */
export interface SupplierBankCardView {
  readonly account: {
    readonly id: string
    readonly bankCode: string
    readonly bankName: string | null
    readonly accountNoMasked: string
    readonly accountName: string
    readonly branchName: string | null
    readonly activatedAt: string | null
  } | null
  readonly pending: { readonly id: string; readonly number: string | null; readonly kind: 'ADD' | 'REPLACE' | 'CLOSE'; readonly status: 'DRAFT' | 'PENDING_APPROVAL' } | null
  readonly canReveal: boolean
  readonly canPropose: boolean
}

const LINK = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

export async function SupplierBankCard({ supplierId, card, reveal }: { supplierId: string; card: SupplierBankCardView; reveal: (input: unknown) => Promise<RevealOutcome> }) {
  const [t, tk, ts, locale] = await Promise.all([getTranslations('bankAccount.card'), getTranslations('bankAccount.kind'), getTranslations('bankAccount.status'), getLocale()])
  const day = (iso: string) => (locale === 'en' ? formatEnglishBeDate(iso) : formatThaiDate(iso))
  const a = card.account
  const facts: Fact[] = a
    ? [
        { label: t('bank'), value: a.bankName ?? a.bankCode },
        {
          label: t('number'),
          value: (
            <span className="flex flex-col gap-2">
              <span className="tabular">{a.accountNoMasked}</span>
              {card.canReveal ? <RevealNumbers reveal={reveal} input={{ bankAccountId: a.id }} rows={[{ key: 'accountNo', label: t('numberWhole') }]} /> : null}
            </span>
          ),
        },
        { label: t('name'), value: a.accountName },
        ...(a.branchName ? [{ label: t('branch'), value: a.branchName }] : []),
        { label: t('effective'), value: a.activatedAt ? day(a.activatedAt) : t('effectiveSeed') },
      ]
    : []
  const proposeHref = `/finance/bank-accounts/changes/new?supplier=${encodeURIComponent(supplierId)}`
  return (
    <Panel id="supplier-bank-account" title={t('title')}>
      {a ? (
        <>
          <Facts items={facts} />
          <p className="text-base text-ink-muted md:text-sm">{t('maskedNote')}</p>
        </>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="font-medium text-ink">{t('none')}</p>
          <p className="text-ink-muted">{t('noneHint')}</p>
        </div>
      )}
      {card.pending ? (
        <Notice tone="info">
          <p>{t('pending', { kind: tk(card.pending.kind), number: card.pending.number ?? t('draft'), status: ts(card.pending.status) })}</p>
          <Link href={`/finance/bank-accounts/changes/${card.pending.id}`} className={LINK}>
            {t('openPending')}
          </Link>
        </Notice>
      ) : card.canPropose ? (
        <Button asChild variant="outline" className="min-h-11 self-start lg:min-h-10">
          <Link href={proposeHref}>{a ? t('proposeChange') : t('proposeAdd')}</Link>
        </Button>
      ) : null}
    </Panel>
  )
}
