import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getBankAccountChangeForm } from '@/server/services/bank-accounts/view'
import { ChangeForm, type BankSupplierView, type BankTargetView } from '@/ui/bank-accounts/change-form'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader } from '@/ui/page/page'
import { completeUploadAction, requestUploadAction } from '../../../../../_lib/file-actions'
import { getSession } from '../../../../../_lib/session'
import { localeOf } from '../../../../_tracking/present'
import { attachProofAction, createChangeAction, recordCallAction, submitChangeAction } from '../../actions'
import { accountText, bankChoiceText } from '../../present'

// /finance/bank-accounts/changes/new (S9-09, FR-PAY-102 AC7, BR-SUP-06): FINANCE proposes adding, replacing or closing a
// supplier's account or one of the organization's (src/ui/bank-accounts/change-form.tsx). ?supplier=<id> opens it with
// the supplier chosen — the supplier card's "เสนอเปลี่ยนบัญชี" — replacing the account in force, or adding one when there
// is none. The view gives the choices (banks, suppliers with their account in force, the organization's accounts, every
// number masked) only to bankAccountChange.propose with module PAY.

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
const one = (value: string | string[] | undefined): string | null => (typeof value === 'string' ? value : null)

export async function generateMetadata() {
  const t = await getTranslations('bankAccount.new')
  return { title: t('metaTitle') }
}

export default async function NewBankAccountChangePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('bankAccount'), getLocale().then(localeOf)])
  const form = await getBankAccountChangeForm(ctx)
  if (!form.ok) {
    return (
      <Page>
        <PageHeader title={t('new.forbiddenTitle')} />
        <div className="flex max-w-2xl flex-col gap-4">
          <Notice tone="warning">{form.error.code === 'MODULE_DISABLED' ? t('list.moduleOff') : t('new.forbiddenHint')}</Notice>
          <Link href="/finance/bank-accounts" className={linkClass}>
            {t('new.back')}
          </Link>
        </div>
      </Page>
    )
  }
  const { banks, suppliers, organizationAccounts } = form.data
  const changeHref = (id: string | null) => (id ? `/finance/bank-accounts/changes/${id}` : null)
  const supplierViews: BankSupplierView[] = suppliers.map((s) => {
    const name = locale === 'en' && s.nameEn ? s.nameEn : s.nameTh
    return {
      id: s.id,
      label: s.active ? t('form.supplierChoice', { code: s.code, name }) : t('form.supplierChoiceInactive', { code: s.code, name }),
      phone: s.phone,
      account: s.account ? { id: s.account.id, label: accountText(s.account), openChangeHref: changeHref(s.account.openChangeId) } : null,
      openChangeHref: changeHref(s.openChangeId),
    }
  })
  const companyViews: BankTargetView[] = organizationAccounts.map((a) => ({ id: a.id, label: accountText(a), openChangeHref: changeHref(a.openChangeId) }))
  const asked = one((await searchParams).supplier)
  const chosen = asked ? (suppliers.find((s) => s.id === asked) ?? null) : null

  return (
    <Page>
      <div className="flex flex-col gap-3">
        <Link href="/finance/bank-accounts" className={linkClass}>
          {t('new.back')}
        </Link>
        <PageHeader title={t('new.title')} intro={t('new.intro')} />
      </div>
      <PageBody>
        <ChangeForm
          banks={banks.map((b) => ({ value: b.code, label: bankChoiceText(b) }))}
          suppliers={supplierViews}
          companyAccounts={companyViews}
          initial={{ ownerKind: 'SUPPLIER', supplierId: chosen?.id ?? null, kind: chosen ? (chosen.account ? 'REPLACE' : 'ADD') : 'ADD' }}
          actions={{ create: createChangeAction, attach: attachProofAction, recordCall: recordCallAction, submit: submitChangeAction, requestUpload: requestUploadAction, completeUpload: completeUploadAction }}
        />
      </PageBody>
    </Page>
  )
}
