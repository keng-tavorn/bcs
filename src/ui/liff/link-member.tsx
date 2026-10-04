'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { Button } from '../form/button'
import type { ActionOutcome } from '../tasks/outcome'
import { LiffActionBar } from './action-bar'
import { LIFF_HELP_PATH, LIFF_HOME_PATH } from './bootstrap'
import { LiffContent } from './content'
import { LiffLink } from './liff-link'
import { useLiff } from './liff-provider'
import type { LinkRefusal, ThisLineOutcome } from './link-refusal'
import { BackToChat, LinkBar, LinkDone, NO_TOKEN, OutsideLine, SettingsLink, useRefusalText, type LinkState } from './link-shared'
import { LiffNotice } from './notice'
import { LiffRefusal } from './refusal'
import { LIFF_RICH } from './rich'
import { useLiffSubmissionKey } from './submission-key'

// The screens of /liff/link for a signed-in member (FR-LINE-001 AC2 AC3), loaded only for one (./link-flow.tsx loads
// this module on demand, so a LINE account that is not linked, or a link code, never carries it):
//  - LinkThisLine: a member signed in with a password who is not linked: confirm, then the server issues a code for the
//    member and spends it with the page's ID token (linkThisLineAccount) — the same path as a QR code (AC2).
//  - LinkedMember: the member is linked. Which LINE account that is comes from the page's own ID token, checked by the
//    server with LINE — never from the member's link alone. "This LINE": the way to the tasks, and unlinking with a
//    second confirmation (AC3: "ยกเลิกผูกได้ทั้งสองฝั่ง"). "Another LINE": says so; after a password sign-in it offers to
//    end that link (a second confirmation) and then to link this LINE (a new phone); a LINE sign-in alone is sent to the
//    web settings, as it does not stand for that other LINE account. Outside the LINE app: the web settings.

/** Who the page is about: the member's name and organization */
function MemberLine({ memberName, organizationName }: { readonly memberName: string; readonly organizationName: string }) {
  return (
    <p>
      <span className="font-medium">{memberName}</span>
      <span className="text-ink-muted"> · {organizationName}</span>
    </p>
  )
}

export interface LinkThisLineProps {
  readonly memberName: string
  readonly organizationName: string
  readonly codeMinutes: number
  readonly link: (input: { idToken: string }) => Promise<ActionOutcome>
  /** Shown above (the other LINE account was just unlinked, or a link code is no longer needed) */
  readonly notice?: ReactNode
}

/** Signed in with a password, not linked yet: confirm, and the server links the member to this LINE account (AC2) */
export function LinkThisLine({ memberName, organizationName, codeMinutes, link, notice = null }: LinkThisLineProps) {
  const t = useTranslations('liff.link')
  const id = useId()
  const liff = useLiff()
  const refusalText = useRefusalText(codeMinutes)
  const [state, setState] = useState<LinkState>({ kind: 'idle' })

  async function confirm() {
    setState({ kind: 'working' })
    let outcome: ActionOutcome
    try {
      const idToken = await liff.idToken()
      outcome = idToken ? await link({ idToken }) : { ok: false, ...NO_TOKEN }
    } catch {
      outcome = { ok: false, code: 'FAILED' }
    }
    if (outcome.ok) liff.unlinked.forget()
    setState(outcome.ok ? { kind: 'done' } : { kind: 'refused', refusal: outcome })
  }

  if (state.kind === 'done') return <LinkDone />
  return (
    <>
      <LiffContent>
        {notice}
        <section aria-labelledby={`${id}-member`} className="flex flex-col gap-3">
          <h2 id={`${id}-member`} className="text-lg leading-snug font-semibold">
            {t('member.heading')}
          </h2>
          <dl className="flex flex-col gap-3">
            <div className="flex flex-col">
              <dt className="text-ink-muted">{t('preview.organization')}</dt>
              <dd className="font-medium">{organizationName}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-ink-muted">{t('preview.member')}</dt>
              <dd className="font-medium">{memberName}</dd>
            </div>
          </dl>
          <p className="text-ink-muted">{t('member.caution')}</p>
        </section>
      </LiffContent>
      <LinkBar
        refused={state.kind === 'refused' ? refusalText(state.refusal) : null}
        working={state.kind === 'working'}
        label={t('member.confirm')}
        onConfirm={() => void confirm()}
        outside={t('member.outsideLine')}
      />
    </>
  )
}

type Unlink = (input: { idToken: string; which: 'this' | 'other' }, idempotencyKey: string) => Promise<ActionOutcome>

