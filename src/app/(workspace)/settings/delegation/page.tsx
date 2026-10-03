import { getLocale, getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import { amountToSatang } from '@/core/money/dto'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai/date'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { DELEGATION_DOCUMENT_TYPES, getMyDelegations, type DelegationViewRow } from '@/server/services/delegations/view'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { DelegationForm } from '@/ui/delegation/delegation-form'
import { DelegationState } from '@/ui/delegation/delegation-state'
import { RevokeDelegation } from '@/ui/delegation/revoke-delegation'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
import { getSession } from '../../../_lib/session'
import { createDelegationAction, revokeDelegationAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('delegation')
  return { title: t('title') }
}

// Acting approver (NEW-06, FR-DOA-006 AC2 web, §7.6, §9.1 /settings/*): who acts for me, when, for what and up to how
// much, and whom I act for. Wide screens: the lists on the left, the form on the right; phones: the form first.
// A member without a position learns why they have nothing to hand over instead of seeing the form (BR-DLG-01).
export default async function DelegationPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, tSettings, locale] = await Promise.all([getTranslations('delegation'), getTranslations('adminSettings'), getLocale()])
  if (!ctx) return null
  const view = await getMyDelegations(ctx)
  if (!view.ok) return <NoAccess title={t('title')} message={t('errors.FORBIDDEN')} homeLabel={tSettings('homeLink')} />
  const { given, received, positions, candidates, today } = view.data
  const en = locale === 'en'
  const nameOf = (p: { nameTh: string; nameEn: string | null }) => (en && p.nameEn ? p.nameEn : p.nameTh)
  const day = (d: string) => (en ? formatEnglishBeDate(d) : formatThaiDate(d))
  const periodOf = (row: DelegationViewRow) =>
    row.days ? t('period', { from: day(row.days.first), to: day(row.days.last) }) : t('period', { from: formatDateTime(locale, row.startsAt), to: formatDateTime(locale, row.endsAt) })
  const coverageOf = (row: DelegationViewRow) =>
    row.documentTypes.length ? t('coverSome', { types: row.documentTypes.map((d) => t(`documentTypes.${d}`)).join(', ') }) : t('coverAll')
  const canDelegate = positions.length > 0
  const showGiven = canDelegate || given.length > 0

  const rowDetails = (row: DelegationViewRow) => (
    <>
      <p className="text-base md:text-sm">{periodOf(row)}</p>
      <p className="text-base text-ink-muted md:text-sm">{coverageOf(row)}</p>
      <p className="text-base md:text-sm">
        {row.maxAmount ? (
          <>
            {t('cap')} <span className="money inline-block font-medium">{formatSatang(amountToSatang(row.maxAmount))}</span> {t('capUnit')}
          </>
        ) : (
          t('noCap')
        )}
      </p>
      <p className="text-base break-words text-ink-muted md:text-sm">{t('reasonLine', { reason: row.reason })}</p>
      {row.createdVia === 'ORG_AUTHORITY_CHANGE' ? <p className="text-base text-ink-muted md:text-sm">{t('viaAuthorityChange')}</p> : null}
    </>
  )

  return (
    <div className="flex flex-col gap-8">
      <div className="flex max-w-3xl flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
        {canDelegate ? (
          <p className="text-ink-muted">
            {t('positionsLine', { positions: positions.map((p) => t('positionItem', { position: en && p.positionEn ? p.positionEn : p.positionTh, department: en && p.departmentEn ? p.departmentEn : p.departmentTh })).join(', ') })}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-10 lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:grid-rows-[auto_1fr] lg:items-start lg:gap-x-12">
        <section aria-labelledby="new-delegation" className="flex flex-col gap-4 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <h2 id="new-delegation" className="text-xl font-semibold">
            {t('formTitle')}
          </h2>
          {canDelegate ? (
            <DelegationForm
              candidates={candidates.map((c) => {
                const department = en && c.departmentEn ? c.departmentEn : c.departmentTh
                return { id: c.id, name: nameOf(c), label: department ? t('candidate', { name: nameOf(c), department }) : nameOf(c) }
              })}
              documentTypes={DELEGATION_DOCUMENT_TYPES.map((d) => ({ value: d, label: t(`documentTypes.${d}`) }))}
              today={today}
              givenKey={given.map((row) => `${row.id}:${row.state}`).join('|')}
              create={createDelegationAction}
            />
          ) : (
            <Notice tone="info">{t('noPosition')}</Notice>
          )}
        </section>

        {/* Someone with nothing to hand over and nothing handed over sees only what they act for */}
        {showGiven ? (
          <section aria-labelledby="given" className="flex flex-col gap-4 lg:col-start-1 lg:row-start-1">
            <h2 id="given" className="text-xl font-semibold">
              {t('givenTitle')}
            </h2>
            {given.length === 0 ? (
              <p className="text-ink-muted">{t('givenEmpty')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line border-y border-line">
                {given.map((row) => (
                  <li key={row.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                    <div className="flex min-w-0 flex-col gap-1">
                      <p className="font-medium">{nameOf(row.delegate)}</p>
                      {rowDetails(row)}
                    </div>
                    <div className="flex shrink-0 flex-col gap-2 sm:max-w-xs sm:items-end">
                      <DelegationState state={row.state} label={t(`state.${row.state}`)} className="text-base md:text-sm" />
                      <RevokeDelegation
                        delegationId={row.id}
                        delegateName={nameOf(row.delegate)}
                        revocable={row.state === 'ACTIVE' || row.state === 'SCHEDULED'}
                        revoke={revokeDelegationAction}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        <section aria-labelledby="received" className={showGiven ? 'flex flex-col gap-4 border-t border-line pt-6 lg:col-start-1 lg:row-start-2' : 'flex flex-col gap-4 lg:col-start-1 lg:row-start-1'}>
          <h2 id="received" className="text-xl font-semibold">
            {t('receivedTitle')}
          </h2>
          {received.length === 0 ? (
            <p className="text-ink-muted">{t('receivedEmpty')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line border-y border-line">
              {received.map((row) => (
                <li key={row.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="font-medium">{nameOf(row.delegator)}</p>
                    {rowDetails(row)}
                  </div>
                  <DelegationState state={row.state} label={t(`state.${row.state}`)} className="text-base md:text-sm" />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
