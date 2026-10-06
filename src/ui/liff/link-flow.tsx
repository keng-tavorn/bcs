'use client'

import { useTranslations } from 'next-intl'
import { lazy, Suspense, useId, useState } from 'react'
import { LIFF_LINK_ENDPOINT } from './bootstrap'
import { LiffContent } from './content'
import { LiffGate } from './liff-gate'
import { useLiff } from './liff-provider'
import type { LinkedMemberProps, LinkThisLineProps } from './link-member'
import type { LinkRefusal } from './link-refusal'
import { LinkBar, LinkDone, NO_TOKEN, OutsideLine, SettingsLink, useRefusalText, type LinkState } from './link-shared'
import { LiffRefusal } from './refusal'
import { LIFF_RICH } from './rich'

// The screens of /liff/link (FR-LINE-001, §9.2, ADR-049). The page (src/app/liff/link/page.tsx) picks one:
//  - LinkWithCode: ?code= from a QR or link of /settings/line. Shows whose account the code links (the preview the
//    server read: organization and member name) and links only when the person taps the button: POST /api/liff/link
//    { code, idToken }. Never on page load and never from the URL alone (AC1).
//  - LinkSignedOut: no code and no session. The gate signs in with LINE; a LINE account that is not linked gets the
//    e-mail, password and 2FA sign-in inside LIFF (AC2), and outside the LINE app the person is told to open it there.
//  - LinkThisLine and LinkedMember, for a signed-in member (./link-member.tsx): linking this LINE after the sign-in,
//    and which LINE account the member's link is — from the page's own ID token, checked by the server with LINE —
//    with unlinking from the LINE side (AC3).
// The member screens and the e-mail sign-in are loaded on demand (React.lazy): a LIFF page's first JavaScript is at most
// 200 KB gzip with the LINE SDK (§9.4), and each screen carries only its own code. Every refusal is said in words with
// what to do (./link-refusal.ts); the code and the ID token appear nowhere but in the request body. Outside LINE every
// notice links to LINE settings on the web, where a QR code links any LINE app.

/** A refusal the server read before the page was shown (the preview of a code), with the way to a new code */
export function LinkRefused({ refusal, codeMinutes }: { readonly refusal: LinkRefusal; readonly codeMinutes: number }) {
  const t = useTranslations('liff.link')
  const words = useRefusalText(codeMinutes)(refusal)
  // A new code comes from the LINE settings of the web workspace (§9.2 step 1), except when a new code cannot help
  const newCodeHelps = words.key !== 'ALREADY_LINKED' && words.key !== 'LINE_NOT_ENABLED' && words.key !== 'FORBIDDEN'
  return (
    <LiffRefusal title={t('refusedTitle')} action={newCodeHelps ? <SettingsLink /> : null}>
      {words.text}
    </LiffRefusal>
  )
}

/** POST /api/liff/link's answer as a refusal (the body carries code, reason and time; never the code or the token) */
async function linkAnswer(response: Response): Promise<LinkRefusal | null> {
  // Read to its end whatever it says: a body nobody reads keeps the request open in the browser
  const body = (await response.json().catch(() => null)) as { code?: unknown; reason?: unknown; field?: unknown; time?: unknown } | null
  if (response.ok) return null
  const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const refusal: LinkRefusal = { code: text(body?.code) ?? 'FAILED' }
  const reason = text(body?.reason)
  const field = text(body?.field)
  const time = text(body?.time)
  return { ...refusal, ...(reason ? { reason } : {}), ...(field ? { field } : {}), ...(time ? { time } : {}) }
}

export interface LinkPreview {
  readonly organizationName: string
  readonly memberNameTh: string
  readonly memberNameEn: string | null
  /** When the code stops working, as the page shows it */
  readonly expiresAt: string
}

