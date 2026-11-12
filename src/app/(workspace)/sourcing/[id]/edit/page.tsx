import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'
import { BASIS_POINTS_WHOLE, MS_PER_HOUR } from '@/lib/constants'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { rfxDraftAiOf } from '@/server/services/ai'
import { rfxSetup, type RfxSetupDto } from '@/server/services/sourcing/rfx-setup'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { StatusBadge } from '@/ui/document/badges'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { Input } from '@/ui/shadcn/input'
import { Label } from '@/ui/shadcn/label'
import { isRfxStatus, RFX_STATUS_LOOK } from '@/ui/sourcing/rfx-looks'
import { SetupGeneral } from '@/ui/sourcing/setup-general'
import { SetupLines } from '@/ui/sourcing/setup-lines'
import { bangkokInstant, bangkokLocal, isSetupStep, percentOf, SETUP_STEPS, type SetupStep } from '@/ui/sourcing/setup-model'
import { SetupOpen } from '@/ui/sourcing/setup-open'
import { SetupScorecard } from '@/ui/sourcing/setup-scorecard'
import { SetupStepNav } from '@/ui/sourcing/setup-steps'
import { SetupSuppliers } from '@/ui/sourcing/setup-suppliers'
import { getSession } from '../../../../_lib/session'
import { localeOf, when } from '../../../_tracking/present'
import { addNeedLineAction, draftRfxAction, inviteAction, openRfxAction, removeRfxLineAction, setScorecardAction, uninviteAction, updateRfxAction } from '../../actions'

export async function generateMetadata() {
  const t = await getTranslations('sourcing.setup')
  return { title: t('edit.title') }
}

// /sourcing/[id]/edit (S10-12 · docs/sub-specs/S10.md "หน้าจอ"): the steps of an RFx before it opens — ทั่วไป · บรรทัด ·
// ผู้ขาย (the count against minInvites · BR-RFX-01) · Scorecard (weights in per cent, evaluators, the BR-SOD-14 note) ·
// กำหนดเวลา (the close at or after the earliest the system allows, the question cut-off worked out · BR-RFX-02) · ตรวจและ
// เปิด. Each step is its own address (?step=), read with GET, changed only by its form's command. While the RFx is open
// and before its close, the suppliers step alone stays (invite more or withdraw · BR-RFX-03). An RFI has no scorecard.
// sourcing.manage only (rfxSetup), and every command checks again.

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).slice(0, 40)
type T = Awaited<ReturnType<typeof getTranslations<'sourcing.setup'>>>

function stepsOf(s: RfxSetupDto): SetupStep[] {
  return SETUP_STEPS.filter((k) => k !== 'scorecard' || s.rfx.kind !== 'RFI')
}

function scorecardReady(s: RfxSetupDto): boolean {
  if (s.rfx.kind === 'RFI') return true
  const card = s.scorecard
  if (!card || card.criteria.length === 0 || card.criteria.reduce((n, c) => n + c.weightBp, 0) !== BASIS_POINTS_WHOLE) return false
  return card.criteria.every((c) => c.kind === 'PRICE') || card.evaluatorIds.length >= card.minEvaluators
}

const liveInvites = (s: RfxSetupDto) => s.invites.filter((i) => !['DECLINED', 'EXPIRED', 'REMOVED'].includes(i.status)).length

