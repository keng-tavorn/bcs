import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { creditSummary, listAgentSettings } from '@/server/services/ai'
import { requireModule } from '@/server/services/modules'
import { AiAgentRow } from '@/ui/admin/ai-agent-row'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Progress } from '@/ui/shadcn/progress'
import { getSession } from '../../../_lib/session'
import { updateAgentAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('admin.ai')
  return { title: t('title') }
}

// The organization's AI assistants (docs/sub-specs/S13.md "หน้าจอ" and "ฐานของโมดูล" AC1 AC2): ORG_ADMIN switches each
// agent on or off and sets the confidence below which a field is confirmed one by one, and sees the month's credits.
// Credits are granted by the BCS team only (/platform/tenants/[orgId]/ai).
export default async function AiSettingsPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, tMembers, locale] = await Promise.all([getTranslations('admin.ai'), getTranslations('admin.members'), getLocale()])
  if (!ctx) return null
  const [agents, credits, aiModule] = await Promise.all([listAgentSettings(ctx), creditSummary(ctx), requireModule(ctx, 'AI')])
  if (!agents.ok || !credits.ok) return <NoAccess title={t('title')} message={t('forbidden')} homeLabel={tMembers('homeLink')} />
  const c = credits.data
  // Credits are whole numbers, grouped as the reader's language groups them
  const n = (v: number) => new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'th-TH').format(v)
  const usedPercent = c.granted > 0 ? Math.min(100, Math.round((c.used * 100) / c.granted)) : 0

  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')} />
      <PageBody>
        {aiModule.ok ? null : <Notice tone="info">{t('moduleOff')}</Notice>}
        <Panel title={t('creditsTitle')} id="ai-credits" className="max-w-3xl">
          <p>{t('creditsUsed', { used: n(c.used), granted: n(c.granted), remaining: n(c.remaining) })}</p>
          <Progress value={usedPercent} aria-label={t('creditsProgress', { percent: usedPercent })} />
          <p className="text-base text-ink-muted md:text-sm">{t('creditsNote', { monthly: n(c.monthlyCredits), alert: c.alertAtBp / 100 })}</p>
        </Panel>
        <Panel title={t('agentsTitle')} id="ai-agents" className="max-w-3xl">
          <ul className="flex flex-col divide-y divide-line">
            {agents.data.map((a) => (
              <AiAgentRow
                key={a.agent}
                agent={a.agent}
                name={t(`agents.${a.agent}.name`)}
                description={t(`agents.${a.agent}.description`)}
                enabled={a.enabled}
                minConfidenceBp={a.minConfidenceBp}
                version={a.version}
                update={updateAgentAction}
              />
            ))}
          </ul>
        </Panel>
      </PageBody>
    </Page>
  )
}