/** Ending the link the page showed, after a second confirmation; `onDone` once it ended */
function UnlinkControl({
  which,
  memberName,
  codeMinutes,
  unlink,
  onDone,
}: {
  readonly which: 'this' | 'other'
  readonly memberName: string
  readonly codeMinutes: number
  readonly unlink: Unlink
  readonly onDone: () => void
}) {
  const tLinked = useTranslations('liff.link.linked')
  const tOther = useTranslations('liff.link.other')
  const words =
    which === 'this'
      ? { unlink: tLinked('unlink'), confirm: tLinked('unlinkConfirm', { name: memberName }), confirmButton: tLinked('unlinkConfirmButton') }
      : { unlink: tOther('unlink'), confirm: tOther('unlinkConfirm', { name: memberName }), confirmButton: tOther('unlinkConfirmButton') }
  const id = useId()
  const liff = useLiff()
  const submission = useLiffSubmissionKey()
  const refusalText = useRefusalText(codeMinutes)
  const [confirming, setConfirming] = useState(false)
  const [working, setWorking] = useState(false)
  const [refusal, setRefusal] = useState<LinkRefusal | null>(null)

  async function confirmUnlink() {
    setWorking(true)
    let outcome: ActionOutcome
    try {
      const session = await liff.ensureSession()
      if (!session.ok && session.final) {
        // The LIFF session cannot be kept on this page load: a new one for a fresh ID token, or say so (nothing sent)
        if (session.reason === 'TOKEN_INVALID' && liff.reloadForNewToken()) return
        outcome = { ok: false, code: 'UNAUTHENTICATED' }
      } else {
        const idToken = await liff.idToken()
        outcome = idToken ? await unlink({ idToken, which }, submission.key) : { ok: false, ...NO_TOKEN }
        submission.next()
      }
    } catch {
      outcome = { ok: false, code: 'FAILED' }
    }
    setWorking(false)
    setConfirming(false)
    if (outcome.ok) onDone()
    else setRefusal(outcome)
  }

  return (
    <>
      {refusal ? <LiffRefusal title={tLinked('unlinkRefusedTitle')}>{refusalText(refusal).text}</LiffRefusal> : null}
      {confirming ? (
        <div role="group" aria-labelledby={`${id}-confirm`} className="flex flex-col gap-3">
          <p id={`${id}-confirm`} className="font-medium">
            {words.confirm}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button variant="danger" onClick={() => void confirmUnlink()} disabled={working}>
              {working ? tLinked('unlinking') : words.confirmButton}
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(false)} disabled={working}>
              {tLinked('keep')}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="danger" className="self-start" onClick={() => setConfirming(true)}>
          {words.unlink}
        </Button>
      )}
    </>
  )
}

type Check = { readonly kind: 'checking' } | { readonly kind: 'this' | 'other' | 'none' } | { readonly kind: 'refused'; readonly refusal: LinkRefusal }

export interface LinkedMemberProps {
  readonly memberName: string
  readonly organizationName: string
  /** When the link was made, as the page shows it */
  readonly since: string
  /** How the member signed in on this page: with LINE (liff) or with a password (web) */
  readonly session: 'liff' | 'web'
  readonly codeMinutes: number
  /** Shown above everything (a link code the member opened that is no longer needed) */
  readonly notice?: string | null
  readonly check: (input: { idToken: string }) => Promise<ThisLineOutcome>
  readonly unlink: Unlink
  readonly link: (input: { idToken: string }) => Promise<ActionOutcome>
}