export default async function EditRfxPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const query = await searchParams
  const closesAt = bangkokInstant(one(query.closesAt)) ?? (one(query.closesAtIso) ? new Date(one(query.closesAtIso)).toISOString() : null)
  const [t, tCommon, locale] = await Promise.all([getTranslations('sourcing.setup'), getTranslations('adminSettings'), getLocale().then(localeOf)])
  const read = await rfxSetup(ctx, id, { closesAt })
  if (!read.ok) {
    if (read.error.code === 'NOT_FOUND') notFound()
    return <NoAccess title={t('edit.title')} message={read.error.code === 'MODULE_DISABLED' ? t('errors.MODULE_DISABLED') : tCommon('forbidden')} homeLabel={tCommon('homeLink')} />
  }
  const s = read.data
  const r = s.rfx
  const status = isRfxStatus(r.status) ? r.status : 'DRAFT'
  const draft = r.status === 'DRAFT'
  const inviting = draft || (r.status === 'OPEN' && r.closesAt !== null && ctx.now.getTime() < new Date(r.closesAt).getTime())
  const detailHref = `/sourcing/${id}`
  const asked = isSetupStep(query.step) ? query.step : 'general'
  const step: SetupStep = draft ? (stepsOf(s).includes(asked) ? asked : 'general') : 'suppliers'
  const hrefOf = (k: SetupStep) => `/sourcing/${id}/edit?step=${k}${closesAt && (k === 'schedule' || k === 'review') ? `&closesAtIso=${encodeURIComponent(closesAt)}` : ''}`
  const done: Record<SetupStep, boolean> = {
    general: true,
    lines: s.lines.length > 0,
    suppliers: liveInvites(s) >= r.minInvites,
    scorecard: scorecardReady(s),
    schedule: s.schedule !== null && !s.schedule.tooSoon,
    review: false,
  }
  const steps = stepsOf(s).map((k) => ({ key: k, label: t(`step.${k}`), href: draft || k === 'suppliers' ? hrefOf(k) : null, done: done[k] }))
  const title = r.number ? t('edit.titleOf', { number: r.number }) : t('edit.titleDraft', { title: r.title })

  return (
    <Page>
      <PageHeader
        title={title}
        intro={draft ? t('edit.intro') : t('edit.introOpen')}
        actions={<StatusBadge look={RFX_STATUS_LOOK[status]} label={t(`rfxStatus.${status}`)} />}
      />
      <PageBody>
        {!inviting ? (
          <div className="flex max-w-2xl flex-col gap-3">
            <Notice tone="info">{t('edit.closed')}</Notice>
            <Link href={detailHref} className={linkClass}>
              {t('edit.toDetail')}
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] lg:items-start lg:gap-6">
            <div className="flex flex-col gap-3">
              <SetupStepNav steps={steps} current={step} label={t('stepsLabel')} doneLabel={t('stepDone')} />
              <Link href={detailHref} className={linkClass}>
                {t('edit.toDetail')}
              </Link>
            </div>
            <Panel title={t(`step.${step}`)} id={`rfx-step-${step}`}>
              <StepBody t={t} s={s} step={step} locale={locale} id={id} closesAt={closesAt} detailHref={detailHref} hrefOf={hrefOf} ctx={ctx} />
            </Panel>
          </div>
        )}
      </PageBody>
    </Page>
  )
}

/** BR-FORM-11: a foreign invitee needs TH_EN, and TH_EN opens with all its English (rfx.open checks it again) */
function englishChecks(t: T, s: RfxSetupDto): Array<{ ok: boolean; text: string }> {
  const r = s.rfx
  if (r.englishMissing === null) return s.invites.some((i) => i.foreign) ? [{ ok: false, text: t('review.bilingualNeeded') }] : []
  const missing = r.englishMissing
  if (!missing.length) return [{ ok: true, text: t('review.english') }]
  const word = (path: string) => {
    const m = /^lines\.(\d+)\.(descriptionEn|uomEn)$/.exec(path)
    if (m) return t(m[2] === 'uomEn' ? 'review.englishLineUnit' : 'review.englishLineItem', { no: Number(m[1]) })
    return t(path === 'titleEn' ? 'review.englishTitle' : 'review.englishDescription')
  }
  return [{ ok: false, text: t('review.englishMissing', { fields: missing.map(word).join(', ') }) }]
}

