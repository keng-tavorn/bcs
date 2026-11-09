import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { awardWorkspace } from '@/server/services/sourcing'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { StatusBadge } from '@/ui/document/badges'
import { REQUEST_BADGES } from '@/ui/document/badge-looks'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { AwardFacts } from '@/ui/sourcing/award-facts'
import { AwardForm, type AwardFormLine } from '@/ui/sourcing/award-form'
import { AWARD_ERROR_KEYS, AWARD_STATUS_KEYS, keyOf } from '@/ui/sourcing/award-model'
import { getSession } from '../../../../_lib/session'
import { localeOf } from '../../../_tracking/present'
import { cancelAwardAction, saveAwardAction, submitAwardAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('sourcing.award')
  return { title: t('title', { number: '' }).trim() }
}

// /sourcing/[id]/award (S10-10 · FR-SRC-204 AC2 AC3 · BR-RFX-12): the award of an RFx — the winner of each line picked from
// the bids that offer it, the reason and a contract reference; the facts its approver will see (amounts, tags that call
// for a reason, winners with their flags, the comparison in short); the route it would take if sent now (previewRoute)
// and the send. Once sent or decided the page reads only. For a reader of the RFx's prices (rfxReading PRICES):
// procurement, finance, executives, auditors and its evaluators; the form for sourcing.award (procurement).

const OPEN = new Set(['DRAFT', 'RETURNED', 'PENDING_APPROVAL'])
const EDITABLE = new Set(['DRAFT', 'RETURNED'])
const AWARDABLE = new Set(['CLOSED', 'EVALUATING'])
const baht = (amount: string) => formatSatang(amountToSatang(amount))

export default async function AwardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, tCommon, locale] = await Promise.all([getTranslations('sourcing.award'), getTranslations('adminSettings'), getLocale().then(localeOf)])
  const read = await awardWorkspace(ctx, id)
  if (!read.ok) {
    if (read.error.code === 'NOT_FOUND') notFound()
    return <NoAccess title={t('title', { number: '' }).trim()} message={read.error.code === 'MODULE_DISABLED' ? t('errors.MODULE_DISABLED') : tCommon('forbidden')} homeLabel={tCommon('homeLink')} />
  }
  const w = read.data
  const status = keyOf(AWARD_STATUS_KEYS, w.award?.status ?? 'NONE', 'NONE')
  const ready = AWARDABLE.has(w.rfx.status) && !w.comparison.sealed && (!w.rfx.scored || w.rfx.revealed)
  const open = w.award !== null && OPEN.has(w.award.status)
  const editable = w.canAward && ready && (w.award === null || EDITABLE.has(w.award.status))
  const lines: AwardFormLine[] = w.comparison.lines.map((l) => ({
    id: l.id,
    lineNo: l.lineNo,
    description: l.description,
    quantity: l.quantity,
    uom: l.uom,
    options: w.comparison.bids.flatMap((b) => {
      const line = b.lines.find((x) => x.rfxLineId === l.id)
      return line?.offered && line.lineNet !== null ? [{ bidId: b.bidId, supplier: b.individual ? t('individual', { code: b.supplierCode }) : b.supplierName, net: baht(line.lineNet), lowest: line.lowest }] : []
    }),
  }))
  const formAward = w.award && open ? { awardDecisionId: w.award.id, version: w.award.version, choices: w.award.lines, reason: w.award.reason, contractRef: w.award.contractRef } : null
  const name = (n: { th: string; en: string | null }) => (locale === 'en' && n.en ? n.en : n.th)

  return (
    <Page>
      <PageHeader
        title={t('title', { number: w.facts?.number ?? w.rfx.number ?? w.rfx.title })}
        intro={t('intro')}
        actions={<StatusBadge look={REQUEST_BADGES[status] ?? { tone: 'neutral', icon: null }} label={t(`status.${status}`)} />}
      />
      <PageBody>
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6">
          <div className="flex min-w-0 flex-col gap-4">
            {w.rfx.kind === 'RFI' ? <Notice tone="info">{t('rfi')}</Notice> : !ready && !w.award ? <Notice tone="info">{t('notReady')}</Notice> : null}
            {w.rfx.kind !== 'RFI' && (w.award || ready) ? (
              <Panel title={t('linesTitle')} id="award-lines">
                {w.comparison.bids.length === 0 ? (
                  <p className="text-ink-muted">{t('noBids')}</p>
                ) : (
                  <AwardForm
                    lines={lines}
                    initial={w.canAward ? formAward : null}
                    editable={editable}
                    actions={{ save: saveAwardAction.bind(null, id), submit: submitAwardAction.bind(null, id), cancel: cancelAwardAction.bind(null, id) }}
                  />
                )}
                {w.award && !EDITABLE.has(w.award.status) ? <p className="text-base text-ink-muted md:text-sm">{t('readOnly', { status: t(`status.${keyOf(AWARD_STATUS_KEYS, w.award.status, 'NONE')}`) })}</p> : null}
              </Panel>
            ) : null}
            {w.facts ? (
              <Panel title={t('factsTitle')} id="award-facts">
                <AwardFacts award={w.facts} />
              </Panel>
            ) : null}
          </div>
          {w.route ? (
            <aside className="flex min-w-0 flex-col gap-4">
              <Panel title={t('routeTitle')} id="award-route">
                {w.route.kind === 'ROUTE' ? (
                  <dl className="flex flex-col gap-3">
                    <div className="flex flex-col">
                      <dt className="text-base text-ink-muted md:text-sm">{t('routeDoa')}</dt>
                      <dd className="text-ink">{t('routeRule', { code: w.route.doa.code, version: w.route.doa.versionNo, rule: w.route.ruleCode })}</dd>
                    </div>
                    {w.route.escalatedFromRuleCode ? <p className="text-base text-warn-ink md:text-sm">{t('routeEscalated', { rule: w.route.escalatedFromRuleCode })}</p> : null}
                    <div className="flex flex-col">
                      <dt className="text-base text-ink-muted md:text-sm">{t('routeApprover')}</dt>
                      <dd className="text-ink">{w.route.approvers.map((m) => name(m.name)).join(', ') || '-'}</dd>
                    </div>
                  </dl>
                ) : (
                  <Notice tone="warning">{t('routeBlocked', { reason: t(`errors.${keyOf(AWARD_ERROR_KEYS, w.route.code, 'OTHER')}`) })}</Notice>
                )}
              </Panel>
            </aside>
          ) : null}
        </div>
      </PageBody>
    </Page>
  )
}
