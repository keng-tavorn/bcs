import { CircleCheck, TriangleAlert } from 'lucide-react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { SIMULATION_FIELDS, getDoaSimulation, type SimulatedRouteView, type SimulationQuery } from '@/server/services/doa/simulate'
import { versionLook } from '@/ui/admin-doa/version-status'
import { departmentOption, memberLabel, nameIn } from '@/ui/admin-org/names'
import { SelectField } from '@/ui/admin-org/select-field'
import { Button } from '@/ui/form/button'
import { Field } from '@/ui/form/field'
import { Notice } from '@/ui/form/notice'
import { getSession } from '../../../../../_lib/session'
import { keepTogether } from '../../_parts/sections'
import { DOCUMENT_TYPES, doaWords, type DoaT, type DoaWords } from '../../_parts/words'

export async function generateMetadata() {
  const t = await getTranslations('adminDoa')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'

/** One version's route: the rule, each approver with where they were found, and the Thai explanation of the engine */
function RouteResult({ id, title, route, t, words, locale }: { id: string; title: ReactNode; route: SimulatedRouteView; t: DoaT; words: DoaWords; locale: string }) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3 border-t-4 border-line pt-3">
      <h3 id={id} className="text-lg font-semibold">
        {title}
      </h3>
      {route.ok ? (
        <>
          <p className="font-medium">{t('simulate.rule', { rule: route.ruleCode })}</p>
          {route.escalatedFromRuleCode ? <p className="text-ink-muted">{t('simulate.escalated', { rule: route.escalatedFromRuleCode })}</p> : null}
          <p className="tabular text-ink-muted">
            {route.basisAmount === null ? t('simulate.noAmount') : t('simulate.basis', { amount: words.money(route.basisAmount), basis: t(`detail.policy.${route.amountBasis}`) })}
          </p>
          <ol aria-label={t('simulate.stepsLabel')} className="flex flex-col divide-y divide-line border-y border-line">
            {route.steps.map((s, i) => (
              <li key={`${s.assignee.id}-${i}`} className="flex flex-col gap-0.5 py-2.5">
                <p className="text-base text-ink-muted md:text-sm">{t('simulate.step', { n: i + 1 })}</p>
                <p className="font-semibold">{nameIn(locale, s.assignee)}</p>
                <p className="text-ink-muted">
                  {s.position && s.department ? t('simulate.via', { position: `${nameIn(locale, s.position)} (${s.position.code})`, department: nameIn(locale, s.department) }) : t('simulate.viaMember')}
                </p>
                {/* The time under the SLA on its own line, as the editor's rows show it, so nothing dangles at a line end */}
                <p className="text-ink-muted">{words.sla(s.slaMinutes)}</p>
                {s.principal ? <p className="text-ink-muted">{t('simulate.acting', { principal: nameIn(locale, s.principal) })}</p> : null}
              </li>
            ))}
          </ol>
          <div className="flex flex-col gap-1">
            <p className="text-base font-medium md:text-sm">{t('simulate.explanation')}</p>
            <p lang="th" className="tabular break-words border-l-4 border-line pl-3">
              {route.explanationTh}
            </p>
          </div>
        </>
      ) : (
        <Notice tone="danger">
          {route.code === 'DOA_NOT_CONFIGURED' ||
          route.code === 'DOA_AMBIGUOUS' ||
          route.code === 'APPROVER_NOT_FOUND' ||
          route.code === 'NO_HIGHER_AUTHORITY' ||
          route.code === 'SOD_VIOLATION' ||
          route.code === 'VALIDATION_FAILED'
            ? t(`simulate.routeErrors.${route.code}`, { rules: route.rules.join(', '), position: route.position ?? '', departments: route.departments.join(', ') })
            : t('simulate.routeErrors.OTHER', { code: route.code })}
        </Notice>
      )}
    </section>
  )
}

