import { getLocale, getTranslations } from 'next-intl/server'
import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai/date'
import { DELEGATION_DOCUMENT_TYPES, getMyDelegations, type DelegationViewRow } from '@/server/services/delegations/view'
import { formatDateTime } from '@/ui/format'
import { LiffDelegationForm } from '@/ui/liff/delegation/delegation-form'
import { LiffRevokeDelegationControl } from '@/ui/liff/delegation/revoke'
import { LiffDelegationStateMark } from '@/ui/liff/delegation/state-mark'
import { LiffContent, LiffFrame, LiffSection } from '@/ui/liff/frame'
import { LiffGate } from '@/ui/liff/liff-gate'
import { LiffNotice } from '@/ui/liff/notice'
import { liffPage } from '../_lib/session'
import { createLiffDelegationAction, revokeLiffDelegationAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('delegation')
  return { title: t('title') }
}

// /liff/delegation (§9.4 "ตั้งรักษาการ", S5-06, FR-DOA-006 AC2 LIFF part, demo scene 11): an approver names who acts for
// them while they are away, from the LINE app, through the same service and rules as the workspace's
// /settings/delegation (createDelegationForDays, BR-DLG-01 to BR-DLG-03) on channel LIFF; the delegations they set, with
// cancelling one that runs or is still to come (an ended or cancelled one offers nothing); and whom they act for. Data
// only for a member (the gate signs in with LINE first, ADR-046). A member without a position learns why there is
// nothing to hand over (BR-DLG-01) and sees no form. One column for a phone: the introduction, the form with its button
// in the bar at the bottom of the screen (src/ui/liff/delegation/delegation-form.tsx), then the two lists.
export default async function LiffDelegationPage() {
  const [t, tLiff, locale, page] = await Promise.all([getTranslations('delegation'), getTranslations('liffDelegation'), getLocale(), liffPage()])
  if (page.kind !== 'member') {
    return (
      <LiffFrame title={t('title')}>
        <LiffContent>
          <LiffGate mode="member" state={page.kind} />
        </LiffContent>
      </LiffFrame>
    )
  }

  const view = await getMyDelegations(page.ctx)
  if (!view.ok) {
    return (
      <LiffFrame title={t('title')}>
        <LiffContent>
          <LiffNotice tone="danger">{t('errors.FORBIDDEN')}</LiffNotice>
        </LiffContent>
      </LiffFrame>
    )
  }

  const { given, received, positions, candidates, today } = view.data
  const en = locale === 'en'
  const nameOf = (p: { nameTh: string; nameEn: string | null }) => (en && p.nameEn ? p.nameEn : p.nameTh)
  const day = (d: string) => (en ? formatEnglishBeDate(d) : formatThaiDate(d))
  const periodOf = (row: DelegationViewRow) =>
    row.days ? t('period', { from: day(row.days.first), to: day(row.days.last) }) : t('period', { from: formatDateTime(locale, row.startsAt), to: formatDateTime(locale, row.endsAt) })
  const coverageOf = (row: DelegationViewRow) => (row.documentTypes.length ? t('coverSome', { types: row.documentTypes.map((d) => t(`documentTypes.${d}`)).join(', ') }) : t('coverAll'))
  const canDelegate = positions.length > 0
  const showGiven = canDelegate || given.length > 0

  const rowDetails = (row: DelegationViewRow) => (
    <>
      <p>{periodOf(row)}</p>
      <p className="text-ink-muted">{coverageOf(row)}</p>
      <p>
        {row.maxAmount ? (
          <>
            {t('cap')} <span className="money inline-block font-medium">{formatSatang(amountToSatang(row.maxAmount))}</span> {t('capUnit')}
          </>
        ) : (
          t('noCap')
        )}
      </p>
      <p className="break-words text-ink-muted">{t('reasonLine', { reason: row.reason })}</p>
      {row.createdVia === 'ORG_AUTHORITY_CHANGE' ? <p className="text-ink-muted">{t('viaAuthorityChange')}</p> : null}
    </>
  )

  // What a delegation does, as this build does it (BR-DLG-04 with S5's delegation-window job): when the period starts the
  // tasks waiting for the delegator move to the acting approver, new ones go there too, and what is left comes back at
  // the end — the LIFF page's own words while the workspace's (delegation.intro) speak of new tasks only
  const intro = (
    <div className="flex flex-col gap-2">
      <p>{tLiff('intro')}</p>
      {canDelegate ? (
        <p className="text-ink-muted">
          {t('positionsLine', {
            positions: positions
              .map((p) => t('positionItem', { position: en && p.positionEn ? p.positionEn : p.positionTh, department: en && p.departmentEn ? p.departmentEn : p.departmentTh }))
              .join(', '),
          })}
        </p>
      ) : null}
    </div>
  )

  // Someone with nothing to hand over and nothing handed over sees only what they act for
  const givenSection = showGiven ? (
    <LiffSection id="liff-delegation-given" title={t('givenTitle')}>
      {given.length === 0 ? (
        <p className="text-ink-muted">{t('givenEmpty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line border-t border-line">
          {given.map((row) => (
            <li key={row.id} className="flex flex-col gap-3 py-4">
              <div className="flex min-w-0 flex-col gap-1">
                <p className="font-medium">{nameOf(row.delegate)}</p>
                <LiffDelegationStateMark state={row.state} label={t(`state.${row.state}`)} />
                {rowDetails(row)}
              </div>
              <LiffRevokeDelegationControl
                delegationId={row.id}
                delegateName={nameOf(row.delegate)}
                revocable={row.state === 'ACTIVE' || row.state === 'SCHEDULED'}
                revoke={revokeLiffDelegationAction}
              />
            </li>
          ))}
        </ul>
      )}
    </LiffSection>
  ) : null

  const receivedSection = (
    <LiffSection id="liff-delegation-received" title={t('receivedTitle')}>
      {received.length === 0 ? (
        <p className="text-ink-muted">{t('receivedEmpty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line border-t border-line">
          {received.map((row) => (
            <li key={row.id} className="flex flex-col gap-1 py-4">
              <p className="font-medium">{nameOf(row.delegator)}</p>
              <LiffDelegationStateMark state={row.state} label={t(`state.${row.state}`)} />
              {rowDetails(row)}
            </li>
          ))}
        </ul>
      )}
    </LiffSection>
  )

  if (!canDelegate) {
    return (
      <LiffFrame title={t('title')}>
        <LiffContent>
          {intro}
          <LiffNotice tone="info">{t('noPosition')}</LiffNotice>
          {givenSection}
          {receivedSection}
        </LiffContent>
      </LiffFrame>
    )
  }

  return (
    <LiffFrame title={t('title')}>
      <LiffDelegationForm
        candidates={candidates.map((c) => {
          const department = en && c.departmentEn ? c.departmentEn : c.departmentTh
          return { id: c.id, name: nameOf(c), label: department ? t('candidate', { name: nameOf(c), department }) : nameOf(c) }
        })}
        documentTypes={DELEGATION_DOCUMENT_TYPES.map((d) => ({ value: d, label: t(`documentTypes.${d}`) }))}
        today={today}
        givenKey={given.map((row) => `${row.id}:${row.state}`).join('|')}
        create={createLiffDelegationAction}
        before={intro}
        after={
          <>
            {givenSection}
            {receivedSection}
          </>
        }
      />
    </LiffFrame>
  )
}
