import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getPortalBankAccount, getPortalHome, type PortalBankStage } from '@/server/portal/queries'
import { PortalButton, PortalField, PortalFrame, PortalNotice, portalInputClass, portalTextareaClass } from '@/ui/portal/frame'
import { one, pageOrg, pageSession, portalNav, Unavailable, type SearchParams } from '../_lib/page'

// /portal/[org]/bank-account (S7-10 · FR-SUP-103 AC1 AC4 · ADR-190): the supplier's account in force, masked, where its
// latest request stands (waiting for finance to take it, finance checking it, waiting for approval, in force), and —
// for the primary contact while no request is open — the form that proposes a new one with its proof. The number never
// comes back to the page whole.

const ERRORS = ['NEW_CONTACT_HOLD', 'CHANGE_OPEN', 'PROOF_REQUIRED', 'TYPE_NOT_ALLOWED', 'TOO_LARGE', 'ACCOUNT', 'NAMES_ACCOUNT', 'FORBIDDEN'] as const
const STAGES: readonly PortalBankStage[] = ['AWAITING_CLAIM', 'CHECKING', 'APPROVING', 'IN_FORCE']

export default async function PortalBankAccountPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const org = await pageOrg((await params).org)
  if (!org) return <Unavailable />
  const session = await pageSession(org)
  if (!session) redirect(`/portal/${org.code}/login`)
  const { ctx } = session.state
  const [t, tp, q, home, bank] = await Promise.all([getTranslations('supplierBank.portal'), getTranslations('portal'), searchParams, getPortalHome(ctx), getPortalBankAccount(ctx)])
  if (home.privacyNoticeDue) redirect(`/portal/${org.code}`)
  if (!bank) redirect(`/portal/${org.code}/apply`)
  const error = one(q.error)
  const known = error && (ERRORS as readonly string[]).includes(error) ? (error as (typeof ERRORS)[number]) : null
  const stage = bank.latest?.stage
  return (
    <PortalFrame organization={org.nameTh} title={t('title')} nav={portalNav(org.code, tp, 'bank-account', 'SUPPLIER')} navLabel={tp('nav.label')}>
      <p className="text-ink-muted">{t('intro')}</p>
      {one(q.sent) ? <PortalNotice tone="success">{t('sent')}</PortalNotice> : null}
      {error ? <PortalNotice tone="danger">{known ? t(`errors.${known}`) : t('errors.FAILED')}</PortalNotice> : null}
      <section aria-labelledby="current" className="flex flex-col gap-1">
        <h2 id="current" className="text-lg font-semibold">
          {t('current')}
        </h2>
        <p>{bank.current ? t('account', { bank: bank.current.bankName, last4: bank.current.last4, name: bank.current.accountName }) : t('currentNone')}</p>
      </section>
      {bank.latest && stage ? (
        <section aria-labelledby="latest" className="flex flex-col gap-2 border-t border-line pt-4">
          <h2 id="latest" className="text-lg font-semibold">
            {t('latest')}
          </h2>
          {bank.latest.bankName && bank.latest.last4 ? <p>{t('latestAccount', { bank: bank.latest.bankName, last4: bank.latest.last4 })}</p> : null}
          {STAGES.includes(stage) ? (
            <ol aria-label={t('stagesLabel')} className="flex flex-col gap-1">
              {STAGES.map((s, i) => {
                const at = STAGES.indexOf(stage)
                return (
                  <li key={s} aria-current={s === stage ? 'step' : undefined} className={i <= at ? 'font-medium text-ink' : 'text-ink-muted'}>
                    {i < at || (i === at && s === 'IN_FORCE') ? '✓ ' : i === at ? '• ' : ''}
                    {t(`stage.${s}`)}
                  </li>
                )
              })}
            </ol>
          ) : (
            <p>{t(`stage.${stage}`)}</p>
          )}
        </section>
      ) : null}
      <section aria-labelledby="propose" className="flex flex-col gap-3 border-t border-line pt-4">
        <h2 id="propose" className="text-lg font-semibold">
          {t('proposeTitle')}
        </h2>
        {!bank.isPrimary ? (
          <p className="text-ink-muted">{t('notPrimary')}</p>
        ) : !bank.mayPropose ? (
          <p className="text-ink-muted">{t('open')}</p>
        ) : (
          <form method="post" action={`/portal/${org.code}/api/bank-account`} encType="multipart/form-data" className="flex flex-col gap-4" autoComplete="off">
            <input type="hidden" name="csrf" value={session.csrf} />
            <input type="hidden" name="key" value={randomUUID()} />
            <PortalField id="bankCode" label={t('bank')}>
              <select id="bankCode" name="bankCode" required defaultValue="" className={portalInputClass}>
                <option value="" disabled>
                  {t('choose')}
                </option>
                {bank.banks.map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.nameTh} ({b.shortName})
                  </option>
                ))}
              </select>
            </PortalField>
            <PortalField id="accountNo" label={t('accountNo')}>
              <input id="accountNo" name="accountNo" required inputMode="numeric" maxLength={40} className={portalInputClass} />
            </PortalField>
            <PortalField id="accountName" label={t('accountName')}>
              <input id="accountName" name="accountName" required maxLength={200} className={portalInputClass} />
            </PortalField>
            <PortalField id="branchName" label={t('branch')}>
              <input id="branchName" name="branchName" maxLength={200} className={portalInputClass} />
            </PortalField>
            <PortalField id="reason" label={t('reason')} hint={t('reasonHint')}>
              <textarea id="reason" name="reason" required minLength={3} maxLength={500} aria-describedby="reason-hint" className={portalTextareaClass} />
            </PortalField>
            <PortalField id="file" label={t('proof')} hint={t('proofHint')}>
              <input id="file" name="file" type="file" required accept="application/pdf,image/jpeg,image/png" aria-describedby="file-hint" className="text-base" />
            </PortalField>
            <PortalButton type="submit">{t('submit')}</PortalButton>
          </form>
        )}
      </section>
    </PortalFrame>
  )
}