// The DOA try-out (FR-DOA-009 AC2, BR-DOA-14): a document type, amount, charged department and requester in; the
// route of the version in effect and of this version out, side by side on wide screens and one after the other on
// phones, with a sentence that says whether they differ. A GET form: it changes nothing, so the address can be kept or
// shared. The service routes with the engine of real routing at this moment (admin.doa.simulate, ORG_ADMIN only).
export default async function DoaSimulatePage({ params, searchParams }: { params: Promise<{ versionId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ versionId }, raw] = await Promise.all([params, searchParams])
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, locale] = await Promise.all([getTranslations('adminDoa'), getLocale()])
  if (!ctx) return null
  const query: SimulationQuery = Object.fromEntries(SIMULATION_FIELDS.map((f) => [f, typeof raw[f] === 'string' ? raw[f] : undefined]))
  const result = await getDoaSimulation(ctx, versionId, query)
  if (!result.ok && result.error.code === 'NOT_FOUND') notFound()
  if (!result.ok) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <Notice tone="danger">{t('simulate.forbidden')}</Notice>
        <Link href="/" className={`${linkClass} self-start`}>
          {t('homeLink')}
        </Link>
      </div>
    )
  }
  const view = result.data
  const words = doaWords(t, locale)
  const name = words.versionName(view.version)
  const look = versionLook(view.version)
  const status = t(`status.${look}`)
  const fieldError = (f: 'type' | 'vat' | 'department' | 'requester') => (view.errors[f] ? t(`simulate.fieldErrors.${f}`) : undefined)
  const netError = view.errors.net ? t(`simulate.fieldErrors.net.${view.errors.net}`) : undefined
  const outcome = view.result
  const names = (r: SimulatedRouteView | null) => (r?.ok ? r.steps.map((s) => nameIn(locale, s.assignee)).join(', ') : null)
  const isInEffect = view.inEffect?.id === view.version.id

  return (
    <div className="flex flex-col gap-8">
      <Link href={`/admin/doa/${view.version.id}`} className={`${linkClass} self-start`}>
        {t('simulate.back', { name })}
      </Link>
      <div className="flex max-w-3xl flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('simulate.title', { name })}</h1>
        <p className="text-ink-muted">{t('simulate.intro')}</p>
      </div>

      <section aria-labelledby="try" className="flex max-w-4xl flex-col gap-4">
        <h2 id="try" className="text-xl font-semibold">
          {t('simulate.formTitle')}
        </h2>
        <form method="get" className="flex flex-col gap-5" noValidate>
          <div className="grid gap-5 md:grid-cols-2">
            <SelectField
              id="sim-type"
              name="type"
              label={t('simulate.type')}
              defaultValue={view.input.type}
              options={DOCUMENT_TYPES.map((d) => ({ value: d, label: words.documentType(d) }))}
              error={fieldError('type')}
            />
            <SelectField
              id="sim-department"
              name="department"
              label={t('simulate.department')}
              hint={t('simulate.departmentHint')}
              placeholder={t('choose')}
              defaultValue={view.input.department}
              options={view.departments.map((d) => ({ value: d.id, label: departmentOption(locale, d) }))}
              error={fieldError('department')}
            />
            <Field id="sim-net" name="net" label={t('simulate.net')} hint={t('simulate.netHint')} inputMode="decimal" defaultValue={view.input.net} error={netError} className="money" />
            <Field id="sim-vat" name="vat" label={t('simulate.vat')} hint={t('simulate.vatHint')} inputMode="decimal" defaultValue={view.input.vat} error={fieldError('vat')} className="money" />
            <SelectField
              id="sim-requester"
              name="requester"
              label={t('simulate.requester')}
              hint={t('simulate.requesterHint')}
              placeholder={t('choose')}
              defaultValue={view.input.requester}
              options={view.members.map((m) => ({ value: m.id, label: memberLabel(locale, m) }))}
              error={fieldError('requester')}
            />
          </div>
          <Button type="submit" className="self-start">
            {t('simulate.submit')}
          </Button>
        </form>
      </section>

      <section aria-labelledby="result" aria-live="polite" className="flex flex-col gap-4">
        <h2 id="result" className="text-xl font-semibold">
          {t('simulate.resultTitle')}
        </h2>
        {outcome === null ? (
          <p className="border-y border-line py-4 text-ink-muted">{t('simulate.empty')}</p>
        ) : (
          <>
            {outcome.inEffect === null ? (
              <Notice tone="info">{t('simulate.noInEffect')}</Notice>
            ) : isInEffect ? (
              <Notice tone="info">{t('simulate.isInEffect')}</Notice>
            ) : outcome.sameApprovers ? (
              <p className="flex items-start gap-2 font-medium">
                <CircleCheck className="mt-1 size-4 shrink-0 text-primary" aria-hidden="true" />
                <span>{t('simulate.same', { names: names(outcome.version) ?? '' })}</span>
              </p>
            ) : (
              <p className="flex items-start gap-2 font-medium">
                <TriangleAlert className="mt-1 size-4 shrink-0 text-warn" aria-hidden="true" />
                <span>
                  {names(outcome.inEffect) !== null && names(outcome.version) !== null
                    ? t('simulate.different', { before: names(outcome.inEffect)!, after: names(outcome.version)! })
                    : t('simulate.differentError')}
                </span>
              </p>
            )}
            <div className="grid gap-8 lg:grid-cols-2">
              {outcome.inEffect && view.inEffect ? (
                <RouteResult id="route-in-effect" title={t.rich('simulate.inEffectTitle', { name: words.versionName(view.inEffect), now: keepTogether })} route={outcome.inEffect} t={t} words={words} locale={locale} />
              ) : null}
              <RouteResult id="route-version" title={t('simulate.versionTitle', { name, status })} route={outcome.version} t={t} words={words} locale={locale} />
            </div>
          </>
        )}
      </section>
    </div>
  )
}
