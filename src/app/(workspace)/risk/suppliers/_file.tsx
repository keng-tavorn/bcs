import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import type { SupplierRiskFile } from '@/server/services/risk'
import { StatusBadge } from '@/ui/document/badges'
import type { BadgeLook } from '@/ui/document/badge-looks'
import { ListEmpty, Panel } from '@/ui/page/page'
import { Facts, type Fact } from '@/ui/request-view/facts'
import { OpenFileButton } from '@/ui/risk-assessment/actions'
import { OpenAssessmentButton, type OpenAssessmentAction } from '@/ui/risk-file/open-assessment'
import { isSupplierRiskStatus, SUPPLIER_RISK_BADGES } from '@/ui/risk-file/model'
import { OVERRIDE_BADGES, type OverrideStatus } from '@/ui/risk-override/model'
import { TierBadge } from '@/ui/risk-review/badges'
import type { RiskAdminOutcome } from '@/ui/risk-admin/model'
import { day, when, type Locale } from '../../_tracking/present'

// The supplier's risk file (S11-10 · FR-RSK-204 AC1 AC3 · BR-RSK-14): drawn by /risk/suppliers/[id] and by the tab
// "ความเสี่ยง" of /suppliers/[id] from supplierRiskFile — the status, every assessment with its answers and their source
// and its reviewers' slots, the evidence as metadata (files open from the assessment's page, for risk.evidence.view), the
// overrides with the POs that used them, the reassessments and the timeline. "ส่งออก Excel" is a POST (a server action)
// that records the download; "เปิดแบบประเมิน" shows for PROCUREMENT only. Lists, not wide tables: a phone reads the same.

const ASSESSMENT_LOOK: Record<string, BadgeLook> = {
  DRAFT: { tone: 'neutral', icon: 'FilePen' },
  IN_REVIEW: { tone: 'warn', icon: 'Hourglass' },
  RETURNED: { tone: 'warn', icon: 'Undo2' },
  COMPLETED: { tone: 'ok', icon: 'CircleCheck' },
  SUPERSEDED: { tone: 'neutral', icon: 'Ban' },
  CANCELLED: { tone: 'neutral', icon: 'CircleX' },
}
const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline lg:min-h-0'

export interface RiskFileActions {
  readonly exportFile: (key: string) => Promise<RiskAdminOutcome>
  readonly open: OpenAssessmentAction
}

