'use client'

import { CircleAlert, CircleCheck, CircleMinus, ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { MS_PER_SECOND } from '@/lib/constants'
import { settle } from '../admin-settings/outcome'
import { Button } from '../form/button'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { CopyButton } from './copy-button'
import { countdownText, lineLinkErrorKey, unavailableKey, type IssueLinkCodeAction, type LinkCodeView, type LinkStatusAction, type UnlinkLineAction } from './types'

// The member's own LINE link on /settings/line (FR-LINE-001 AC1 AC3, §9.2 step 1). Not linked: "ผูกบัญชี LINE" asks the
// server for a one-time code and shows it three ways — the LIFF link itself (to open on a phone that has LINE), the QR
// drawn on the server (to scan from that phone when this page is on a computer) and how long it still works, counting
// down. The code stays in this component's memory only: it never goes into this page's address, a cookie or storage —
// only into the LIFF link it is for (§9.2) — and it is gone when the page closes or the time is up. While it is shown and the page is in view, the page asks every few
// seconds whether the link was made in LINE and then shows the new status by itself. Linked: unlinking asks first (it
// cannot be undone: the member links again with a new code), then ends the link; beside it, what to do when the member
// did not make the link (unlink, then a new password through "ลืมรหัสผ่าน", which the LINE_LINKED notice points to).
// When LINE cannot be linked in the organization now (`available` false), the page says why in the words of the two
// cases it can tell apart (MyLineLinkDto `delivering`, the organization's LINE switch, which alone decides how LINE
// delivers): LINE is off — then, for a linked member, tasks and notifications go by e-mail meanwhile, and the page says
// so — or LINE is on but not set up for this system's LIFF app, when LINE still delivers to a linked member as before
// and the page says nothing about e-mail. With LIFF_MOCK (local only) the code's link and QR open the LIFF page of this
// machine (LinkCodeView `local`), and the page says so. Every button here needs the page's script, so each waits for it
// (src/ui/form/hydrated.ts): a click before it would be lost, and the unlink form posts.

/** How often the page asks whether the code was used in LINE while it is shown */
const LINK_POLL_MS = 4 * MS_PER_SECOND

/** Where a member sets a new password without knowing the old one (there is no change-password screen yet) */
const FORGOT_PASSWORD_PATH = '/forgot-password'
const LINK_CLASS = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

export interface LineLinkStatusView {
  /** LINE can be linked in the organization now: switched on, with this system's LIFF app */
  readonly available: boolean
  /** The organization's LINE is switched on, so it delivers to linked members; off, they get e-mail meanwhile */
  readonly delivering: boolean
  readonly linked: boolean
  /** When the live link was made, in the reader's language */
  readonly linkedAtText: string | null
  /** LINE still delivers to the member (false after they blocked the organization's account: e-mail is used) */
  readonly reachable: boolean
  /** The reader is an organization administrator: the unavailable notice points to the LINE settings */
  readonly canManageChannel: boolean
}

/** A message about one action: a refusal, or an answer that never came (it may or may not have been done) */
type ActionMessage = { readonly tone: 'danger' | 'warning'; readonly text: string }

export function LineLinkPanel({ status, issue, linkStatus, unlink }: { status: LineLinkStatusView; issue: IssueLinkCodeAction; linkStatus: LinkStatusAction; unlink: UnlinkLineAction }) {
  const t = useTranslations('lineLink')
  // Kept across the refresh after an unlink, so the result stays on the page that now shows the new status
  const [unlinked, setUnlinked] = useState(false)

  return (
    <div className="flex flex-col gap-8">
      {unlinked && !status.linked ? (
        <Notice tone="success">
          <p>{t('unlink.done')}</p>
          <p>{t('unlink.doneNotYou')}</p>
          <Link href={FORGOT_PASSWORD_PATH} className={LINK_CLASS}>
            {t('unlink.forgotLink')}
          </Link>
        </Notice>
      ) : null}

      <section aria-labelledby="line-status" className="flex flex-col gap-3">
        <h2 id="line-status" className="text-xl font-semibold">
          {t('statusTitle')}
        </h2>
        {status.linked ? (
          <div className="flex flex-col gap-1">
            <p className="flex items-center gap-2 font-medium">
              <CircleCheck className="size-5 shrink-0 text-primary" aria-hidden="true" />
              <span>{t('status.linked')}</span>
            </p>
            {status.linkedAtText ? <p className="text-ink-muted">{t('status.linkedSince', { time: status.linkedAtText })}</p> : null}
            {/* Whether LINE reaches the member is said while the organization's LINE delivers at all; while it is off,
                the notice below says that e-mail is used meanwhile */}
            {!status.delivering ? null : status.reachable ? <p className="text-ink-muted">{t('status.reachable')}</p> : <Notice tone="warning">{t('status.unreachable')}</Notice>}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="flex items-center gap-2 font-medium">
              <CircleMinus className="size-5 shrink-0 text-ink-muted" aria-hidden="true" />
              <span>{t('status.notLinked')}</span>
            </p>
            <p className="text-ink-muted">{t('status.notLinkedHint')}</p>
          </div>
        )}
        {!status.available ? (
          <Notice tone="info">
            <p>{t(`status.${unavailableKey(status)}`)}</p>
            {status.canManageChannel ? (
              <Link href="/admin/line" className={LINK_CLASS}>
                {t('status.adminLink')}
              </Link>
            ) : null}
          </Notice>
        ) : null}
      </section>

      {status.linked ? (
        <UnlinkSection available={status.available} unlink={unlink} onUnlinked={() => setUnlinked(true)} />
      ) : status.available ? (
        <LinkSection issue={issue} linkStatus={linkStatus} onStart={() => setUnlinked(false)} />
      ) : null}
    </div>
  )
}

// ---------- not linked: the one-time code ----------

interface ShownCode {
  readonly view: LinkCodeView
  /** performance.now() when the answer arrived: the countdown is measured from here */
  readonly receivedAt: number
}

function LinkSection({ issue, linkStatus, onStart }: { issue: IssueLinkCodeAction; linkStatus: LinkStatusAction; onStart: () => void }) {
  const t = useTranslations('lineLink')
  const router = useRouter()
  const hydrated = useHydrated()
  const [code, setCode] = useState<ShownCode | null>(null)
  const [now, setNow] = useState(0)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const remaining = code ? code.view.remainingMs - (now - code.receivedAt) : 0
  const expired = code !== null && remaining <= 0

  // The countdown: once a second while a code is shown and still works
  useEffect(() => {
    if (!code || expired) return
    const timer = setInterval(() => setNow(performance.now()), MS_PER_SECOND)
    return () => clearInterval(timer)
  }, [code, expired])

  // Linked in LINE yet? Asked while the code works and the page is in view — a page left in a background tab does not
  // keep asking (each question counts as activity of the session), and is asked at once when it comes back into view
  // (the member opened the link in LINE on this phone and returns) — and once more when the time is up, for a link
  // made in the last seconds. Once the code is used the page loads the new status.
  useEffect(() => {
    if (!code) return
    let stopped = false
    let asking = false
    const check = async () => {
      if (stopped || asking) return
      asking = true
      const answer = await settle(linkStatus())
      asking = false
      if (stopped || !answer?.ok || !answer.linked) return
      stopped = true
      // The new status replaces this section (the code is gone with it)
      router.refresh()
    }
    if (expired) {
      void check()
      return () => {
        stopped = true
      }
    }
    const inView = () => document.visibilityState === 'visible'
    const timer = setInterval(() => {
      if (inView()) void check()
    }, LINK_POLL_MS)
    const onVisibility = () => {
      if (inView()) void check()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopped = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [code, expired, linkStatus, router])

  async function start() {
    onStart()
    setFailure(null)
    setPending(true)
    const answer = await settle(issue())
    setPending(false)
    // No answer: issuing a code writes nothing, so asking again is all there is to do
    if (!answer) return setFailure(t('errors.FAILED'))
    if (!answer.ok) {
      const key = lineLinkErrorKey(answer)
      setFailure(t(`errors.${key}`, { requestId: answer.requestId ?? '-' }))
      // Linked meanwhile (in LINE, from another device or tab) or LINE not available since the page was loaded: the page
      // asks for the status as it is now, which replaces this section with the unlink or the notice
      if (key === 'ALREADY_LINKED' || key === 'LINE_NOT_ENABLED') router.refresh()
      return
    }
    const receivedAt = performance.now()
    setNow(receivedAt)
    setCode({ view: answer, receivedAt })
  }

  return (
    <section aria-labelledby="line-link" className="flex flex-col gap-4 border-t border-line pt-6">
      <h2 id="line-link" className="text-xl font-semibold">
        {t('link.title')}
      </h2>
      <p className="text-ink-muted">{t('link.intro')}</p>
      {failure ? <Notice tone="danger">{failure}</Notice> : null}

      {code === null || expired ? (
        <div className="flex flex-col gap-3">
          {expired ? <Notice tone="warning">{t('link.expired')}</Notice> : null}
          <Button onClick={start} disabled={pending || !hydrated} className="self-start">
            {pending ? t('link.starting') : expired ? t('link.renew') : t('link.start')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {/* Real steps, in the order the member takes them: the numbers are the list's own */}
          <ol className="flex list-decimal flex-col gap-5 pl-6 marker:font-medium">
            <li>
              <div className="flex flex-col gap-4">
                <p className="font-medium">{t('link.howTo')}</p>
                {/* Two ways to open the code in LINE. A phone cannot scan its own screen, so on narrow screens the link
                    comes first; from md the QR does, for the phone beside the computer. The page's order — the one
                    screen readers and the keyboard follow — keeps the link first: the QR has nothing to focus. */}
                <ul className="flex flex-col gap-5">
                  <li className="flex flex-col gap-3">
                    <p>{t('link.open')}</p>
                    <p className="text-base break-all text-ink-muted md:text-sm">{code.view.url}</p>
                    {/* LIFF_MOCK (this machine only): the link opens the LIFF page here, where one goes on as a mock LINE user */}
                    {code.view.local ? <Notice tone="info">{t('link.local')}</Notice> : null}
                    <div className="flex flex-wrap items-start gap-3">
                      <a
                        href={code.view.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 font-medium text-primary-foreground underline-offset-4 transition-colors duration-150 hover:underline"
                      >
                        <ExternalLink className="size-4" aria-hidden="true" />
                        {t('link.openInLine')}
                      </a>
                      <CopyButton value={code.view.url} label={t('link.copy')} copiedLabel={t('link.copied')} failedLabel={t('link.copyFailed')} />
                    </div>
                  </li>
                  <li className="flex flex-col gap-3 md:order-first">
                    <p>{t('link.scan')}</p>
                    <svg
                      role="img"
                      aria-label={t('link.qrLabel')}
                      width={208}
                      height={208}
                      viewBox={`0 0 ${code.view.qr.size} ${code.view.qr.size}`}
                      shapeRendering="crispEdges"
                      className="border border-line bg-bg"
                    >
                      <rect width={code.view.qr.size} height={code.view.qr.size} fill="var(--bg)" />
                      <path d={code.view.qr.path} fill="var(--ink)" />
                    </svg>
                  </li>
                </ul>
              </div>
            </li>
            <li>
              <p className="font-medium">{t('link.confirm')}</p>
            </li>
          </ol>
          <p className="tabular font-medium">{t('link.expiresIn', { time: countdownText(remaining), at: code.view.expiresAtText })}</p>
          <Notice tone="warning">{t('link.keepPrivate')}</Notice>
          <p className="text-ink-muted">{t('link.waiting')}</p>
        </div>
      )}
    </section>
  )
}

// ---------- linked: ending the link ----------

function UnlinkSection({ available, unlink, onUnlinked }: { available: boolean; unlink: UnlinkLineAction; onUnlinked: () => void }) {
  const t = useTranslations('lineLink')
  const router = useRouter()
  const id = useId()
  const hydrated = useHydrated()
  const submission = useSubmissionKey()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [message, setMessage] = useState<ActionMessage | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (new FormData(event.currentTarget).get('confirm') !== 'yes') return setConfirmError(t('errors.CONFIRM'))
    setConfirmError(null)
    setMessage(null)
    setPending(true)
    const outcome = await settle(unlink(submission.key))
    setPending(false)
    // No answer: it may or may not be unlinked, and the page says so; the same key goes with a retry, so it runs at most once
    if (!outcome) return setMessage({ tone: 'warning', text: t('errors.NO_ANSWER') })
    submission.next()
    // NOT_LINKED: it was ended meanwhile (in LINE, or by another tab) — the page shows the same result
    if (outcome.ok || (outcome.code === 'INVALID_STATE_TRANSITION' && outcome.reason === 'NOT_LINKED')) {
      onUnlinked()
      // An unlink revalidates the page with its answer; a refusal does not, so the page asks for the new status itself
      if (!outcome.ok) router.refresh()
      return
    }
    setMessage({ tone: 'danger', text: t(`errors.${lineLinkErrorKey(outcome)}`, { requestId: outcome.requestId ?? '-' }) })
  }

  return (
    <section aria-labelledby="line-unlink" className="flex flex-col gap-4 border-t border-line pt-6">
      <h2 id="line-unlink" className="text-xl font-semibold">
        {t('unlink.title')}
      </h2>
      {/* While LINE cannot be linked, an unlink cannot be undone until it can again: the intro says so */}
      <p className="text-ink-muted">{available ? t('unlink.intro') : t('unlink.introUnavailable')}</p>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {!open ? (
        <Button variant="danger" onClick={() => setOpen(true)} disabled={!hydrated} className="self-start">
          {t('unlink.button')}
        </Button>
      ) : (
        // method="post": like every form here, a submission before hydration never builds an address from its fields
        <form method="post" onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
          <div className="flex flex-col gap-1.5">
            <label className="flex min-h-11 items-start gap-3">
              <input
                type="checkbox"
                name="confirm"
                value="yes"
                aria-invalid={confirmError ? true : undefined}
                aria-describedby={confirmError ? `${id}-error` : undefined}
                onChange={(event) => event.currentTarget.checked && setConfirmError(null)}
                className="mt-1 size-5 shrink-0"
              />
              <span>{t('unlink.confirm')}</span>
            </label>
            {confirmError ? (
              <p id={`${id}-error`} className="flex items-start gap-1.5 text-base text-danger md:text-sm">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{confirmError}</span>
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-3">
            <Button type="submit" variant="danger" disabled={pending || !hydrated}>
              {pending ? t('unlink.submitting') : t('unlink.submit')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setOpen(false)
                setConfirmError(null)
              }}
            >
              {t('unlink.keep')}
            </Button>
          </div>
        </form>
      )}
      {/* A link the member did not make (the LINE_LINKED e-mail opens this page): unlink first, then a new password, which
          ends every session — the link itself outlives a password reset */}
      <div className="flex flex-col gap-1">
        <p className="text-ink-muted">{t('unlink.notYou')}</p>
        <Link href={FORGOT_PASSWORD_PATH} className={LINK_CLASS}>
          {t('unlink.forgotLink')}
        </Link>
      </div>
    </section>
  )
}