/** /liff/link?code=…: the preview, then the link on the person's tap */
export function LinkWithCode({ code, preview, codeMinutes }: { readonly code: string; readonly preview: LinkPreview; readonly codeMinutes: number }) {
  const t = useTranslations('liff.link')
  const id = useId()
  const liff = useLiff()
  const refusalText = useRefusalText(codeMinutes)
  const [state, setState] = useState<LinkState>({ kind: 'idle' })

  async function link() {
    setState({ kind: 'working' })
    let refusal: LinkRefusal | null
    try {
      const idToken = await liff.idToken()
      refusal = idToken
        ? await linkAnswer(
            await fetch(LIFF_LINK_ENDPOINT, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ code, idToken }),
              cache: 'no-store',
              credentials: 'same-origin',
            }),
          )
        : NO_TOKEN
    } catch {
      refusal = { code: 'EXTERNAL_SERVICE_ERROR' }
    }
    if (!refusal) liff.unlinked.forget()
    setState(refusal ? { kind: 'refused', refusal } : { kind: 'done' })
  }

  if (state.kind === 'done') return <LinkDone />
  return (
    <>
      <LiffContent>
        <p>{t.rich('intro', LIFF_RICH)}</p>
        <section aria-labelledby={`${id}-preview`} className="flex flex-col gap-3 border-t border-line pt-5">
          <h2 id={`${id}-preview`} className="text-lg font-semibold">
            {t('preview.heading')}
          </h2>
          <dl className="flex flex-col gap-3">
            <div className="flex flex-col">
              <dt className="text-ink-muted">{t('preview.organization')}</dt>
              <dd className="font-medium">{preview.organizationName}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-ink-muted">{t('preview.member')}</dt>
              <dd className="font-medium">{preview.memberNameTh}</dd>
              {preview.memberNameEn ? <dd>{preview.memberNameEn}</dd> : null}
            </div>
            <div className="flex flex-col">
              <dt className="text-ink-muted">{t('preview.expires')}</dt>
              <dd className="tabular">{preview.expiresAt}</dd>
            </div>
          </dl>
          <p className="text-ink-muted">{t('preview.caution')}</p>
        </section>
      </LiffContent>
      <LinkBar
        refused={state.kind === 'refused' ? refusalText(state.refusal) : null}
        working={state.kind === 'working'}
        label={t('preview.confirm')}
        onConfirm={() => void link()}
        outside={t('preview.outsideLine')}
      />
    </>
  )
}

/** Loaded only when a LINE account that is not linked needs to sign in */
const LiffSignIn = lazy(() => import('./liff-sign-in').then((m) => ({ default: m.LiffSignIn })))

function Preparing() {
  const t = useTranslations('liff.link')
  return (
    <p role="status" className="text-ink-muted">
      {t('preparing')}
    </p>
  )
}

/** /liff/link without a code or a session: sign in with LINE; not linked → e-mail, password and 2FA here (AC2) */
export function LinkSignedOut() {
  const t = useTranslations('liff.link')
  return (
    <LiffContent>
      <p>{t.rich('intro', LIFF_RICH)}</p>
      <LiffGate
        mode="link"
        state="signed-out"
        whenUnlinked={
          <Suspense fallback={<Preparing />}>
            <LiffSignIn />
          </Suspense>
        }
        whenOutside={<OutsideLine>{t.rich('signIn.outsideLine', LIFF_RICH)}</OutsideLine>}
      />
    </LiffContent>
  )
}

const MemberThisLine = lazy(() => import('./link-member').then((m) => ({ default: m.LinkThisLine })))
const MemberLinked = lazy(() => import('./link-member').then((m) => ({ default: m.LinkedMember })))

/** A member signed in with a password, not linked yet: link this LINE account (./link-member.tsx, loaded for a member) */
export function LinkThisLine(props: LinkThisLineProps) {
  return (
    <Suspense fallback={null}>
      <MemberThisLine {...props} />
    </Suspense>
  )
}

/** A linked member: which LINE account it is, the tasks, unlinking (./link-member.tsx, loaded for a member) */
export function LinkedMember(props: LinkedMemberProps) {
  return (
    <Suspense fallback={null}>
      <MemberLinked {...props} />
    </Suspense>
  )
}
