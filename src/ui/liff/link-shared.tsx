'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { lazy, Suspense, type ReactNode } from 'react'
import { LiffActionBar } from './action-bar'
import { LIFF_HOME_PATH, WEB_LINE_SETTINGS_PATH } from './bootstrap'
import { Button } from './button'
import { LiffContent } from './content'
import { LIFF_LINK_CLASS, LiffLink } from './liff-link'
import { useLiff } from './liff-provider'
import { linkRefusalKey, retryTimeOf, type LinkRefusal, type LinkRefusalKey } from './link-refusal'
import { LiffNotice } from './notice'
import { LiffRefusal } from './refusal'
import { LIFF_RICH } from './rich'

// What the screens of /liff/link share (./link-flow.tsx, ./link-member.tsx): the words of a refusal, the way to LINE
// settings on the web, what a browser outside the LINE app is told, the bar with the confirm button and the screen after
// a link. Kept apart so the member screens, loaded only for a signed-in member, reuse them instead of carrying them.

/** Refusals after which the same button cannot help (the code is spent, someone else's, or LINE is off) */
const FINAL: ReadonlySet<LinkRefusalKey> = new Set([
  'TOKEN_EXPIRED',
  'UNLINKED_SINCE',
  'TOKEN_USED',
  'TOKEN_INVALID',
  'ACCOUNT_LINKED_TO_ANOTHER_MEMBER',
  'MEMBER_LINKED_TO_ANOTHER_ACCOUNT',
  'ALREADY_LINKED',
  'LINE_NOT_ENABLED',
  'FORBIDDEN',
  'SIGN_IN_WITH_PASSWORD',
])

/** No ID token could be had: as LINE refusing it */
export const NO_TOKEN: LinkRefusal = { code: 'UNAUTHENTICATED', reason: 'ID_TOKEN_INVALID' }

export type LinkState = { readonly kind: 'idle' } | { readonly kind: 'working' } | { readonly kind: 'done' } | { readonly kind: 'refused'; readonly refusal: LinkRefusal }

/** The words of a refusal, with its values (minutes a code lasts, when to try again in the page's time zone) */
export function useRefusalText(codeMinutes: number) {
  const t = useTranslations('liff.link.refused')
  const format = useFormatter()
  return (refusal: LinkRefusal) => {
    const key = linkRefusalKey(refusal)
    const retryAt = retryTimeOf(refusal)
    return { key, text: t(key, { minutes: codeMinutes, time: retryAt ? format.dateTime(retryAt, { hour: '2-digit', minute: '2-digit' }) : '' }) }
  }
}

/** The link to LINE settings on the web: a new code, or another LINE app through its QR code */
export function SettingsLink() {
  const t = useTranslations('liff.link')
  return (
    <a href={WEB_LINE_SETTINGS_PATH} className={LIFF_LINK_CLASS}>
      {t('settingsLink')}
    </a>
  )
}

/** LIFF_MOCK only: a developer's way to act as a LINE user in an ordinary browser (loaded on demand) */
const MockLineUser = lazy(() => import('./mock-line-user').then((m) => ({ default: m.MockLineUser })))

/** A browser outside the LINE app: what to do there, and LINE settings on the web */
export function OutsideLine({ children }: { readonly children: ReactNode }) {
  const { mockCookie } = useLiff()
  return (
    <>
      <LiffNotice tone="info">
        <p>{children}</p>
        <SettingsLink />
      </LiffNotice>
      {mockCookie ? (
        <Suspense fallback={null}>
          <MockLineUser cookie={mockCookie} />
        </Suspense>
      ) : null}
    </>
  )
}

/** A link that looks like the primary button (the one next step of a finished screen) */
const PRIMARY_LINK_CLASS =
  'inline-flex h-11 w-full items-center justify-center rounded-md bg-primary px-4 font-medium text-primary-foreground underline-offset-4 transition-colors duration-150 hover:underline'

/** Back to the LINE chat, inside the LINE app only */
export function BackToChat() {
  const t = useTranslations('liff.link.done')
  const { inClient, mocked, closeWindow } = useLiff()
  if (!inClient || mocked) return null
  return (
    <Button variant="secondary" className="w-full" onClick={closeWindow}>
      {t('close')}
    </Button>
  )
}

/** Linked: what happens now, and the next step at the bottom of the screen — the tasks, or back to the chat */
export function LinkDone() {
  const t = useTranslations('liff.link')
  return (
    <>
      <LiffContent>
        <LiffNotice tone="success">
          <p className="font-semibold">{t('done.heading')}</p>
          <p>{t.rich('done.body', LIFF_RICH)}</p>
        </LiffNotice>
      </LiffContent>
      <LiffActionBar label={t('done.next')}>
        <LiffLink href={LIFF_HOME_PATH} className={PRIMARY_LINK_CLASS}>
          {t('done.tasks')}
        </LiffLink>
        <BackToChat />
      </LiffActionBar>
    </>
  )
}

/** What the bar of a link screen shows: the refusal, then the button inside LINE or what to do outside it */
export function LinkBar({
  refused,
  working,
  label,
  onConfirm,
  outside,
}: {
  readonly refused: { readonly key: LinkRefusalKey; readonly text: string } | null
  readonly working: boolean
  readonly label: string
  readonly onConfirm: () => void
  readonly outside: string
}) {
  const t = useTranslations('liff.link')
  const liff = useLiff()
  const final = refused !== null && FINAL.has(refused.key)
  return (
    <LiffActionBar label={t('barLabel')}>
      {refused ? (
        <LiffRefusal title={t('refusedTitle')} action={final && refused.key !== 'ALREADY_LINKED' ? <SettingsLink /> : null}>
          {refused.text}
        </LiffRefusal>
      ) : null}
      {final ? null : liff.status === 'loading' ? (
        <p role="status" className="text-ink-muted">
          {t('preparing')}
        </p>
      ) : liff.inClient ? (
        <Button className="w-full" onClick={onConfirm} disabled={working}>
          {working ? t('working') : label}
        </Button>
      ) : (
        <OutsideLine>{outside}</OutsideLine>
      )}
    </LiffActionBar>
  )
}