async function StepBody({ t, s, step, locale, id, closesAt, detailHref, hrefOf, ctx }: { t: T; s: RfxSetupDto; step: SetupStep; locale: 'th' | 'en'; id: string; closesAt: string | null; detailHref: string; hrefOf: (k: SetupStep) => string; ctx: NonNullable<ReturnType<typeof ctxFromSession>> }) {
  const r = s.rfx
  const v = r.version
  const baht = (amount: string) => formatSatang(amountToSatang(amount))

  if (step === 'general') {
    // S10-16: the Sourcing Agent's button and its draft still open (nothing while the AI is off · EG-1)
    const ai = await rfxDraftAiOf(ctx, id)
    const draft = ai.open ? { agentActionId: ai.open.agentActionId, proposed: ai.open.proposed, requiredPaths: ai.open.requiredPaths, confirmedPaths: ai.open.confirmedPaths, applied: ai.applied } : null
    return (
      <div className="flex flex-col gap-4">
        <dl className="flex flex-wrap gap-x-8 gap-y-2">
          {r.kind === 'RFI' ? (
            <div className="flex flex-col">
              <dt className="text-base text-ink-muted md:text-sm">{t('field.kind')}</dt>
              <dd className="text-ink">{t(`kindLong.${r.kind}`)}</dd>
            </div>
          ) : null}
          <div className="flex flex-col">
            <dt className="text-base text-ink-muted md:text-sm">{t('field.category')}</dt>
            <dd className="text-ink">{r.categoryCode}</dd>
          </div>
        </dl>
        <SetupGeneral
          key={`${v}:${draft?.agentActionId ?? 'none'}`}
          initial={{
            bilingual: r.locale === 'TH_EN',
            kind: r.kind as 'RFQ' | 'RFP' | 'RFI',
            title: r.title,
            titleEn: r.titleEn ?? '',
            description: r.description,
            descriptionEn: r.descriptionEn ?? '',
            allowPartialBids: r.allowPartialBids,
            allowVatInclusiveBids: r.allowVatInclusiveBids,
            sealed: r.sealed,
            unsealReason: '',
            lines: s.lines.map((l) => ({ id: l.id, lineNo: l.lineNo, description: l.description, uom: l.uom, descriptionEn: l.descriptionEn ?? '', uomEn: l.uomEn ?? '' })),
          }}
          vatInclusiveAllowed={s.vatInclusiveAllowed}
          save={updateRfxAction.bind(null, id, v)}
          ai={ai.available || draft ? { available: ai.available, draft, ask: draftRfxAction.bind(null, id) } : null}
        />
      </div>
    )
  }

  if (step === 'lines') {
    return (
      <div className="flex flex-col gap-4">
        {r.estimatedNet ? <p className="text-ink">{t('lines.estimate', { amount: baht(r.estimatedNet), min: r.minInvites })}</p> : null}
        <SetupLines
          lines={s.lines.map((l) => ({
            id: l.id,
            title: t('lines.title', { no: l.lineNo, description: l.description }),
            quantity: t('lines.quantity', { quantity: l.quantity, uom: l.uom }),
            site: l.site,
            reference: l.refUnitPrice ? t('lines.reference', { price: baht(l.refUnitPrice), source: t(`refSource.${(l.refSource ?? 'MANUAL') as 'MANUAL'}`) }) : null,
            from: l.fromRequests.length ? t('lines.from', { requests: l.fromRequests.join(', ') }) : null,
          }))}
          need={r.sourceKind === 'NEED' ? { categoryCode: r.categoryCode } : null}
          catalog={s.catalog.map((i) => ({ id: i.id, label: `${i.code} · ${i.name}`, name: i.name, uom: i.uom, categoryCode: r.categoryCode, refUnitPrice: i.refUnitPrice }))}
          remove={removeRfxLineAction.bind(null, id, v)}
          add={addNeedLineAction.bind(null, id, v, r.categoryCode)}
        />
      </div>
    )
  }

  if (step === 'suppliers') {
    return (
      <SetupSuppliers
        invites={s.invites.map((i) => ({
          id: i.id,
          name: i.code ? t('suppliers.nameCode', { code: i.code, name: i.name }) : i.name,
          status: i.status,
          tags: [
            ...(i.owner === 'APPLICATION' ? [t('suppliers.tagApplication')] : []),
            ...(i.foreign ? [t('suppliers.tagForeign')] : []),
            ...(!i.vatRegistered ? [t('suppliers.tagNoVat')] : []),
            ...(i.risk?.tier ? [t('suppliers.tagRisk', { tier: i.risk.tier })] : []),
          ],
          warnings: [
            ...(i.registryFlag && i.registryFlag !== 'NONE' ? [t('suppliers.warnRegistry', { flag: i.registryFlag })] : []),
            ...(i.documentsOk === false ? [t('suppliers.warnDocuments')] : []),
            ...(i.risk?.blocked ? [t('suppliers.warnRisk')] : []),
          ],
        }))}
        minInvites={r.minInvites}
        suppliers={s.supplierChoices.map((c) => ({
          id: c.id,
          label: `${c.code} · ${c.name}${c.foreign ? ` · ${t('suppliers.tagForeign')}` : ''}`,
          sameCategory: c.sameCategory,
          refusal: c.refusal ? t(`errors.${c.refusal}`) : null,
        }))}
        applications={s.applicationChoices.map((a) => ({ id: a.id, label: t('suppliers.application', { name: a.name }) }))}
        invite={inviteAction.bind(null, id, v)}
        uninvite={uninviteAction.bind(null, id, v)}
      />
    )
  }

  if (step === 'scorecard') {
    const [th, en] = await Promise.all([getTranslations({ locale: 'th', namespace: 'sourcing.setup' }), getTranslations({ locale: 'en', namespace: 'sourcing.setup' })])
    const known = (code: string) => ['PRICE', 'DELIVERY', 'QUALITY', 'TECHNICAL', 'SUPPORT'].includes(code)
    const criteria = s.scorecard?.criteria.length
      ? s.scorecard.criteria.map((c) => ({ code: c.code, nameTh: c.nameTh, nameEn: c.nameEn ?? '', percent: percentOf(c.weightBp), kind: c.kind }))
      : Object.entries(s.defaultWeights).map(([code, bp]) => ({
          code,
          nameTh: known(code) ? th(`criterion.${code as 'PRICE'}`) : code,
          nameEn: known(code) ? en(`criterion.${code as 'PRICE'}`) : '',
          percent: percentOf(bp),
          kind: code === 'PRICE' ? ('PRICE' as const) : ('QUALITY' as const),
        }))
    return (
      <SetupScorecard
        initialCriteria={criteria}
        initialEvaluators={s.scorecard?.evaluatorIds ?? []}
        members={s.memberChoices.map((m) => ({ id: m.id, name: locale === 'en' && m.name.en ? m.name.en : m.name.th, conflict: m.conflict ? t(`scorecard.conflict${m.conflict === 'CREATOR' ? 'Creator' : 'Requester'}`) : null }))}
        minEvaluators={s.scorecard?.minEvaluators ?? s.minEvaluators}
        save={setScorecardAction.bind(null, id, v)}
      />
    )
  }

  if (step === 'schedule') {
    // an hour after the earliest by default: the seconds between this page and the opening never make it too soon
    const value = closesAt ? bangkokLocal(closesAt) : bangkokLocal(new Date(new Date(s.earliestCloseAt).getTime() + MS_PER_HOUR).toISOString())
    return (
      <form action={`/sourcing/${id}/edit`} method="get" className="flex flex-col gap-4">
        <input type="hidden" name="step" value="review" />
        <p className="text-ink">{t('schedule.rule', { days: s.openBusinessDays, earliest: when(locale, s.earliestCloseAt) })}</p>
        <p className="text-ink-muted">{t('schedule.cutoffRule', { days: s.cutoffBusinessDays })}</p>
        <div className="flex flex-col gap-2 md:w-72">
          <Label htmlFor="rfx-closes-at">{t('schedule.closesAt')}</Label>
          <Input id="rfx-closes-at" name="closesAt" type="datetime-local" className="min-h-11 lg:min-h-10" defaultValue={value} required />
        </div>
        <Button type="submit" className="min-h-11 self-start lg:min-h-10">
          {t('schedule.next')}
        </Button>
      </form>
    )
  }

  // review
  const live = liveInvites(s)
  const short = live < r.minInvites
  const checks = [
    { ok: s.lines.length > 0, text: s.lines.length > 0 ? t('review.lines', { count: s.lines.length }) : t('errors.NO_LINES') },
    { ok: live > 0 && !short, text: live > 0 ? (short ? t('review.invitesShort', { count: live, min: r.minInvites }) : t('review.invites', { count: live, min: r.minInvites })) : t('errors.NO_INVITES') },
    ...(r.kind === 'RFI' ? [] : [{ ok: scorecardReady(s), text: scorecardReady(s) ? t('review.scorecard') : t('errors.SCORECARD_INCOMPLETE') }]),
    ...englishChecks(t, s),
    {
      ok: s.schedule !== null && !s.schedule.tooSoon,
      text: s.schedule
        ? s.schedule.tooSoon
          ? t('review.tooSoon', { earliest: when(locale, s.earliestCloseAt) })
          : t('review.closes', { closes: when(locale, s.schedule.closesAt), cutoff: when(locale, s.schedule.questionCutoffAt) })
        : t('review.noClose'),
    },
  ]
  const ready = checks.every((c, i) => c.ok || (i === 1 && live > 0))
  return (
    <div className="flex flex-col gap-4">
      {!s.schedule || s.schedule.tooSoon ? (
        <Link href={hrefOf('schedule')} className={linkClass}>
          {t('review.pickClose')}
        </Link>
      ) : null}
      <SetupOpen
        checks={checks}
        needsReason={short && live > 0}
        ready={ready}
        closesText={s.schedule ? when(locale, s.schedule.closesAt) : null}
        open={openRfxAction.bind(null, id, v, s.schedule?.closesAt ?? '')}
        detailHref={detailHref}
      />
    </div>
  )
}
