import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listNotebook } from '@/server/services/assistants/notebook'
import { creditSummary, listAgentActivity, listAgentSettings, listSettingChanges, monthResults } from '@/server/services/ai'
import { requireModule } from '@/server/services/modules'
import { AiAgentRow } from '@/ui/admin/ai-agent-row'
import { AiNotebook } from '@/ui/admin/ai-notebook'
import { AiActivity, AiMonthResults, AiSettingChanges, monthLabel } from '@/ui/admin/ai-report'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { formatDateTime } from '@/ui/format'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Progress } from '@/ui/shadcn/progress'
import { getSession } from '../../../_lib/session'
import { setLearningAction, updateAgentAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('admin.ai')
  return { title: t('title') }
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>

// The organization's AI assistants (docs/sub-specs/S13.md "หน้าจอ" and "ฐานของโมดูล" AC1 AC2): ORG_ADMIN switches each
// agent on or off and sets the confidence below which a field is confirmed one by one, and sees the month's credits.
// Credits are granted by the BCS team only (/platform/tenants/[orgId]/ai). NEW-125 (ADR-081): ORG_ADMIN and AUDITOR
// (admin.ai.view) also read the month's results, the assistants' notebook, the history of the settings and of the work
// (?show= month= agent= before= filter it, each number of the results links there); AUDITOR reads without the buttons.
export default async function AiSettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, tMembers, locale] = await Promise.all([getTranslations('admin.ai'), getTranslations('admin.members'), getLocale()])
  if (!ctx) return null
  const params = await searchParams
  const one = (key: string) => (typeof params[key] === 'string' ? params[key] : undefined)
  const asked = { show: one('show'), month: one('month'), agent: one('agent'), before: one('before') } as Parameters<typeof listAgentActivity>[1]
  const [agents, credits, aiModule, results, notebook, changes, filtered] = await Promise.all([
    listAgentSettings(ctx),
    creditSummary(ctx),
    requireModule(ctx, 'AI'),
    monthResults(ctx),
    listNotebook(ctx),
    listSettingChanges(ctx),
    listAgentActivity(ctx, asked),
  ])
  // A filter typed by hand that does not parse shows the whole history instead
  const activity = filtered.ok || filtered.error.code !== 'VALIDATION_FAILED' ? filtered : await listAgentActivity(ctx)
  if (!agents.ok || !credits.ok || !results.ok || !notebook.ok || !changes.ok || !activity.ok) {
    return <NoAccess title={t('title')} message={t('forbidden')} homeLabel={tMembers('homeLink')} />
  }
  const c = credits.data
  const canManage = results.data.access.canManage
  // Credits are whole numbers, grouped as the reader's language groups them
  const n = (v: number) => new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'th-TH').format(v)
  const usedPercent = c.granted > 0 ? Math.min(100, Math.round((c.used * 100) / c.granted)) : 0
  const agentNames = Object.fromEntries(agents.data.map((a) => [a.agent, t(`agents.${a.agent}.name`)]))
  const nameOf = (v: { th: string; en: string | null }) => (locale === 'en' ? (v.en ?? v.th) : v.th)

  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')} />
      <PageBody>
        {aiModule.ok ? null : <Notice tone="info">{t('moduleOff')}</Notice>}
        {canManage ? null : <Notice tone="info">{t('readOnly')}</Notice>}
        <Panel title={t('results.title', { month: monthLabel(locale, results.data.month) })} id="ai-results" className="max-w-3xl">
          <AiMonthResults data={results.data} agentNames={agentNames} />
        </Panel>
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
                name={agentNames[a.agent]!}
                description={t(`agents.${a.agent}.description`)}
                enabled={a.enabled}
                minConfidenceBp={a.minConfidenceBp}
                version={a.version}
                meta={
                  a.version < 0 || !a.updatedAt
                    ? t('agentNeverSaved')
                    : a.updatedBy
                      ? t('agentVersion', { version: a.version + 1, name: nameOf(a.updatedBy), at: formatDateTime(locale, a.updatedAt) })
                      : t('agentVersionSystem', { version: a.version + 1, at: formatDateTime(locale, a.updatedAt) })
                }
                readOnly={!canManage}
                update={updateAgentAction}
              />
            ))}
          </ul>
        </Panel>
        <Panel title={t('notebook.title')} id="ai-notebook" className="max-w-3xl">
          <p className="text-ink-muted">{t('notebook.intro')}</p>
          <Notice tone="info">{t('notebook.privacy')}</Notice>
          {notebook.data.payOn ? (
            <>
              {notebook.data.total > notebook.data.entries.length ? (
                <p className="text-base text-ink-muted md:text-sm">{t('notebook.truncated', { shown: n(notebook.data.entries.length), total: n(notebook.data.total) })}</p>
              ) : null}
              <AiNotebook entries={notebook.data.entries} canManage={notebook.data.canManage} windowDays={notebook.data.windowDays} update={setLearningAction} />
            </>
          ) : (
            <p className="text-ink-muted">{t('notebook.payOff')}</p>
          )}
        </Panel>
        <Panel title={t('changes.title')} id="ai-changes" className="max-w-3xl">
          <p className="text-ink-muted">{t('changes.intro')}</p>
          <AiSettingChanges changes={changes.data} agentNames={agentNames} />
        </Panel>
        <Panel title={t('activity.title')} id="ai-activity">
          <AiActivity data={{ filter: activity.data.filter, rows: activity.data.rows, before: activity.data.before, paged: filtered.ok && Boolean(asked?.before) }} agentNames={agentNames} />
        </Panel>
      </PageBody>
    </Page>
  )
}
