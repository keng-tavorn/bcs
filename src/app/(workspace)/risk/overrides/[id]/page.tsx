import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { z } from 'zod'
import { formatSatang } from '@/core/money/format'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { riskOverrideView } from '@/server/services/risk'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { StatusBadge } from '@/ui/document/badges'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Facts, Section } from '@/ui/request-view/facts'
import { RiskOverrideFacts } from '@/ui/risk-override/facts'
import { bahtField, OVERRIDE_BADGES, type OverrideStatus } from '@/ui/risk-override/model'
import { OverrideButtons } from '@/ui/risk-override/override-actions'
import { OverrideForm } from '@/ui/risk-override/override-form'
import { getSession } from '../../../../_lib/session'
import { localeOf, when } from '../../../_tracking/present'
import { cancelOverrideAction, submitOverrideAction, updateOverrideAction } from '../actions'

export async function generateMetadata() {
  const t = await getTranslations('risk.override.detail')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// /risk/overrides/[id] (S11-08 · FR-RSK-203 AC2 AC3 · BR-RSK-10 BR-RSK-11): one override of the risk gate — what its
// approvers decide on (the supplier, its tier and where it comes from, its assessment, the registry flag, the cap with
// VAT, the last day, the PO it names, the reason, who asked), where its DOA route stands, the approver's words of a return
// or a rejection, and the POs it let out with what of the cap each holds. Whoever reads the risk files and whoever has a
// task on it reads it (riskOverrideView checks); its requester edits, sends or cancels it while it is a draft or returned.

export default async function RiskOverridePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, tAdmin, tCommon, locale] = await Promise.all([getTranslations('risk.override'), getTranslations('risk.admin'), getTranslations('adminSettings'), getLocale().then(localeOf)])
  const read = await riskOverrideView(ctx, id)
  if (!read.ok) {
    if (read.error.code === 'NOT_FOUND') notFound()
    return <NoAccess title={t('detail.title')} message={read.error.code === 'MODULE_DISABLED' ? tAdmin('moduleOff') : tCommon('forbidden')} homeLabel={tCommon('homeLink')} />
  }
  const o = read.data
  const status = o.status as OverrideStatus
  const hint = status === 'DRAFT' ? t('detail.hint.DRAFT') : status === 'RETURNED' ? t('detail.hint.RETURNED') : status === 'PENDING_APPROVAL' ? t('detail.hint.PENDING_APPROVAL') : status === 'APPROVED' ? t('detail.hint.APPROVED') : null
  const route = o.route
    ? [
        { label: t('detail.rule'), value: o.route.ruleCode },
        ...(o.route.approver ? [{ label: t('detail.waitingFor'), value: locale === 'en' && o.route.approver.nameEn ? o.route.approver.nameEn : o.route.approver.nameTh }] : []),
      ]
    : []

  return (
    <Page>
      <Link href="/risk/overrides" className={linkClass}>
        {t('toList')}
      </Link>
      <PageHeader title={o.number ? t('detail.heading', { number: o.number }) : t('detail.draftHeading')} intro={`${o.supplier.code} ${o.supplier.nameTh}`}>
        <StatusBadge look={OVERRIDE_BADGES[status]} label={t(`status.${status}`)} className="self-start text-base md:text-sm" />
      </PageHeader>
      <PageBody>
        {o.lastDecision ? (
          <Notice tone={o.lastDecision.outcome === 'REJECTED' ? 'danger' : 'warning'}>
            <p className="font-semibold">{t(`detail.decision.${o.lastDecision.outcome}`)}</p>
            {o.lastDecision.reason ? <p className="break-words whitespace-pre-line">{o.lastDecision.reason}</p> : null}
          </Notice>
        ) : null}
        <Panel label={t('detail.title')}>
          <div className="flex flex-col gap-6">
            <RiskOverrideFacts view={o} used />
            {hint ? <p className="text-ink-muted">{hint}</p> : null}
            {route.length ? (
              <Section id="override-route" title={t('detail.route')}>
                <Facts items={route} />
                {o.route?.openTaskId ? (
                  <Link href={`/tasks/${o.route.openTaskId}`} className={linkClass}>
                    {t('detail.openTask')}
                  </Link>
                ) : null}
              </Section>
            ) : null}
            {o.posUsing.length ? (
              <Section id="override-pos" title={t('detail.posUsing')}>
                <ul className="flex flex-col gap-1">
                  {o.posUsing.map((p) => (
                    <li key={p.id} className="flex flex-wrap gap-x-3">
                      <Link href={`/procurement/pos/${p.id}`} className="font-medium text-primary underline underline-offset-4 hover:no-underline">
                        {p.number ?? t('facts.poDraft')}
                      </Link>
                      <span className="money text-ink">{t('detail.poShare', { amount: formatSatang(p.countedGrossSatang) })}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}
            {o.canEdit ? (
              <>
                <Section id="override-send" title={t('detail.actions')}>
                  <OverrideButtons version={o.version} actions={{ submit: submitOverrideAction.bind(null, o.id), cancel: cancelOverrideAction.bind(null, o.id) }} />
                </Section>
                <Section id="override-edit" title={t('detail.edit')}>
                  <OverrideForm
                    key={o.version}
                    initial={{ reason: o.reason, capGross: bahtField(o.capGrossSatang), expiresOn: o.expiresOn >= o.today && o.expiresOn <= o.lastAllowed ? o.expiresOn : '' }}
                    today={o.today}
                    lastAllowed={o.lastAllowed}
                    save={updateOverrideAction.bind(null, o.id, o.version)}
                    after="REFRESH"
                  />
                </Section>
              </>
            ) : null}
            <p className="text-ink-muted">{t('detail.asked', { time: when(locale, o.createdAt) })}</p>
          </div>
        </Panel>
      </PageBody>
    </Page>
  )
}
