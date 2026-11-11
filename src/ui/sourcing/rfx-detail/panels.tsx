import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import { StatusBadge } from '../../document/badges'
import { FALLBACK_BADGE, PO_BADGES, REQUEST_BADGES, type BadgeLook } from '../../document/badge-looks'
import { Notice } from '../../form/notice'
import { Panel } from '../../page/page'
import { Badge } from '../../shadcn/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../shadcn/table'
import { Timeline, type TimelineItem } from '../../timeline/timeline'
import { AnswerForm, type AnswerInput } from './answer-form'
import { bahtText, dayText, percentText, whenText } from './format'
import {
  AWARD_STATUS_KEYS,
  eventKey,
  EVALUATOR_STATUS_KEYS,
  INVITE_STATUS_KEYS,
  INVITE_STATUS_LOOK,
  keyIn,
  nameIn,
  QUESTION_STATUS_KEYS,
  QUESTION_STATUS_LOOK,
  REF_SOURCE_KEYS,
  RFX_STATUS_KEYS,
  RFX_STATUS_LOOK,
  SCORECARD_STATUS_KEYS,
  SCORECARD_STATUS_LOOK,
  type Locale,
  type RfxActionOutcome,
  type RfxDetailView,
} from './model'
import { AmendForm, ExtendForm, type AmendInput } from './revision-forms'

// The tabs of /sourcing/[id] (S10-12) drawn on the server: what the page reads, in words and icons (never colour alone),
// money right-aligned, wide tables in their own scrolling frame on a computer and lists on a phone. The forms inside are
// the client parts of this folder; the page hands them their bound server actions.

const link = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline lg:min-h-0'
const muted = 'text-base text-ink-muted md:text-sm'

export function RfxStatusBadge({ status }: { readonly status: string }) {
  const t = useTranslations('sourcing.detail')
  const key = keyIn(RFX_STATUS_KEYS, status, 'DRAFT')
  return <StatusBadge look={RFX_STATUS_LOOK[key]} label={t(`status.${key}`)} />
}

