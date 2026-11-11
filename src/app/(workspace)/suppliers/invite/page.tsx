import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listInvitableSuppliers } from '@/server/services/suppliers/applications-view'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { InviteForm } from '@/ui/supplier-applications/invite-form'
import { cn } from '@/ui/cn'
import { getSession } from '../../../_lib/session'
import { inviteSupplierAction } from '../applications/actions'

// /suppliers/invite (S7-09 · BR-SUP ข้อ 08): PROCUREMENT invites a new supplier (?kind=new, the default) or a registered
// one to the portal (?kind=existing); the two are links, so each form stays within eight fields (§9.9).

export async function generateMetadata() {
  const t = await getTranslations('supplierApplications.invite')
  return { title: t('title') }
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function InvitePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const kind = one((await searchParams).kind) === 'existing' ? 'EXISTING' : 'NEW'
  const t = await getTranslations('supplierApplications')
  const suppliers = await listInvitableSuppliers(ctx)
  if (!suppliers.ok) {
    return (
      <Page>
        <PageHeader title={t('invite.title')} />
        <PageBody>
          <Notice tone="warning">{suppliers.error.code === 'MODULE_DISABLED' ? t('list.moduleOff') : t('actions.errors.FORBIDDEN')}</Notice>
        </PageBody>
      </Page>
    )
  }
  const tab = (k: 'NEW' | 'EXISTING', label: string) => (
    <Link
      href={k === 'NEW' ? '/suppliers/invite' : '/suppliers/invite?kind=existing'}
      aria-current={kind === k ? 'page' : undefined}
      className={cn('-mb-px inline-flex min-h-11 items-center border-b-2 font-medium lg:min-h-10', kind === k ? 'border-primary text-ink' : 'border-transparent text-ink-muted hover:text-ink')}
    >
      {label}
    </Link>
  )
  return (
    <Page>
      <PageHeader title={t('invite.title')} intro={t('invite.intro')}>
        <nav aria-label={t('invite.kind')} className="border-b border-line">
          <ul className="flex flex-wrap gap-x-6">
            <li>{tab('NEW', t('invite.kindNew'))}</li>
            <li>{tab('EXISTING', t('invite.kindExisting'))}</li>
          </ul>
        </nav>
      </PageHeader>
      <PageBody>
        <Panel label={t('invite.title')}>
          <InviteForm key={kind} kind={kind} suppliers={suppliers.data} invite={inviteSupplierAction} />
        </Panel>
        <Link href="/suppliers/applications" className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
          {t('detail.back')}
        </Link>
      </PageBody>
    </Page>
  )
}
