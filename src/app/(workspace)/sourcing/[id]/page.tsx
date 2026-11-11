import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { rfxSummariesOf } from '@/server/services/ai'
import { rfxDetail } from '@/server/services/sourcing/rfx-view'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { DocTabs, type DocTab } from '@/ui/document/doc-tabs'
import { tabFrom } from '@/ui/document/tab-param'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { RfxCommands } from '@/ui/sourcing/rfx-detail/commands'
import { RfxAiSummary } from '@/ui/sourcing/rfx-detail/ai-summary'
import { ComparisonView } from '@/ui/sourcing/rfx-detail/comparison'
import { AwardsTab, LinesTab, OverviewTab, QuestionsTab, RevisionsTab, RfxStatusBadge, ScoresTab, SealedBids, SuppliersTab } from '@/ui/sourcing/rfx-detail/panels'
import type { RfxDetailView } from '@/ui/sourcing/rfx-detail/model'
import { downloadUrlAction } from '../../../_lib/file-actions'
import { getSession } from '../../../_lib/session'
import { giveAiFeedbackAction } from '../../_shell/assistant-actions'
import { localeOf } from '../../_tracking/present'
import { amendRfxAction, answerQuestionAction, cancelRfxAction, closeRfxEarlyAction, concludeRfxAction, exportComparisonAction, extendRfxAction, openBidFileAction, summarizeRfxAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('sourcing.detail')
  return { title: t('metaTitle') }
}

// /sourcing/[id] (S10-12 · docs/sub-specs/S10.md "หน้าจอ"): one RFx inside — overview (status, deadlines, revision, the
// timeline of its events and procurement's commands), lines, suppliers, questions, revisions, bids, scores and awards.
// sourcing.view with the RFx as resource (rfxReading): a reader of its prices sees every tab, the amounts only once the
// envelope is open (BR-RFX-06); a requester of a source line sees the overview and the lines, never a price. The forms
// show for sourcing.manage while the state machine allows; the services check it all again. S10-16: after the close the
// tab of the bids carries the box "สรุปโดย AI" (BID_SUMMARY NEGOTIATION_POINTS · BR-AI-32) while the AI is on (EG-1).

export default async function RfxPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, tCommon, locale] = await Promise.all([getTranslations('sourcing.detail'), getTranslations('adminSettings'), getLocale().then(localeOf)])
  const read = await rfxDetail(ctx, id)
  if (!read.ok) {
    if (read.error.code === 'NOT_FOUND') notFound()
    return <NoAccess title={t('metaTitle')} message={read.error.code === 'MODULE_DISABLED' ? t('errors.MODULE_DISABLED') : tCommon('forbidden')} homeLabel={tCommon('homeLink')} />
  }
  const d: RfxDetailView = read.data
  const r = d.rfx
  const title = locale === 'en' && r.titleEn ? r.titleEn : r.title

  const commands =
    d.can.cancel || d.can.closeEarly || d.can.conclude ? (
      <RfxCommands
        version={r.version}
        can={{ cancel: d.can.cancel, closeEarly: d.can.closeEarly, conclude: d.can.conclude }}
        actions={{ cancel: cancelRfxAction.bind(null, id), closeEarly: closeRfxEarlyAction.bind(null, id), conclude: concludeRfxAction.bind(null, id) }}
      />
    ) : null

  const tabs: DocTab[] = [
    { value: 'overview', label: t('tabs.overview'), content: <OverviewTab d={d} locale={locale} commands={commands} /> },
    { value: 'lines', label: t('tabs.lines'), content: <LinesTab d={d} locale={locale} /> },
  ]
  if (d.reading === 'PRICES') {
    const bids = read.data.bids
    const ai = bids && !bids.sealed && bids.comparison ? await rfxSummariesOf(ctx, { id, kind: r.kind, status: r.status }) : null
    tabs.push(
      { value: 'suppliers', label: t('tabs.suppliers'), content: <SuppliersTab d={d} locale={locale} /> },
      { value: 'questions', label: t('tabs.questions', { count: d.questions.filter((q) => q.status === 'OPEN').length }), content: <QuestionsTab d={d} locale={locale} answer={answerQuestionAction.bind(null, id)} /> },
      { value: 'revisions', label: t('tabs.revisions'), content: <RevisionsTab d={d} locale={locale} amend={amendRfxAction.bind(null, id)} extend={extendRfxAction.bind(null, id)} /> },
      {
        value: 'bids',
        label: t('tabs.bids'),
        content: (
          <Panel title={t('bids.title')} id="rfx-bids">
            {!bids || bids.sealed || !bids.comparison ? (
              <SealedBids submitters={bids?.submitters ?? []} closesAt={r.closesAt} locale={locale} />
            ) : (
              <div className="flex flex-col gap-4">
              {ai && (ai.available || ai.summary || ai.negotiation) ? (
                <RfxAiSummary
                  canAsk={ai.available}
                  initial={{ BID_SUMMARY: ai.summary, NEGOTIATION_POINTS: ai.negotiation }}
                  summarize={summarizeRfxAction.bind(null, id)}
                  give={giveAiFeedbackAction}
                />
              ) : null}
              <ComparisonView
                lines={bids.comparison.lines}
                bids={bids.comparison.bids}
                details={bids.details}
                locale={locale}
                riskOn={d.modules.risk}
                actions={{ exportFile: exportComparisonAction.bind(null, id), openExport: downloadUrlAction, openBidFile: openBidFileAction.bind(null, id) }}
              />
              </div>
            )}
          </Panel>
        ),
      },
    )
    if (r.kind !== 'RFI' || d.scores) tabs.push({ value: 'scores', label: t('tabs.scores'), content: <ScoresTab d={d} locale={locale} /> })
    if (r.kind !== 'RFI') tabs.push({ value: 'awards', label: t('tabs.awards'), content: <AwardsTab d={d} locale={locale} /> })
  }

  return (
    <Page>
      <PageHeader title={t('title', { number: r.number ?? t('draftNumber'), title })} intro={t(`kindIntro.${r.kind === 'RFP' ? 'RFP' : r.kind === 'RFI' ? 'RFI' : 'RFQ'}`)} actions={<RfxStatusBadge status={r.status} />} />
      <PageBody>
        {d.reading === 'STATE' ? <Notice tone="info">{t('stateOnly')}</Notice> : null}
        <DocTabs tabs={tabs} initial={tabFrom(query.tab, tabs.map((tab) => tab.value))} label={t('tabs.label')} param="tab" />
      </PageBody>
    </Page>
  )
}
