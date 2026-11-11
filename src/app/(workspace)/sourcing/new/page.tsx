import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { newRfxContext } from '@/server/services/sourcing/rfx-setup'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { NewRfxForm } from '@/ui/sourcing/new-rfx-form'
import { SetupStepNav } from '@/ui/sourcing/setup-steps'
import { getSession } from '../../../_lib/session'
import { createRfxAction } from '../actions'

export async function generateMetadata() {
  const t = await getTranslations('sourcing.setup')
  return { title: t('new.title') }
}

// /sourcing/new (S10-12): a new RFx — from the lines ticked in the pool (?lines=<ids>, "เปิด RFx จากบรรทัดที่เลือก") or
// from a need procurement types. GET reads only; the draft is made by the form's command (rfx.create). Then its other
// steps open on /sourcing/[id]/edit. For sourcing.manage (PROCUREMENT); the command checks it again.

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

export default async function NewRfxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const params = await searchParams
  const raw = Array.isArray(params.lines) ? params.lines.join(',') : (params.lines ?? '')
  const asked = raw ? raw.split(',').slice(0, 200) : []
  const [t, tCommon] = await Promise.all([getTranslations('sourcing.setup'), getTranslations('adminSettings')])
  const read = await newRfxContext(ctx, asked)
  if (!read.ok) return <NoAccess title={t('new.title')} message={read.error.code === 'MODULE_DISABLED' ? t('errors.MODULE_DISABLED') : tCommon('forbidden')} homeLabel={tCommon('homeLink')} />
  const c = read.data
  const fromPool = asked.length > 0
  const steps = fromPool
    ? [{ key: 'general', label: t('step.general'), href: null, done: false }, ...(['suppliers', 'scorecard', 'schedule', 'review'] as const).map((k) => ({ key: k, label: t(`step.${k}`), href: null, done: false }))]
    : (['general', 'lines', 'suppliers', 'scorecard', 'schedule', 'review'] as const).map((k) => ({ key: k, label: t(`step.${k}`), href: null, done: false }))

  return (
    <Page>
      <PageHeader title={t('new.title')} intro={fromPool ? t('new.introPool') : t('new.introNeed')} />
      <PageBody>
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] lg:items-start lg:gap-6">
          <SetupStepNav steps={steps} current="general" label={t('stepsLabel')} doneLabel={t('stepDone')} />
          <Panel title={t('step.general')} id="rfx-new">
            {fromPool && c.lines.length === 0 ? (
              <div className="flex flex-col gap-3">
                <Notice tone="warning">{t('new.poolGone')}</Notice>
                <Link href="/procurement/pool" className={linkClass}>
                  {t('new.backToPool')}
                </Link>
              </div>
            ) : !fromPool && c.categories.length === 0 ? (
              <Notice tone="warning">{t('new.noCatalog')}</Notice>
            ) : (
              <div className="flex flex-col gap-4">
                {c.missing > 0 ? <Notice tone="warning">{t('new.poolMissing', { count: c.missing })}</Notice> : null}
                <NewRfxForm
                  poolLines={c.lines.map((l) => ({ requestLineId: l.requestLineId, label: t('new.poolLine', { request: l.requestNo, no: l.lineNo, description: l.description }), quantity: `${l.quantity} ${l.uom}`, categoryCode: l.categoryCode }))}
                  categories={c.categories}
                  catalog={c.catalog.map((i) => ({ id: i.id, label: `${i.code} · ${i.name}`, name: i.name, uom: i.uom, categoryCode: i.categoryCode, refUnitPrice: i.refUnitPrice }))}
                  vatInclusiveAllowed={c.vatInclusiveAllowed}
                  create={createRfxAction}
                />
              </div>
            )}
          </Panel>
        </div>
      </PageBody>
    </Page>
  )
}
