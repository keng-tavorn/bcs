import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { z } from 'zod'
import { formatSatang } from '@/core/money/format'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { riskOverrideForm } from '@/server/services/risk'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Facts } from '@/ui/request-view/facts'
import { bahtField } from '@/ui/risk-override/model'
import { OverrideForm } from '@/ui/risk-override/override-form'
import { getSession } from '../../../../_lib/session'
import { requestOverrideAction } from '../actions'

export async function generateMetadata() {
  const t = await getTranslations('risk.override.form')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// /risk/overrides/new?poId= (or ?supplierId=) (S11-08 · FR-RSK-203 AC2 · BR-RSK-10): PROCUREMENT asks for an override of
// the risk gate — opened from the band of a PO the gate holds, so it names that PO, its cap starting at the PO's gross
// with VAT. Kept as a draft, it opens its page, where it is sent to its approvers. A supplier that already has one open
// shows the way to it instead; a DOA without a RISK_OVERRIDE rule, a flagged supplier or a reader without
// risk.override.request get the reason, never the form (FR-RSK-203 AC2).

export default async function NewRiskOverridePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const q = await searchParams
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
  const uuid = (v: string | undefined) => (v && z.uuid().safeParse(v).success ? v : undefined)
  const poId = uuid(one(q.poId))
  const supplierId = uuid(one(q.supplierId))
  const [t, tAdmin, tCommon] = await Promise.all([getTranslations('risk.override'), getTranslations('risk.admin'), getTranslations('adminSettings')])
  if (!poId && !supplierId) {
    return (
      <Page>
        <PageHeader title={t('form.title')} />
        <PageBody>
          <Notice tone="info">{t('form.fromPo')}</Notice>
          <Link href="/risk/overrides" className={linkClass}>
            {t('toList')}
          </Link>
        </PageBody>
      </Page>
    )
  }
  const form = await riskOverrideForm(ctx, { ...(poId ? { poId } : {}), ...(supplierId ? { supplierId } : {}) })
  if (!form.ok) {
    const code = form.error.code
    const reason = typeof form.error.details?.reason === 'string' ? form.error.details.reason : null
    const message =
      code === 'MODULE_DISABLED'
        ? tAdmin('moduleOff')
        : code === 'DOA_NOT_CONFIGURED'
          ? t('form.noRule')
          : reason === 'REGISTRY_BLOCKED'
            ? t('form.flagged')
            : reason === 'SUPPLIER_INACTIVE'
              ? t('form.inactive')
              : code === 'NOT_FOUND'
                ? t('form.notFound')
                : tCommon('forbidden')
    return <NoAccess title={t('form.title')} message={message} homeLabel={tCommon('homeLink')} />
  }
  const f = form.data
  const facts = [
    { label: t('facts.supplier'), value: `${f.supplier.code} ${f.supplier.nameTh}` },
    { label: t('facts.po'), value: f.po ? t('facts.poValue', { number: f.po.number ?? t('facts.poDraft'), amount: formatSatang(f.po.grossSatang) }) : t('facts.poAll') },
  ]
  // the supplier and the PO travel bound to the action; the service checks them again
  const save = requestOverrideAction.bind(null, f.supplier.id, f.po?.id ?? null)

  return (
    <Page>
      <Link href={f.po ? `/procurement/pos/${f.po.id}` : '/risk/overrides'} className={linkClass}>
        {f.po ? t('form.backToPo') : t('toList')}
      </Link>
      <PageHeader title={t('form.title')} intro={t('form.intro')} />
      <PageBody>
        <Panel label={t('form.title')}>
          <div className="flex flex-col gap-6">
            <Facts items={facts} />
            {f.open ? (
              <Notice tone="warning">
                <p>{t('form.openExists', { number: f.open.number ?? t('list.draft') })}</p>
                <Link href={`/risk/overrides/${f.open.id}`} className={linkClass}>
                  {t('form.openLink')}
                </Link>
              </Notice>
            ) : (
              <OverrideForm initial={{ reason: '', capGross: f.po ? bahtField(f.po.grossSatang) : '', expiresOn: '' }} today={f.today} lastAllowed={f.lastAllowed} save={save} after="OPEN" />
            )}
          </div>
        </Panel>
      </PageBody>
    </Page>
  )
}
