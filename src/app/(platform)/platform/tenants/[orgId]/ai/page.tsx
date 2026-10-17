import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { platformCtx } from '@/server/auth/session'
import { creditSummary } from '@/server/services/ai'
import { getTenant } from '@/server/services/platform/tenants'
import { AiCreditGrant } from '@/ui/admin/ai-credit-grant'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/shadcn/table'
import { getPlatformSession } from '../../../../../_lib/session'
import { grantCreditsAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('platform.ai')
  return { title: t('titleShort') }
}

// AI credits of one customer for the BCS team (docs/sub-specs/S13.md "หน้าจอ" and "ฐานของโมดูล" AC2): the month's
// credits, the grants of the month, and a form to grant more or set the monthly amount. No business data is shown.
export default async function TenantAiPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params
  const state = await getPlatformSession()
  const [t, locale] = await Promise.all([getTranslations('platform.ai'), getLocale()])
  if (state.kind !== 'platform-admin') return null
  const tenant = await getTenant(state.platformAdminId, orgId)
  if (!tenant.ok && tenant.error.code === 'NOT_FOUND') notFound()
  const ctx = tenant.ok ? platformCtx(state, tenant.data.id, systemClock.now()) : null
  const summary = ctx ? await creditSummary(ctx) : null
  if (!tenant.ok || !summary?.ok) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('titleShort')}</h1>
        <Notice tone="danger">{t('errors.FORBIDDEN')}</Notice>
      </div>
    )
  }
  const c = summary.data
  const n = (v: number) => new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'th-TH').format(v)

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Link href="/platform/tenants" className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
        {t('back')}
      </Link>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title', { name: tenant.data.name })}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </div>
      <p>{t('balance', { used: n(c.used), granted: n(c.granted), remaining: n(c.remaining), monthly: n(c.monthlyCredits) })}</p>
      <section aria-labelledby="ai-grants" className="flex flex-col gap-2">
        <h2 id="ai-grants" className="text-lg font-semibold">
          {t('grantsTitle')}
        </h2>
        {c.grants.length ? (
          <>
            {/* On a phone each grant is a row of the list (§9.9: no table wider than the screen; P1-09) */}
            <ul aria-label={t('grantsTitle')} className="flex flex-col divide-y divide-line border-y border-line md:hidden">
              {c.grants.map((g, i) => (
                <li key={`${g.occurredAt}-${i}`} className="flex flex-col gap-1 py-3">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="text-ink">{g.source === 'TOPUP' ? t('sources.TOPUP') : t('sources.MONTHLY')}</span>
                    <span className="text-right tabular-nums text-ink">{n(g.credits)}</span>
                  </span>
                  <span className="text-ink-muted">{formatDateTime(locale, g.occurredAt)}</span>
                  {g.contractRef ? <span className="break-words text-ink-muted">{`${t('columns.contractRef')}: ${g.contractRef}`}</span> : null}
                </li>
              ))}
            </ul>
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('columns.when')}</TableHead>
                    <TableHead>{t('columns.source')}</TableHead>
                    <TableHead className="text-right">{t('columns.credits')}</TableHead>
                    <TableHead>{t('columns.contractRef')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {c.grants.map((g, i) => (
                    <TableRow key={`${g.occurredAt}-${i}`}>
                      <TableCell>{formatDateTime(locale, g.occurredAt)}</TableCell>
                      <TableCell>{g.source === 'TOPUP' ? t('sources.TOPUP') : t('sources.MONTHLY')}</TableCell>
                      <TableCell className="text-right tabular-nums">{n(g.credits)}</TableCell>
                      <TableCell>{g.contractRef ?? '-'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        ) : (
          <p className="text-ink-muted">{t('noGrants')}</p>
        )}
      </section>
      <section aria-labelledby="ai-grant-form" className="flex flex-col gap-3">
        <h2 id="ai-grant-form" className="text-lg font-semibold">
          {t('formTitle')}
        </h2>
        <AiCreditGrant organizationId={tenant.data.id} grant={grantCreditsAction} />
      </section>
    </div>
  )
}