export async function RiskFileView({ file, locale, actions }: { file: SupplierRiskFile; locale: Locale; actions: RiskFileActions }) {
  const [t, tAdmin, tOverride, tRisk, tEvents] = await Promise.all([getTranslations('risk.file'), getTranslations('risk.admin'), getTranslations('risk.override'), getTranslations('risk'), getTranslations('audit.events')])
  const tierLabel = (tier: 'LOW' | 'MEDIUM' | 'HIGH') => tAdmin(`tierName.${tier}`)
  const s = file.supplier
  const st = file.status
  const statusLook = isSupplierRiskStatus(st.status) ? SUPPLIER_RISK_BADGES[st.status] : undefined
  const current = file.assessments.find((a) => a.id === st.currentAssessmentId)

  const facts: Fact[] = [
    { label: t('tier'), value: st.tier ? <TierBadge tier={st.tier} label={tierLabel(st.tier)} /> : t('notAssessed') },
    { label: t('status'), value: <StatusBadge look={statusLook} label={tRisk(`supplierStatus.${st.status}`)} /> },
  ]
  if (st.validUntil) facts.push({ label: t('validUntil'), value: day(locale, st.validUntil) })
  if (current) facts.push({ label: t('currentAssessment', { number: current.number ?? t('draftNumber') }), value: <Link href={`/risk/assessments/${current.id}`} className={linkClass}>{t('openAssessment')}</Link> })
  if (s.taxId)
    facts.push({
      label: t('taxId'),
      value: (
        <span className="flex flex-col">
          <span className="tabular">{s.taxId}</span>
          {s.taxIdMasked ? <span className="text-base text-ink-muted md:text-sm">{t('taxIdMasked')}</span> : null}
        </span>
      ),
    })
  facts.push({ label: t('registryFlag'), value: t(`registry.${s.registryFlag}` as 'registry.NONE') })
  if (st.openOverrideId) facts.push({ label: t('openOverride'), value: <Link href={`/risk/overrides/${st.openOverrideId}`} className={linkClass}>{tOverride('toList')}</Link> })

  return (
    <div className="flex flex-col gap-4 lg:gap-6">
      <Panel id="risk-summary" title={t('summary')}>
        <Facts items={facts} />
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-6">
          <OpenFileButton label={t('export')} open={actions.exportFile} />
          {file.canManage ? <OpenAssessmentButton open={actions.open} /> : null}
        </div>
        <p className="text-base text-ink-muted md:text-sm">{t('exportNote')}</p>
      </Panel>

      <Panel id="risk-assessments" title={t('assessments')}>
        {file.assessments.length === 0 ? (
          <ListEmpty title={t('noAssessments')} />
        ) : (
          <ul aria-label={t('assessments')} className="flex flex-col divide-y divide-line">
            {file.assessments.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <Link href={`/risk/assessments/${a.id}`} className="font-semibold break-words text-primary underline underline-offset-4 hover:no-underline">
                    {a.number ?? t('draftNumber')}
                  </Link>
                  <StatusBadge look={ASSESSMENT_LOOK[a.status]} label={tRisk(`assessment.status.${a.status}` as 'assessment.status.DRAFT')} />
                  {a.tier ? <TierBadge tier={a.tier} label={tierLabel(a.tier)} /> : null}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-ink-muted">
                  <span>{t('inherent', { tier: tierLabel(a.inherentTier) })}</span>
                  {a.pointsTotal !== null && a.tier ? <span className="tabular">{t('points', { points: a.pointsTotal, tier: tierLabel(a.tier) })}</span> : null}
                  <span>{t('opened', { date: day(locale, a.openedAt) })}</span>
                  {a.completedOn && a.validUntil ? <span>{t('completed', { date: day(locale, a.completedOn), until: day(locale, a.validUntil) })}</span> : null}
                </div>
                {a.answers.length ? (
                  <details className="flex flex-col gap-1">
                    <summary className="min-h-11 cursor-pointer content-center font-medium lg:min-h-0">{t('answers', { count: a.answers.length })}</summary>
                    <ul className="flex flex-col gap-1 pt-1">
                      {a.answers.map((x) => (
                        <li key={x.questionCode} className="flex flex-wrap gap-x-3">
                          <span className="tabular">{t('answerLine', { code: x.questionCode, option: x.optionCode })}</span>
                          <span className="text-ink-muted">{t(`source.${x.source}`)}</span>
                          {x.aiConfirmed ? <span className="text-info">{t('aiConfirmed')}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {a.reviews.length ? (
                  <div className="flex flex-col gap-1">
                    <span className="font-medium">{t('slots')}</span>
                    <ul className="flex flex-col gap-1">
                      {a.reviews.map((r) => (
                        <li key={`${r.reviewRound}-${r.slotNo}`} className="flex flex-col">
                          <span>
                            {t('slot', { round: r.reviewRound, slot: r.slotNo, domains: r.riskDomains.map((d) => tAdmin(`domain.${d}`)).join(', '), name: r.reviewerName })} · {t(`slotStatus.${r.status}`)}
                            {r.decidedAt ? ` · ${when(locale, r.decidedAt)}` : ''}
                          </span>
                          {r.reason ? <span className="text-ink-muted">{t('reason', { reason: r.reason })}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel id="risk-evidence" title={t('evidence')}>
        {file.documents.length === 0 && file.files.length === 0 ? (
          <ListEmpty title={t('noEvidence')} />
        ) : (
          <ul aria-label={t('evidence')} className="flex flex-col divide-y divide-line">
            {file.documents.map((d) => (
              <li key={d.id} className="flex flex-col gap-1 py-3">
                <span className="font-medium">{t('documentRow', { type: d.documentTypeCode, scope: d.scope ?? t('noScope'), date: day(locale, d.expiresOn) })}</span>
                <span className="text-ink-muted">{t('usedFor', { list: d.usedBy.map((u) => `${u.assessmentNumber ?? t('draftNumber')} ${u.questionCode}`).join(', ') })}</span>
              </li>
            ))}
            {file.files.map((f) => (
              <li key={f.fileId} className="flex flex-col gap-1 py-3">
                <span className="font-medium break-words">{t('fileRow', { name: f.fileName, number: f.assessmentNumber ?? t('draftNumber'), code: f.questionCode })}</span>
                <span className="text-ink-muted">{t(`scan.${f.scanStatus}` as 'scan.CLEAN')}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-base text-ink-muted md:text-sm">{t('evidenceNote')}</p>
      </Panel>

      <Panel id="risk-overrides" title={t('overrides')}>
        {file.overrides.length === 0 ? (
          <ListEmpty title={t('noOverrides')} />
        ) : (
          <ul aria-label={t('overrides')} className="flex flex-col divide-y divide-line">
            {file.overrides.map((o) => (
              <li key={o.id} className="flex flex-col gap-1.5 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <Link href={`/risk/overrides/${o.id}`} className="font-semibold text-primary underline underline-offset-4 hover:no-underline">
                    {o.number ?? t('draftNumber')}
                  </Link>
                  <StatusBadge look={OVERRIDE_BADGES[o.status as OverrideStatus]} label={tOverride(`status.${o.status as OverrideStatus}`)} />
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-ink-muted">
                  <span>{o.forPo ? t('overrideFor', { number: o.forPo.number ?? t('draftNumber') }) : t('overrideAny')}</span>
                  <span className="money">{t('cap', { cap: formatSatang(o.capGrossSatang), used: formatSatang(o.usedGrossSatang) })}</span>
                  <span>{t('until', { date: day(locale, o.expiresOn) })}</span>
                </div>
                <span>{o.usedBy.length ? t('usedBy', { list: o.usedBy.map((p) => p.number ?? t('draftNumber')).join(', ') }) : t('notUsed')}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel id="risk-reviews" title={t('reviews')}>
        {file.reviews.length === 0 ? (
          <ListEmpty title={t('noReviews')} />
        ) : (
          <ul aria-label={t('reviews')} className="flex flex-col divide-y divide-line">
            {file.reviews.map((r) => (
              <li key={r.id} className="flex flex-col gap-1 py-3">
                <span className="font-medium">
                  {t('reviewRow', { reason: t(`reviewReason.${r.reason}` as 'reviewReason.SCHEDULED'), date: day(locale, r.dueAt) })} · {t(`reviewStatus.${r.status}` as 'reviewStatus.OPEN')}
                </span>
                {r.completedAt ? <span className="text-ink-muted">{t('reviewDone', { date: day(locale, r.completedAt) })}</span> : null}
                {r.registryFlag ? <span className="text-ink-muted">{t(`registry.${r.registryFlag}` as 'registry.NONE')}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel id="risk-timeline" title={t('timeline')}>
        {file.timeline.length === 0 ? (
          <ListEmpty title={t('noTimeline')} />
        ) : (
          <ol aria-label={t('timeline')} className="flex flex-col divide-y divide-line">
            {file.timeline.map((e) => (
              <li key={e.id} className="flex flex-col gap-0.5 py-2 md:flex-row md:gap-4">
                <span className="tabular text-ink-muted md:w-44 md:flex-none">{when(locale, e.occurredAt)}</span>
                <span className="font-medium">{tEvents.has(e.type as never) ? tEvents(e.type as never) : e.type}</span>
                <span className="text-ink-muted">{t(`actor.${e.actorKind}`, { name: e.actorName ?? '' })}</span>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  )
}