/** A linked member: is it this LINE account, another one, or (outside LINE) cannot be told — and what can be done */
export function LinkedMember({ memberName, organizationName, since, session, codeMinutes, notice = null, check, unlink, link }: LinkedMemberProps) {
  const t = useTranslations('liff.link')
  const id = useId()
  const { status, inClient, mocked, idToken, unlinked } = useLiff()
  const refusalText = useRefusalText(codeMinutes)
  const [result, setResult] = useState<Check>({ kind: 'checking' })
  const [round, setRound] = useState(0)
  const [ended, setEnded] = useState<'this' | 'other' | null>(null)
  const outside = status !== 'loading' && !inClient

  // Which LINE account this page is open in: the server asks LINE about the page's ID token (once per page load)
  useEffect(() => {
    if (status === 'loading' || !inClient) return
    let cancelled = false
    void (async () => {
      let outcome: ThisLineOutcome
      try {
        const token = await idToken()
        outcome = token ? await check({ idToken: token }) : { ok: false, ...NO_TOKEN }
      } catch {
        outcome = { ok: false, code: 'EXTERNAL_SERVICE_ERROR' }
      }
      if (!cancelled) setResult(outcome.ok ? { kind: outcome.link } : { kind: 'refused', refusal: outcome })
    })()
    return () => {
      cancelled = true
    }
  }, [status, inClient, idToken, check, round])

  const top = notice ? <LiffNotice tone="info">{notice}</LiffNotice> : null

  if (ended === 'this') {
    return (
      <>
        <LiffContent>
          <LiffNotice tone="success">{t.rich('linked.unlinked', LIFF_RICH)}</LiffNotice>
          <LiffLink href={LIFF_HELP_PATH}>{t('linked.help')}</LiffLink>
        </LiffContent>
        {/* Back to the chat, in the LINE app only (BackToChat shows nothing elsewhere: no empty bar) */}
        {inClient && !mocked ? (
          <LiffActionBar label={t('done.next')}>
            <BackToChat />
          </LiffActionBar>
        ) : null}
      </>
    )
  }
  // Not linked (any more): this LINE account can be linked now
  if (ended === 'other' || (result.kind === 'none' && !outside)) {
    return (
      <LinkThisLine
        memberName={memberName}
        organizationName={organizationName}
        codeMinutes={codeMinutes}
        link={link}
        notice={ended === 'other' ? <LiffNotice tone="success">{t('other.unlinked')}</LiffNotice> : top}
      />
    )
  }

  const known = outside || result.kind === 'this' || result.kind === 'other'
  const heading = outside ? t('outsideLinked.heading') : result.kind === 'other' ? t('other.heading') : result.kind === 'this' ? t('linked.heading') : t('title')
  return (
    <LiffContent>
      {top}
      <section aria-labelledby={`${id}-linked`} className="flex flex-col gap-3">
        <h2 id={`${id}-linked`} className="text-lg leading-snug font-semibold">
          {heading}
        </h2>
        {known ? (
          <>
            <MemberLine memberName={memberName} organizationName={organizationName} />
            <p className="text-ink-muted">{t('linked.since', { time: since })}</p>
          </>
        ) : null}
        {result.kind === 'checking' && !outside ? (
          <p role="status" className="text-ink-muted">
            {t('checking')}
          </p>
        ) : null}
        {result.kind === 'refused' && !outside ? (
          <LiffRefusal
            title={t('checkRefusedTitle')}
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setResult({ kind: 'checking' })
                  setRound((n) => n + 1)
                }}
              >
                {t('retry')}
              </Button>
            }
          >
            {refusalText(result.refusal).text}
          </LiffRefusal>
        ) : null}
        {result.kind === 'this' && !outside ? <LiffLink href={LIFF_HOME_PATH}>{t('linked.tasks')}</LiffLink> : null}
        {result.kind === 'other' && !outside ? <p>{t('other.body')}</p> : null}
      </section>

      {outside ? <OutsideLine>{t('outsideLinked.body')}</OutsideLine> : null}

      {result.kind === 'this' && !outside ? (
        <section aria-labelledby={`${id}-unlink`} className="flex flex-col gap-3 border-t border-line pt-5">
          <h2 id={`${id}-unlink`} className="text-lg leading-snug font-semibold">
            {t('linked.unlinkHeading')}
          </h2>
          <p className="text-ink-muted">{t.rich('linked.unlinkBody', LIFF_RICH)}</p>
          <UnlinkControl
            which="this"
            memberName={memberName}
            codeMinutes={codeMinutes}
            unlink={unlink}
            onDone={() => {
              unlinked.remember()
              setEnded('this')
            }}
          />
        </section>
      ) : null}

      {result.kind === 'other' && !outside ? (
        <section aria-labelledby={`${id}-switch`} className="flex flex-col gap-3 border-t border-line pt-5">
          <h2 id={`${id}-switch`} className="text-lg leading-snug font-semibold">
            {t('other.switchHeading')}
          </h2>
          {session === 'web' ? (
            <>
              <p className="text-ink-muted">{t('other.switchBody')}</p>
              <UnlinkControl which="other" memberName={memberName} codeMinutes={codeMinutes} unlink={unlink} onDone={() => setEnded('other')} />
            </>
          ) : (
            <>
              <p className="text-ink-muted">{t('other.passwordNeeded')}</p>
              <SettingsLink />
            </>
          )}
        </section>
      ) : null}
    </LiffContent>
  )
}
