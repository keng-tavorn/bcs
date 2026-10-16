import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { BANK_CHANGE_TABS, listBankAccountChanges, listBankAccounts, type BankChangeTab } from '@/server/services/bank-accounts/view'
import { PayerAccountTable, type PayerAccountRowView } from '@/ui/bank-accounts/account-table'
import { BankTabs } from '@/ui/bank-accounts/bank-tabs'
import { ChangeTable, type ChangeRowView } from '@/ui/bank-accounts/change-table'
import { Notice } from '@/ui/form/notice'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { getSession } from '../../../_lib/session'
import { day, localeOf } from '../../_tracking/present'
import { changeOwnerText, personName, templateText } from './present'

// /finance/bank-accounts (S9-09, docs/sub-specs/S9.md "หน้าจอ", FR-PAY-102 AC5 AC7 AC8): in tabs, the organization's payer
// accounts — code, bank, the number masked, the account's name, the file template, status and the day in force — and
// the requests to change an account, the open ones (a draft or waiting for approval) and all of them, each opening its
// own page. FINANCE gets "เสนอเปลี่ยนบัญชี". The tab is in the address (it changes nothing). For bankAccount.view
// (FINANCE, PROCUREMENT, AUDITOR) with module PAY: the views check both before anything is read.

const TABS = ['payers', ...BANK_CHANGE_TABS] as const
type Tab = (typeof TABS)[number]

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
const one = (value: string | string[] | undefined): string | null => (typeof value === 'string' ? value : null)
const hrefOf = (tab: Tab) => (tab === 'payers' ? '/finance/bank-accounts' : `/finance/bank-accounts?tab=${tab}`)

export async function generateMetadata() {
  const t = await getTranslations('bankAccount.list')
  return { title: t('metaTitle') }
}

export default async function BankAccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('bankAccount'), getLocale().then(localeOf)])
  const asked = one((await searchParams).tab)
  const tab: Tab = (TABS as readonly string[]).includes(asked ?? '') ? (asked as Tab) : 'payers'
  const changeTab: BankChangeTab = tab === 'payers' ? 'open' : tab
  const [accounts, changes] = await Promise.all([listBankAccounts(ctx, { ownerKind: 'ORGANIZATION' }), listBankAccountChanges(ctx, { tab: changeTab })])
  if (!accounts.ok || !changes.ok) {
    const code = !accounts.ok ? accounts.error.code : !changes.ok ? changes.error.code : ''
    return (
      <Page>
        <PageHeader title={t('list.forbiddenTitle')} />
        <div className="flex max-w-2xl flex-col gap-4">
          <Notice tone="warning">{code === 'MODULE_DISABLED' ? t('list.moduleOff') : t('list.forbiddenHint')}</Notice>
          <Link href="/" className={linkClass}>
            {t('list.home')}
          </Link>
        </div>
      </Page>
    )
  }
  const list = changes.data
  const payers: PayerAccountRowView[] = accounts.data.map((a) => ({
    id: a.id,
    code: a.code ?? '-',
    bank: a.bankName ?? a.bankCode,
    number: a.accountNoMasked,
    name: a.accountName,
    template: templateText(t, a.fileTemplateCode),
    status: a.status,
    statusLabel: t(`accountStatus.${a.status}`),
    effective: a.activatedAt ? day(locale, a.activatedAt) : t('list.notInForce'),
  }))
  const rows: ChangeRowView[] = list.rows.map((r) => ({
    id: r.id,
    href: `/finance/bank-accounts/changes/${r.id}`,
    title: r.number ?? t('list.draftNumber'),
    kind: t(`kind.${r.kind}`),
    owner: changeOwnerText(t, locale, r),
    status: r.status,
    statusLabel: t(`status.${r.status}`),
    proposer: personName(locale, r.proposer),
    submitted: r.submittedAt ? day(locale, r.submittedAt) : t('list.notSubmitted'),
  }))
  const counts: Record<Tab, number> = { payers: accounts.data.length, open: list.counts.open, all: list.counts.all }
  const propose = list.canPropose ? (
    <Button asChild className="min-h-11 lg:min-h-10">
      <Link href="/finance/bank-accounts/changes/new">{t('list.propose')}</Link>
    </Button>
  ) : null

  return (
    <Page>
      <PageHeader title={t('list.title')} intro={t('list.intro')} actions={propose} />
      <PageBody>
        <Panel label={t('tabs.label')}>
          <BankTabs current={tab} label={t('tabs.label')} tabs={TABS.map((key) => ({ key, label: t(`tabs.${key}`, { count: counts[key] }), href: hrefOf(key) }))}>
            {tab === 'payers' ? (
              payers.length ? (
                <PayerAccountTable
                  rows={payers}
                  labels={{
                    list: t('payers.list'),
                    code: t('payers.code'),
                    bank: t('payers.bank'),
                    number: t('payers.number'),
                    name: t('payers.name'),
                    template: t('payers.template'),
                    status: t('payers.status'),
                    effective: t('payers.effective'),
                  }}
                />
              ) : (
                <ListEmpty title={t('payers.empty')} hint={t('payers.emptyHint')} actions={propose} />
              )
            ) : rows.length ? (
              <>
                <ChangeTable
                  rows={rows}
                  labels={{
                    list: t(`changes.list.${changeTab}`),
                    number: t('changes.number'),
                    kind: t('changes.kind'),
                    owner: t('changes.owner'),
                    status: t('changes.status'),
                    proposer: t('changes.proposer'),
                    submitted: t('changes.submitted'),
                  }}
                />
                {list.limited ? <p className="text-ink-muted">{t('changes.limited', { shown: rows.length })}</p> : null}
              </>
            ) : (
              <ListEmpty title={t(`changes.empty.${changeTab}`)} hint={t(`changes.emptyHint.${changeTab}`)} actions={propose} />
            )}
          </BankTabs>
        </Panel>
      </PageBody>
    </Page>
  )
}
