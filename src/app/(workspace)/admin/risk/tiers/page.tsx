import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { riskTiersAdminView } from '@/server/services/risk'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { RISK_TIERS, type RiskTierCodeUi } from '@/ui/risk-admin/model'
import { PolicyPanel, TiersPanel, type TierRowUi } from '@/ui/risk-admin/tiers'
import { getSession } from '../../../../_lib/session'
import { localeOf, when } from '../../../_tracking/present'
import { confirmPolicyAction, confirmTiersAction, discardPolicyAction, discardTiersAction, proposePolicyAction, proposeTiersAction } from '../actions'

export async function generateMetadata() {
  const t = await getTranslations('risk.admin.tiers')
  return { title: t('title') }
}

// /admin/risk/tiers (S11-04 · BR-RSK-02 · ADR-229 · §9.1 /admin/*): the three tiers of supplier risk and the policy of the
// PO gate, each as in effect and as proposed; a change takes effect only when someone other than its proposer confirms
// it. ORG_ADMIN or DOA_ADMIN with the RISK module (admin.riskTiers · ORG_ADMIN not once the DOA administrators are
// separated); the service checks it before anything is read.
export default async function RiskTiersPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, tCommon, locale] = await Promise.all([getTranslations('risk.admin'), getTranslations('adminSettings'), getLocale().then(localeOf)])
  const view = await riskTiersAdminView(ctx)
  if (!view.ok) return <NoAccess title={t('tiers.title')} message={view.error.code === 'MODULE_DISABLED' ? t('moduleOff') : tCommon('forbidden')} homeLabel={tCommon('homeLink')} />

  const tierName = Object.fromEntries(RISK_TIERS.map((c) => [c, t(`tierName.${c}`)])) as Record<RiskTierCodeUi, string>
  const tiers: TierRowUi[] = view.data.tiers.map((r) => ({
    code: r.code,
    name: locale === 'en' ? r.nameEn : r.nameTh,
    inEffect: { minPoints: r.inEffect.minPoints, reviewMonths: r.inEffect.reviewMonths, reminderDaysBefore: r.inEffect.reminderDaysBefore, blocksPo: r.inEffect.blocksPo, requiresExplicitAnswers: r.inEffect.requiresExplicitAnswers },
    pending: r.pending,
    pendingText: r.pendingByName && r.pendingAt ? t('proposedBy', { name: r.pendingByName, time: when(locale, r.pendingAt) }) : null,
    pendingByMe: r.pendingByMe,
    version: r.version,
  }))
  const actions = {
    proposeTiers: proposeTiersAction,
    confirmTiers: confirmTiersAction,
    discardTiers: discardTiersAction,
    proposePolicy: proposePolicyAction,
    confirmPolicy: confirmPolicyAction,
    discardPolicy: discardPolicyAction,
  }
  const p = view.data.policy

  return (
    <Page>
      <PageHeader title={t('tiers.title')} intro={t('tiers.intro')} />
      <PageBody>
        <Panel title={t('tiers.listTitle')} id="tiers">
          {tiers.length === 3 ? <TiersPanel tiers={tiers} actions={actions} /> : <p className="text-ink-muted">{t('tiers.notSeeded')}</p>}
        </Panel>
        <Panel title={t('policy.title')} id="policy">
          {p ? (
            <PolicyPanel
              tierName={tierName}
              actions={actions}
              policy={{
                inEffect: { ...p.inEffect, highRiskCategories: [...p.inEffect.highRiskCategories] },
                confirmed: p.confirmed,
                pending: p.pending,
                pendingText: p.pendingByName && p.pendingAt ? t('proposedBy', { name: p.pendingByName, time: when(locale, p.pendingAt) }) : null,
                pendingByMe: p.pendingByMe,
                version: p.version,
              }}
            />
          ) : (
            <p className="text-ink-muted">{t('policy.notSeeded')}</p>
          )}
        </Panel>
      </PageBody>
    </Page>
  )
}
