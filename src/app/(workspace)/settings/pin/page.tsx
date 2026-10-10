import { CircleCheck, CircleMinus } from 'lucide-react'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getOwnPinStatus } from '@/server/services/self/pin'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { PinSetup } from '@/ui/settings-pin/pin-setup'
import { getSession } from '../../../_lib/session'
import { proveIdentityForPinAction, setOwnPinAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('pinSettings')
  return { title: t('title') }
}

// The member's own transaction PIN (FR-AUTH-005 AC1, §9.1 /settings/*): whether it is set or locked, the PIN rules in
// words, and setting or changing it in two steps (prove who you are, then the new PIN twice). One column, status first,
// each part in its white card on --surface under the page's title (the frame of S16-10).
export default async function PinPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, tCommon, locale] = await Promise.all([getTranslations('pinSettings'), getTranslations('adminSettings'), getLocale()])
  if (!ctx) return null
  // Real time: the lock of FR-AUTH-005 AC3 runs on the security clock
  const status = await getOwnPinStatus(ctx)
  if (!status.ok) return <NoAccess title={t('title')} message={t('errors.FORBIDDEN')} homeLabel={tCommon('homeLink')} />
  const { hasPin, lockedUntil, attemptsLeft, proofMethods } = status.data

  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')} />
      <PageBody>
        <Panel id="pin-status" title={t('statusTitle')} className="max-w-3xl">
          {hasPin ? (
            <div className="flex flex-col gap-1">
              <p className="flex items-center gap-2 font-medium">
                <CircleCheck className="size-5 shrink-0 text-primary" aria-hidden="true" />
                <span>{t('status.set')}</span>
              </p>
              {lockedUntil ? null : <p className="text-ink-muted">{t('status.attemptsLeft', { count: attemptsLeft })}</p>}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="flex items-center gap-2 font-medium">
                <CircleMinus className="size-5 shrink-0 text-ink-muted" aria-hidden="true" />
                <span>{t('status.notSet')}</span>
              </p>
              <p className="text-ink-muted">{t('status.notSetHint')}</p>
            </div>
          )}
          {lockedUntil ? (
            <Notice tone="warning">
              <p>{t('status.locked', { time: formatDateTime(locale, lockedUntil) })}</p>
              {/* ADR-047 item 5 (waiting for the user's confirmation): a new PIN after a fresh proof ends the lock now, as
                  self.set_pin does. If item 5 is rejected, this sentence goes together with that behaviour. Not said to a
                  member who has no way to make that proof (PinSetup says so below). */}
              {proofMethods.length > 0 ? <p>{t('status.lockedUnlock')}</p> : null}
            </Notice>
          ) : null}
        </Panel>

        <Panel id="pin-rules" title={t('rules.title')} className="max-w-3xl">
          <ul className="flex list-disc flex-col gap-1 pl-6">
            <li>{t('rules.digits')}</li>
            <li>{t('rules.notSame')}</li>
            <li>{t('rules.notSequence')}</li>
            <li>{t('rules.notCommon')}</li>
          </ul>
          <p className="text-ink-muted">{t('rules.private')}</p>
        </Panel>

        <Panel label={t('setupLabel')} className="max-w-3xl">
          <PinSetup hasPin={hasPin} proofMethods={proofMethods} prove={proveIdentityForPinAction} setPin={setOwnPinAction} />
        </Panel>
      </PageBody>
    </Page>
  )
}