function Facts({ rows }: { readonly rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-ink-muted">{label}</dt>
          <dd className="break-words">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

// ---------- ภาพรวม ----------

export function OverviewTab({ d, locale, commands }: { readonly d: RfxDetailView; readonly locale: Locale; readonly commands: ReactNode }) {
  const t = useTranslations('sourcing.detail.overview')
  const tl = useTranslations('sourcing.detail.timeline')
  const tt = useTranslations('timeline')
  const r = d.rfx
  const dash = '-'
  const at = (v: string | null) => (v ? whenText(locale, v) : dash)
  const items: TimelineItem[] = d.timeline.map((e) => ({
    id: e.id,
    title: tl(`event.${eventKey(e.type)}`),
    actor: e.actor.kind === 'MEMBER' ? nameIn(locale, e.actor.name) : e.actor.kind === 'SUPPLIER' ? tl('supplier') : tt('system'),
    when: whenText(locale, e.occurredAt),
    state: 'done',
    outcome: e.type === 'rfx.cancelled' ? 'cancelled' : 'neutral',
    statusLabel: tt('status.done'),
  }))
  return (
    <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6">
      <div className="flex min-w-0 flex-col gap-4">
        {r.status === 'CANCELLED' ? <Notice tone="info">{r.cancelReason ? t('cancelledWith', { reason: r.cancelReason }) : t('cancelled')}</Notice> : null}
        {r.status === 'CONCLUDED' && r.conclusionNote ? <Notice tone="success">{t('concluded', { note: r.conclusionNote })}</Notice> : null}
        {commands ? (
          <Panel title={t('commandsTitle')} id="rfx-commands">
            {commands}
          </Panel>
        ) : null}
        <Panel title={t('aboutTitle')} id="rfx-about">
          <div className="flex flex-col gap-4">
            <p className="break-words whitespace-pre-line">{locale === 'en' && r.descriptionEn ? r.descriptionEn : r.description}</p>
            <Facts
              rows={[
                [t('kind'), t(`kindValue.${keyIn(['RFQ', 'RFP', 'RFI'] as const, r.kind, 'RFQ')}`)],
                [t('category'), r.categoryCode],
                [t('department'), nameIn(locale, r.requestingDepartment) || dash],
                [t('createdBy'), nameIn(locale, r.createdBy) || dash],
                [t('source'), t(`sourceValue.${keyIn(['POOL', 'NEED'] as const, r.sourceKind, 'NEED')}`)],
                [t('revision'), t('revisionValue', { no: r.revisionNo })],
                [t('envelope'), r.sealed ? t('sealed') : t('unsealed')],
                [t('terms'), [r.allowPartialBids ? t('partialAllowed') : t('partialNotAllowed'), r.allowVatInclusiveBids ? t('vatInclusiveAllowed') : t('vatExclusiveOnly'), t('validity', { days: r.bidValidityDays })].join(' · ')],
                [t('minInvites'), String(r.minInvites)],
              ]}
            />
          </div>
        </Panel>
        <Panel title={tl('title')} id="rfx-timeline">
          {items.length ? <Timeline items={items} label={tl('title')} /> : <p className="text-ink-muted">{tl('empty')}</p>}
        </Panel>
      </div>
      <aside className="flex min-w-0 flex-col gap-4">
        <Panel title={t('deadlinesTitle')} id="rfx-deadlines">
          <Facts
            rows={[
              [t('createdAt'), at(r.createdAt)],
              [t('openedAt'), at(r.openedAt)],
              [t('questionCutoffAt'), at(r.questionCutoffAt)],
              [t('closesAt'), at(r.closesAt)],
              [t('closedAt'), at(r.closedAt)],
              ...(r.cancelledAt ? [[t('cancelledAt'), at(r.cancelledAt)] as const] : []),
            ]}
          />
        </Panel>
      </aside>
    </div>
  )
}

// ---------- รายการ ----------

export function LinesTab({ d, locale }: { readonly d: RfxDetailView; readonly locale: Locale }) {
  const t = useTranslations('sourcing.detail.lines')
  const prices = d.reading === 'PRICES'
  const dash = '-'
  const en = locale === 'en'
  const ref = (l: RfxDetailView['lines'][number]) => (l.reference ? t('referenceValue', { price: bahtText(l.reference.unitPrice), source: t(`source.${keyIn(REF_SOURCE_KEYS, l.reference.source ?? 'NONE', 'NONE')}`) }) : dash)
  const desc = (l: RfxDetailView['lines'][number]) => (en && l.descriptionEn ? l.descriptionEn : l.description)
  const other = (l: RfxDetailView['lines'][number]) => (en ? (l.descriptionEn ? l.description : null) : l.descriptionEn)
  const uom = (l: RfxDetailView['lines'][number]) => (en && l.uomEn ? l.uomEn : l.uom)
  if (!d.lines.length) return <p className="text-ink-muted">{t('empty')}</p>
  return (
    <Panel title={t('title')} id="rfx-lines">
      <div className="hidden overflow-x-auto md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t('no')}</TableHead>
              <TableHead scope="col">{t('description')}</TableHead>
              <TableHead scope="col" className="text-right">
                {t('quantity')}
              </TableHead>
              <TableHead scope="col">{t('site')}</TableHead>
              <TableHead scope="col">{t('requiredOn')}</TableHead>
              {prices ? (
                <TableHead scope="col" className="text-right">
                  {t('reference')}
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.lines.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="tabular align-top">{l.lineNo}</TableCell>
                <TableHead scope="row" className="min-w-56 align-top font-normal whitespace-normal">
                  <span className="flex flex-col gap-1">
                    <span>{desc(l)}</span>
                    {other(l) ? <span className={muted}>{other(l)}</span> : null}
                    {l.note ? <span className={muted}>{l.note}</span> : null}
                    {l.sourceCount ? <span className={muted}>{t('sources', { count: l.sourceCount })}</span> : null}
                  </span>
                </TableHead>
                <TableCell className="tabular text-right align-top">{t('quantityValue', { quantity: l.quantity, uom: uom(l) })}</TableCell>
                <TableCell className="align-top whitespace-normal">{l.deliverySite ? `${l.deliverySite.code} ${l.deliverySite.name}` : dash}</TableCell>
                <TableCell className="align-top">{l.requiredDeliveryOn ? dayText(locale, l.requiredDeliveryOn) : dash}</TableCell>
                {prices ? <TableCell className="tabular text-right align-top whitespace-normal">{ref(l)}</TableCell> : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="flex flex-col gap-3 md:hidden">
        {d.lines.map((l) => (
          <li key={l.id} className="flex flex-col gap-1 border-b border-line pb-3 last:border-b-0">
            <span className="font-medium break-words">{t('lineOf', { no: l.lineNo, description: desc(l) })}</span>
            {other(l) ? <span className={muted}>{other(l)}</span> : null}
            <span className="tabular">{t('quantityValue', { quantity: l.quantity, uom: uom(l) })}</span>
            <span>{t('siteValue', { site: l.deliverySite ? `${l.deliverySite.code} ${l.deliverySite.name}` : dash })}</span>
            <span>{t('requiredOnValue', { date: l.requiredDeliveryOn ? dayText(locale, l.requiredDeliveryOn) : dash })}</span>
            {prices ? <span className="tabular">{t('referenceLine', { value: ref(l) })}</span> : null}
            {l.note ? <span className={muted}>{l.note}</span> : null}
          </li>
        ))}
      </ul>
    </Panel>
  )
}

// ---------- ผู้ขาย ----------

const RISK_LOOK: Readonly<Record<'OK' | 'BLOCKED', BadgeLook>> = { OK: { tone: 'neutral', icon: 'Gauge' }, BLOCKED: { tone: 'danger', icon: 'Ban' } }
const WARN_LOOK: BadgeLook = { tone: 'warn', icon: 'Clock' }

export function SuppliersTab({ d, locale }: { readonly d: RfxDetailView; readonly locale: Locale }) {
  const t = useTranslations('sourcing.detail.suppliers')
  const active = d.invites.filter((i) => i.status !== 'REMOVED').length
  return (
    <Panel
      title={t('title')}
      id="rfx-suppliers"
      actions={
        d.can.invite ? (
          <Link href={`/sourcing/${d.rfx.id}/edit?step=suppliers`} className={link}>
            {t('manage')}
          </Link>
        ) : null
      }
    >
      <div className="flex flex-col gap-3">
        <p className={muted}>{t('count', { active, min: d.rfx.minInvites })}</p>
        {d.invites.length === 0 ? (
          <p className="text-ink-muted">{t('empty')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {d.invites.map((i) => {
              const status = keyIn(INVITE_STATUS_KEYS, i.status, 'INVITED')
              const s = i.snapshot
              return (
                <li key={i.id} className="flex flex-col gap-2 border-b border-line pb-3 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium break-words">{i.supplierCode ? t('nameWithCode', { name: i.name, code: i.supplierCode }) : i.name}</span>
                    <StatusBadge look={INVITE_STATUS_LOOK[status]} label={t(`status.${status}`)} />
                    {i.needsReconfirm ? <StatusBadge look={WARN_LOOK} label={t('needsReconfirm')} /> : null}
                  </div>
                  <span className="flex flex-wrap gap-1">
                    {i.application ? <Badge variant="outline">{t('application')}</Badge> : null}
                    {s.isForeign ? <Badge variant="outline">{t('foreign')}</Badge> : null}
                    {s.isVatRegistered === false ? <Badge variant="outline">{t('notVatRegistered')}</Badge> : null}
                    {s.registryFlag && s.registryFlag !== 'NONE' ? <Badge variant="outline">{t(`registry.${keyIn(['CEASED', 'VAT_CANCELLED', 'NOT_FOUND', 'OTHER'] as const, s.registryFlag, 'OTHER')}`)}</Badge> : null}
                    {s.requiredDocumentsOk === true ? <Badge variant="outline">{t('docsOk')}</Badge> : s.requiredDocumentsOk === false ? <Badge variant="outline">{t('docsMissing')}</Badge> : null}
                    {d.modules.risk && i.risk ? (
                      <StatusBadge
                        look={i.risk.blocked ? RISK_LOOK.BLOCKED : RISK_LOOK.OK}
                        label={t(i.risk.blocked ? 'riskBlocked' : 'risk', { tier: i.risk.tier ?? t('riskNone'), status: i.risk.status ?? t('riskNone') })}
                      />
                    ) : null}
                  </span>
                  <span className={muted}>
                    {t('invitedAt', { at: whenText(locale, i.invitedAt) })}
                    {i.viewedAt ? ` · ${t('viewedAt', { at: whenText(locale, i.viewedAt) })}` : ''}
                  </span>
                  {i.declinedAt ? <span className={muted}>{t('declined', { at: whenText(locale, i.declinedAt), reason: i.declineReason ?? '-' })}</span> : null}
                  {i.removedAt ? <span className={muted}>{t('removed', { at: whenText(locale, i.removedAt), reason: i.removeReason ?? '-' })}</span> : null}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Panel>
  )
}

// ---------- คำถาม ----------

export function QuestionsTab({ d, locale, answer }: { readonly d: RfxDetailView; readonly locale: Locale; readonly answer: (input: AnswerInput, key: string) => Promise<RfxActionOutcome> }) {
  const t = useTranslations('sourcing.detail.questions')
  return (
    <Panel title={t('title')} id="rfx-questions">
      <div className="flex flex-col gap-3">
        <p className={muted}>{t('intro')}</p>
        {d.questions.length === 0 ? (
          <p className="text-ink-muted">{t('empty')}</p>
        ) : (
          <ol className="flex flex-col gap-4">
            {d.questions.map((q) => {
              const status = keyIn(QUESTION_STATUS_KEYS, q.status, 'OPEN')
              return (
                <li key={q.id} className="flex flex-col gap-2 border-b border-line pb-4 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge look={QUESTION_STATUS_LOOK[status]} label={t(`status.${status}`)} />
                    {q.status === 'ANSWERED' ? <Badge variant="outline">{t(q.visibility === 'ASKER' ? 'toAsker' : 'toAll')}</Badge> : null}
                  </div>
                  <p className={muted}>{t('askedBy', { name: q.askerName || '-', at: whenText(locale, q.askedAt) })}</p>
                  <p className="break-words whitespace-pre-line">{q.question}</p>
                  {q.answer ? (
                    <div className="flex flex-col gap-1 border-l-2 border-line pl-3">
                      <p className={muted}>{t('answeredBy', { name: nameIn(locale, q.answeredBy) || '-', at: q.answeredAt ? whenText(locale, q.answeredAt) : '-' })}</p>
                      <p className="break-words whitespace-pre-line">{q.answer}</p>
                    </div>
                  ) : null}
                  {d.can.answer && q.status === 'OPEN' ? <AnswerForm questionId={q.id} question={q.question} answer={answer} /> : null}
                </li>
              )
            })}
          </ol>
        )}
        {!d.can.answer && d.questions.some((q) => q.status === 'OPEN') && d.can.manage ? <Notice tone="info">{t('closedForAnswers')}</Notice> : null}
      </div>
    </Panel>
  )
}

// ---------- การแก้ไข ----------

export function RevisionsTab({
  d,
  locale,
  amend,
  extend,
}: {
  readonly d: RfxDetailView
  readonly locale: Locale
  readonly amend: (input: AmendInput, key: string) => Promise<RfxActionOutcome>
  readonly extend: (version: number, closesAt: string, key: string) => Promise<RfxActionOutcome>
}) {
  const t = useTranslations('sourcing.detail.revisions')
  const r = d.rfx
  const current = { version: r.version, title: r.title, titleEn: r.titleEn, description: r.description, descriptionEn: r.descriptionEn, closesAt: r.closesAt }
  return (
    <div className="flex flex-col gap-4">
      <Panel title={t('title')} id="rfx-revisions">
        <div className="flex flex-col gap-3">
          <p className={muted}>{t('current', { no: r.revisionNo })}</p>
          {d.amendments.length === 0 ? (
            <p className="text-ink-muted">{t('empty')}</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {d.amendments.map((a) => (
                <li key={a.revisionNo} className="flex flex-col gap-1 border-b border-line pb-3 last:border-b-0">
                  <span className="font-medium">{t('revisionOf', { no: a.revisionNo, at: whenText(locale, a.createdAt), name: nameIn(locale, a.createdBy) || '-' })}</span>
                  <p className="break-words whitespace-pre-line">{locale === 'en' && a.summaryEn ? a.summaryEn : a.summary}</p>
                  {a.changedFields.length ? <p className={muted}>{t('changed', { fields: a.changedFields.map((f) => t(`field.${keyIn(['title', 'titleEn', 'description', 'descriptionEn', 'closesAt', 'other'] as const, f, 'other')}`)).join(', ') })}</p> : null}
                  {a.newClosesAt ? <p className={muted}>{t('moved', { from: a.previousClosesAt ? whenText(locale, a.previousClosesAt) : '-', to: whenText(locale, a.newClosesAt) })}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      </Panel>
      {d.can.extend ? (
        <Panel title={t('extend.heading')} id="rfx-extend">
          <ExtendForm version={r.version} closesAt={r.closesAt} extend={extend} />
        </Panel>
      ) : null}
      {d.can.amend ? (
        <Panel title={t('amend.heading')} id="rfx-amend">
          <AmendForm current={current} amend={amend} />
        </Panel>
      ) : null}
    </div>
  )
}

// ---------- ข้อเสนอ (ก่อนเปิดซอง) ----------

export function SealedBids({ submitters, closesAt, locale }: { readonly submitters: ReadonlyArray<{ readonly name: string; readonly needsReconfirm: boolean }>; readonly closesAt: string | null; readonly locale: Locale }) {
  const t = useTranslations('sourcing.detail.bids')
  return (
    <div className="flex flex-col gap-3">
      <Notice tone="info">{closesAt ? t('sealedUntil', { at: whenText(locale, closesAt) }) : t('sealed')}</Notice>
      <p>{t('submittedCount', { count: submitters.length })}</p>
      {submitters.length ? (
        <ul className="flex flex-col gap-1">
          {submitters.map((s, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <span>{s.name}</span>
              {s.needsReconfirm ? <StatusBadge look={WARN_LOOK} label={t('needsReconfirm')} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

// ---------- คะแนน ----------

export function ScoresTab({ d, locale }: { readonly d: RfxDetailView; readonly locale: Locale }) {
  const t = useTranslations('sourcing.detail.scores')
  const s = d.scores
  const scoreLink = d.can.score ? (
    <Link href={`/sourcing/${d.rfx.id}/score`} className={link}>
      {t('open')}
    </Link>
  ) : null
  if (!s) return <p className="text-ink-muted">{t('none')}</p>
  const status = keyIn(SCORECARD_STATUS_KEYS, s.status, 'DRAFT')
  const quality = s.criteria.filter((c) => c.kind === 'QUALITY')
  return (
    <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6">
      <div className="flex min-w-0 flex-col gap-4">
        <Panel title={t('title')} id="rfx-scores" actions={scoreLink}>
          <div className="flex flex-col gap-3">
            <StatusBadge look={SCORECARD_STATUS_LOOK[status]} label={t(`status.${status}`)} />
            {s.ranking ? (
              s.ranking.length ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">{t('rank')}</TableHead>
                        <TableHead scope="col">{t('supplier')}</TableHead>
                        <TableHead scope="col" className="text-right">
                          {t('priceScore')}
                        </TableHead>
                        {quality.map((c) => (
                          <TableHead key={c.code} scope="col" className="text-right">
                            {nameIn(locale, c.name)}
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
                          <TableHead scope="row" className="font-normal whitespace-normal">
                            {r.supplierName || '-'}
                          </TableHead>
                          <TableCell className="tabular text-right">{percentText(r.priceBp)}</TableCell>
                          {quality.map((c) => (
                            <TableCell key={c.code} className="tabular text-right">
                              {r.criteria[c.code] !== undefined ? percentText(r.criteria[c.code]!) : '-'}
                            </TableCell>
                          ))}
                          <TableCell className="tabular text-right font-semibold">{percentText(r.totalBp)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="text-ink-muted">{t('noRanking')}</p>
              )
            ) : (
              <p className="text-ink-muted">{t('notRevealed')}</p>
            )}
          </div>
        </Panel>
      </div>
      <aside className="flex min-w-0 flex-col gap-4">
        <Panel title={t('evaluators')} id="rfx-evaluators">
          <div className="flex flex-col gap-2">
            <p className={muted}>{t('minEvaluators', { count: s.minEvaluators })}</p>
            {s.evaluators.length ? (
              <ul className="flex flex-col gap-1">
                {s.evaluators.map((e) => (
                  <li key={e.memberId} className="flex flex-wrap justify-between gap-2">
                    <span>{nameIn(locale, e.name)}</span>
                    <span className="text-ink-muted">{t(`evaluatorStatus.${keyIn(EVALUATOR_STATUS_KEYS, e.status, 'ASSIGNED')}`)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-muted">{t('noEvaluators')}</p>
            )}
          </div>
        </Panel>
        <Panel title={t('criteria')} id="rfx-criteria">
          <ul className="flex flex-col gap-1">
            {s.criteria.map((c) => (
              <li key={c.code} className="flex flex-col">
                <span className="tabular">{t('weight', { name: nameIn(locale, c.name), percent: percentText(c.weightBp) })}</span>
                {c.kind === 'PRICE' ? <span className={muted}>{t('priceComputed')}</span> : null}
              </li>
            ))}
          </ul>
        </Panel>
      </aside>
    </div>
  )
}

// ---------- ผล ----------

export function AwardsTab({ d, locale }: { readonly d: RfxDetailView; readonly locale: Locale }) {
  const t = useTranslations('sourcing.detail.awards')
  const awardable = d.rfx.kind !== 'RFI' && (d.awards.length > 0 || d.rfx.status === 'CLOSED' || d.rfx.status === 'EVALUATING' || d.rfx.status === 'AWARDED')
  const pageLink =
    awardable && (d.can.award || d.awards.length > 0) ? (
      <Link href={`/sourcing/${d.rfx.id}/award`} className={link}>
        {d.can.award ? t('openManage') : t('open')}
      </Link>
    ) : null
  return (
    <Panel title={t('title')} id="rfx-awards" actions={pageLink}>
      {d.rfx.kind === 'RFI' ? (
        <p className="text-ink-muted">{t('rfi')}</p>
      ) : d.awards.length === 0 ? (
        <p className="text-ink-muted">{t('empty')}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {d.awards.map((a) => {
            const status = keyIn(AWARD_STATUS_KEYS, a.status, 'DRAFT')
            return (
              <li key={a.id} className="flex flex-col gap-2 border-b border-line pb-4 last:border-b-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{a.number ?? t('draftNumber')}</span>
                  <StatusBadge look={REQUEST_BADGES[status] ?? FALLBACK_BADGE} label={t(`status.${status}`)} />
                  {a.isSplit ? <Badge variant="outline">{t('split')}</Badge> : null}
                </div>
                <dl className="grid max-w-md grid-cols-[1fr_auto] gap-x-4 gap-y-1">
                  {(['net', 'vat', 'gross'] as const).map((k) => (
                    <div key={k} className="contents">
                      <dt className="text-ink-muted">{t(k)}</dt>
                      <dd className={k === 'gross' ? 'tabular text-right font-semibold' : 'tabular text-right'}>{bahtText(a[k])}</dd>
                    </div>
                  ))}
                </dl>
                {a.submittedAt ? <span className={muted}>{t('submittedAt', { at: whenText(locale, a.submittedAt) })}</span> : null}
                {a.decidedAt ? <span className={muted}>{t('decidedAt', { at: whenText(locale, a.decidedAt) })}</span> : null}
                {a.cancelReason ? <span className={muted}>{t('cancelReason', { reason: a.cancelReason })}</span> : null}
                {a.status === 'APPROVED' ? (
                  a.poStatus === 'PENDING_PRICE' ? (
                    <Notice tone="info">{t('pendingPrice')}</Notice>
                  ) : a.purchaseOrders.length ? (
                    <div className="flex flex-col gap-1">
                      <span className="font-medium">{t('pos')}</span>
                      <ul className="flex flex-col gap-1">
                        {a.purchaseOrders.map((po) => (
                          <li key={po.id} className="flex flex-wrap items-center gap-2">
                            <Link href={`/procurement/pos/${po.id}`} className={link}>
                              {t('poRow', { number: po.number ?? t('draftNumber'), supplier: po.supplierName, amount: bahtText(po.gross) })}
                            </Link>
                            <StatusBadge look={PO_BADGES[po.status] ?? FALLBACK_BADGE} label={t(`poStatus.${keyIn(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'REJECTED', 'CANCELLED', 'OTHER'] as const, po.status, 'OTHER')}`)} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="text-ink-muted">{a.priceAgreements ? t('agreements', { count: a.priceAgreements }) : t('nothingMade')}</p>
                  )
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
