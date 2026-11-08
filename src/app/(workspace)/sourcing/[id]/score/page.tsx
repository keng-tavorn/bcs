import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { scoreSheet } from '@/server/services/sourcing'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { StatusBadge } from '@/ui/document/badges'
import type { BadgeLook } from '@/ui/document/badge-looks'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/shadcn/table'
import { ScoreForm } from '@/ui/sourcing/score-form'
import { scoreText as formatScore } from '@/ui/sourcing/score-model'
import { getSession } from '../../../../_lib/session'
import { localeOf } from '../../../_tracking/present'
import { recuseAction, saveScoresAction, submitScoresAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('sourcing.score')
  return { title: t('title', { number: '' }).trim() }
}

// /sourcing/[id]/score (S10-08 · FR-SRC-203 AC1 AC2 AC3 · BR-RFX-09 10): an RFx's scorecard — its criteria and weights, its
// evaluators and where each stands; the evaluator's own sheet (the bids × the quality criteria, saved or sent, or stepping
// aside); once revealed, the totals and the ranking. Before the close nothing of the bids (sealed); before the reveal
// nobody's scores but the reader's own. sourcing.score for an evaluator of it, sourcing.view for the others.

const CARD = ['DRAFT', 'LOCKED', 'REVEALED'] as const
const CARD_LOOK: Record<(typeof CARD)[number], BadgeLook> = {
  DRAFT: { tone: 'neutral', icon: 'FilePen' },
  LOCKED: { tone: 'warn', icon: 'Hourglass' },
  REVEALED: { tone: 'ok', icon: 'CircleCheck' },
}
const EVALUATOR = ['ASSIGNED', 'SUBMITTED', 'RECUSED'] as const
const SCORING = new Set(['CLOSED', 'EVALUATING'])
const baht = (amount: string) => formatSatang(amountToSatang(amount))

export default async function ScorePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, tCommon, locale] = await Promise.all([getTranslations('sourcing.score'), getTranslations('adminSettings'), getLocale().then(localeOf)])
  const sheet = await scoreSheet(ctx, id)
  if (!sheet.ok) {
    if (sheet.error.code === 'NOT_FOUND') notFound()
    return <NoAccess title={t('title', { number: '' }).trim()} message={sheet.error.code === 'MODULE_DISABLED' ? t('errors.MODULE_DISABLED') : tCommon('forbidden')} homeLabel={tCommon('homeLink')} />
  }
  const s = sheet.data
  const en = locale === 'en'
  const cardStatus = (CARD as readonly string[]).includes(s.scorecard.status) ? (s.scorecard.status as (typeof CARD)[number]) : 'LOCKED'
  const name = (c: { nameTh: string; nameEn: string | null }) => (en && c.nameEn ? c.nameEn : c.nameTh)
  const quality = s.criteria.filter((c) => c.kind === 'QUALITY')
  const scoring = SCORING.has(s.rfx.status) && cardStatus === 'LOCKED'
  const supplierOf = new Map(s.bids.map((b) => [b.id, b]))

  return (
    <Page>
      <PageHeader title={t('title', { number: s.rfx.number ?? s.rfx.title })} intro={t('intro')} actions={<StatusBadge look={CARD_LOOK[cardStatus]} label={t(`status.${cardStatus}`)} />} />
      <PageBody>
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6">
          <div className="flex min-w-0 flex-col gap-4">
            {cardStatus === 'REVEALED' && s.ranking ? (
              <Panel title={t('ranking')} id="ranking">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">{t('rank')}</TableHead>
                        <TableHead scope="col">{t('supplier')}</TableHead>
                        <TableHead scope="col" className="text-right">
                          {t('net')}
                        </TableHead>
                        <TableHead scope="col" className="text-right">
                          {t('priceScore')}
                        </TableHead>
                        {quality.map((c) => (
                          <TableHead key={c.code} scope="col" className="text-right">
                            {name(c)}
                          </TableHead>
                        ))}
                        <TableHead scope="col" className="text-right">
                          {t('total')}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {s.ranking.map((r) => (
                        <TableRow key={r.bidId}>
                          <TableCell className="tabular">{r.rank}</TableCell>
                          <TableHead scope="row" className="font-normal">
                            {supplierOf.get(r.bidId)?.supplierName ?? '-'}
                          </TableHead>
                          <TableCell className="tabular text-right">{supplierOf.get(r.bidId) ? baht(supplierOf.get(r.bidId)!.net) : '-'}</TableCell>
                          <TableCell className="tabular text-right">{formatScore(r.priceBp)}</TableCell>
                          {quality.map((c) => (
                            <TableCell key={c.code} className="tabular text-right">
                              {r.criteria[c.code] !== undefined ? formatScore(r.criteria[c.code]!) : '-'}
                            </TableCell>
                          ))}
                          <TableCell className="tabular text-right font-semibold">{formatScore(r.totalBp)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </Panel>
            ) : null}
            {!SCORING.has(s.rfx.status) && s.rfx.status !== 'AWARDED' ? <Notice tone="info">{t('notClosed')}</Notice> : null}
            {s.me === null ? <Notice tone="info">{t('notEvaluator')}</Notice> : null}
            {s.me?.status === 'SUBMITTED' && cardStatus !== 'REVEALED' ? <Notice tone="success">{t('mineSent')}</Notice> : null}
            {s.me?.status === 'RECUSED' ? <Notice tone="info">{t('mineRecused')}</Notice> : null}
            {s.me?.status === 'ASSIGNED' && scoring && quality.length ? (
              <Panel title={t('mine')} id="sheet">
                <ScoreForm
                  bids={s.bids.map((b) => ({ id: b.id, supplierName: b.supplierName, net: baht(b.net), partial: b.isPartial }))}
                  criteria={quality.map((c) => ({ code: c.code, name: name(c) }))}
                  initial={s.me.entries}
                  actions={{
                    save: saveScoresAction.bind(null, s.rfx.id),
                    submit: submitScoresAction.bind(null, s.rfx.id, s.scorecard.id),
                    recuse: recuseAction.bind(null, s.rfx.id),
                  }}
                />
              </Panel>
            ) : null}
          </div>
          <div className="flex flex-col gap-4">
            <Panel title={t('criteria')} id="criteria">
              <ul className="flex flex-col gap-1">
                {s.criteria.map((c) => (
                  <li key={c.code} className="flex flex-col">
                    <span className="tabular">{t('weight', { name: name(c), percent: formatScore(c.weightBp) })}</span>
                    {c.kind === 'PRICE' ? <span className="text-sm text-ink-muted">{t('priceComputed')}</span> : null}
                  </li>
                ))}
              </ul>
            </Panel>
            <Panel title={t('evaluators')} id="evaluators">
              <ul className="flex flex-col gap-1">
                {s.evaluators.map((e) => (
                  <li key={e.memberId} className="flex justify-between gap-3">
                    <span>{e.name}</span>
                    <span className="text-ink-muted">{(EVALUATOR as readonly string[]).includes(e.status) ? t(`evaluatorStatus.${e.status as (typeof EVALUATOR)[number]}`) : e.status}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </div>
      </PageBody>
    </Page>
  )
}
