'use client'

import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { useCallback, useEffect, useRef, useState } from 'react'
import { discardRight, editRight, isExpired, signOutPlan, type SignOutWarning } from '@/core/offline-queue'
import { GO_RECEIVE_DRAIN_EVERY_MS, MS_PER_DAY } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { authClient } from '../auth/client'
import { SignOutFailure, signOutWith, type SignOutResult } from '../auth/sign-out-button'
import { inBcsGoApp, scanQrCode, storedPushDevice, storePushDevice } from '../bcs-go/native'
import { StatusBadge } from '../document/badges'
import type { BadgeLook } from '../document/badge-looks'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../shadcn/alert-dialog'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../shadcn/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../shadcn/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../shadcn/item'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../shadcn/sheet'
import { ReceiptForm } from './receipt-form'
import { findScanned, findTyped, type Found } from './scan'
import { drainQueue, resumeAfterRestart, resumeAfterSignIn, sendUnknownNow, type DrainContext } from './runner'
import { keepShellOffline } from './shell-cache'
import { askToKeep, deletePhoto, forgetMember, forgetOthers, readPrepared, readQueue, updateQueue, writePrepared, type PoCopy, type Prepared, type ReceiptPayload, type StoredItem, type StoredPhoto } from './store'

// /go/receive (S17-13, FR-PLT-301 AC5 AC7 AC8 AC9, BR-APP-03 to BR-APP-10, BR-APP-13, BR-APP-14, §9.7): receiving on
// site without a signal. With a signal the page prepares the POs the receiver may receive (copies without prices, kept
// on the phone) and learns who is signed in; a receipt is then recorded on a copy with the fields of /liff/gr/[poId]
// and kept in the queue with its own key. The queue sends itself whenever there is a signal (./runner.ts), oldest
// first and never twice, and the page shows what waits, what needs the receiver and what may already be recorded.
// Signing out warns by kind and deletes the receiver's queue and copies once confirmed; receipts another member left
// on the phone are kept apart, never sent, shown as a count. The page's HTML carries no business data — the service
// worker keeps its shell (./shell-cache.ts) — and everything comes from the phone's storage and /api/go/*.
// A PO is found by scanning the QR printed on it in the app, or by typing its number (./scan.ts, S17-14): the copy on
// the phone opens its form, and with a signal a PO not on the phone yet is asked of the server by the QR's hash.

type Session = { readonly member: string | null; readonly known: boolean }
type Tone = 'success' | 'warning' | 'danger' | 'info'

const STATUS_LOOKS: Readonly<Record<string, BadgeLook>> = {
  QUEUED: { tone: 'neutral', icon: 'Clock' },
  UPLOADING: { tone: 'info', icon: 'Send' },
  SENDING: { tone: 'info', icon: 'Send' },
  RETRY: { tone: 'warn', icon: 'Hourglass' },
  WAIT_LOGIN: { tone: 'warn', icon: 'Lock' },
  CHECK_SERVER: { tone: 'info', icon: 'MessageCircleQuestion' },
  NEEDS_ATTENTION: { tone: 'danger', icon: 'CircleX' },
  EXPIRED: { tone: 'neutral', icon: 'Ban' },
}
const ONLINE: BadgeLook = { tone: 'ok', icon: 'CircleCheck' }
const OFFLINE: BadgeLook = { tone: 'warn', icon: 'Ban' }

/** The reasons a refused receipt is told by; any other code reads as OTHER */
const REASONS = ['CONFLICT_VERSION', 'INVALID_STATE_TRANSITION', 'FORBIDDEN', 'SOD_VIOLATION', 'BUDGET_INSUFFICIENT', 'VALIDATION_FAILED', 'NOT_FOUND', 'TYPE_NOT_ALLOWED', 'TOO_LARGE', 'PHOTO_MISSING'] as const
type Reason = (typeof REASONS)[number] | 'NOT_RECORDED' | 'OTHER'
const isReason = (code: string): code is (typeof REASONS)[number] => (REASONS as readonly string[]).includes(code)
const reasonOf = (item: StoredItem): Reason => (item.reason === 'NOT_RECORDED' ? 'NOT_RECORDED' : item.code && isReason(item.code) ? item.code : 'OTHER')

const onlineNow = () => (typeof navigator === 'undefined' ? true : navigator.onLine)
const neverSent = (i: StoredItem) => i.attempts === 0 && i.status !== 'SENDING' && i.status !== 'CHECK_SERVER' && i.status !== 'NEEDS_ATTENTION'
const countOf = (warn: Readonly<Record<string, SignOutWarning>>, kind: SignOutWarning) => Object.values(warn).filter((w) => w === kind).length

export function GoReceiveApp() {
  const t = useTranslations('goReceive')
  const format = useFormatter()
  const router = useRouter()
  const [ready, setReady] = useState(false)
  const [online, setOnline] = useState(true)
  const [session, setSessionState] = useState<Session>({ member: null, known: false })
  // The queue reads who is signed in when it sends, never a value from an earlier render
  const sessionRef = useRef<Session>(session)
  const setSession = useCallback((next: Session) => {
    sessionRef.current = next
    setSessionState(next)
  }, [])
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [queue, setQueue] = useState<readonly StoredItem[]>([])
  const [moduleOff, setModuleOff] = useState(false)
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null)
  const [keepRefused, setKeepRefused] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [editing, setEditing] = useState<{ copy: PoCopy; item: StoredItem | null } | null>(null)
  const [discarding, setDiscarding] = useState<StoredItem | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const [deletingHeld, setDeletingHeld] = useState(false)
  const [signOutFailed, setSignOutFailed] = useState<Exclude<SignOutResult, 'done'> | null>(null)
  const [found, setFound] = useState<Found | null>(null)
  const [typed, setTyped] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scanProblem, setScanProblem] = useState<string | null>(null)

  const retentionDays = prepared?.retentionDays ?? 7
  const reload = useCallback(async () => {
    setPrepared(await readPrepared())
    setQueue(await readQueue())
  }, [])

  // Who the queue sends for: the member the server named last, else (no signal yet) the one the copies were prepared for
  const context = useCallback(async (): Promise<DrainContext> => {
    const p = await readPrepared()
    const now = sessionRef.current
    return { session: now.known ? now.member : (p?.memberId ?? null), retentionDays: p?.retentionDays ?? 7, online: onlineNow, now: () => new Date() }
  }, [])

  const drain = useCallback(async () => {
    const drained = await drainQueue(await context())
    if (drained.signedOut) setSession({ member: null, known: true })
    await reload()
  }, [context, reload, setSession])

  /** Copies of the POs the member may receive now, and who is signed in (BR-APP-04) */
  const prepare = useCallback(
    async (asked: boolean) => {
      if (!onlineNow()) return
      if (asked) setPreparing(true)
      try {
        const res = await fetch('/api/go/receiving/prepare', { credentials: 'same-origin', cache: 'no-store' })
        if (res.status === 401) return setSession({ member: null, known: true })
        const body = (await res.json().catch(() => null)) as (Omit<Prepared, 'preparedAt'> & { error?: { code?: string } }) | null
        if (res.status === 403 && body?.error?.code === 'MODULE_DISABLED') return setModuleOff(true)
        if (!res.ok || !body?.memberId) {
          if (asked) setNotice({ tone: 'danger', text: t('prepare.failed') })
          return
        }
        const at = new Date().toISOString()
        const next: Prepared = { memberId: body.memberId, copies: body.copies, truncated: body.truncated, retentionDays: body.retentionDays, preparedAt: at }
        setModuleOff(false)
        setSession({ member: body.memberId, known: true })
        if (!(await writePrepared(next))) return setNotice({ tone: 'danger', text: t('form.notKept') })
        // A refused receipt of a PO prepared again may now be corrected (BR-APP-05: CONFLICT_VERSION)
        const fresh = new Set(next.copies.map((c) => c.poId))
        await updateQueue((items) => items.map((i) => (i.status === 'NEEDS_ATTENTION' && fresh.has(i.poId) ? { ...i, copyPreparedAt: at } : i)))
        await resumeAfterSignIn(body.memberId, new Date())
        // BR-APP-03: the browser is asked to keep the storage once there is something to keep
        if (asked || next.copies.length) setKeepRefused(!(await askToKeep()))
        if (asked) setNotice({ tone: 'success', text: t('prepare.done', { count: next.copies.length }) })
      } catch {
        if (asked) setNotice({ tone: 'danger', text: t('prepare.failed') })
      } finally {
        if (asked) setPreparing(false)
        await reload()
      }
    },
    [reload, setSession, t],
  )

  useEffect(() => {
    let alive = true
    void (async () => {
      setOnline(onlineNow())
      await resumeAfterRestart(new Date())
      await reload()
      if (!alive) return
      setReady(true)
      if (onlineNow()) {
        keepShellOffline()
        await prepare(false)
      }
      await drain()
    })()
    const up = () => {
      setOnline(true)
      void prepare(false).then(drain)
    }
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      alive = false
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [drain, prepare, reload])

  // The queue sends itself when the page opens and when the signal comes back (above), then every few seconds
  useEffect(() => {
    if (!ready) return
    const timer = window.setInterval(() => void drain(), GO_RECEIVE_DRAIN_EVERY_MS)
    return () => window.clearInterval(timer)
  }, [drain, ready])

  async function save(copy: PoCopy, item: StoredItem | null, payload: ReceiptPayload, photos: readonly StoredPhoto[]): Promise<boolean> {
    const member = session.member ?? prepared?.memberId ?? null
    if (!member) return false
    const inPlace = item !== null && editRight(item) === 'EDIT_IN_PLACE'
    // Never sent: corrected where it is, with its key · refused: a new item with a new key (BR-APP-05)
    const saved: StoredItem = {
      key: inPlace ? item.key : newId(),
      poId: copy.poId,
      by: member,
      capturedAt: item?.capturedAt ?? new Date().toISOString(),
      status: 'QUEUED',
      attempts: 0,
      photos,
      payload,
      poNumber: copy.number,
      supplier: copy.supplier,
      capturedOnVersion: copy.version,
    }
    const out = { gone: false }
    const kept = await updateQueue((items) => {
      const current = item ? items.find((i) => i.key === item.key) : undefined
      // Sent while the receiver was correcting it (BR-APP-05: what went may no longer be changed)
      if (item && (!current || editRight(current) !== editRight(item))) {
        out.gone = true
        return items
      }
      // A photo kept keeps how far its upload got meanwhile
      const merged = { ...saved, photos: photos.map((p) => current?.photos.find((x) => x.localId === p.localId) ?? p) }
      return [...items.filter((i) => i.key !== item?.key), merged]
    })
    if (out.gone) {
      for (const p of photos) if (!item?.photos.some((x) => x.localId === p.localId)) await deletePhoto(p.localId)
      setEditing(null)
      setNotice({ tone: 'warning', text: t('form.goneMeanwhile') })
      await reload()
      return true
    }
    if (!kept) return false
    // The photos the receiver took out of a corrected receipt go from the phone
    for (const p of item?.photos ?? []) if (!photos.some((x) => x.localId === p.localId)) await deletePhoto(p.localId)
    setEditing(null)
    setNotice({ tone: 'success', text: onlineNow() ? t('form.savedOnline') : t('form.saved') })
    await reload()
    void drain()
    return true
  }

  async function scan() {
    setScanProblem(null)
    setScanning(true)
    try {
      const scanned = await scanQrCode()
      if (!scanned.ok) {
        if (scanned.reason === 'UNAVAILABLE') setScanProblem(t('find.scanUnavailable'))
        return
      }
      const p = await readPrepared()
      const result = await findScanned(scanned.value, { origin: window.location.origin, copies: p && p.memberId === sessionRef.current.member ? p.copies : [], online: onlineNow(), fetch: window.fetch.bind(window) })
      if (result.kind === 'SIGNED_OUT') setSession({ member: null, known: true })
      if (result.kind === 'MODULE_OFF') setModuleOff(true)
      setFound(result)
    } finally {
      setScanning(false)
    }
  }

  function findNumber() {
    const copy = findTyped(typed, copies)
    setFound(copy ? { kind: 'COPY', copy, from: 'PHONE' } : { kind: 'NOT_FOUND' })
  }

  /** Opens the receipt form of the PO found; a copy the server gave is kept with the others (BR-APP-04) */
  async function openFound(copy: PoCopy, from: 'PHONE' | 'SERVER') {
    setFound(null)
    const member = session.member ?? prepared?.memberId ?? null
    if (!member) return
    if (from === 'SERVER') {
      const p = await readPrepared()
      const kept: Prepared =
        p && p.memberId === member
          ? { ...p, copies: [copy, ...p.copies.filter((c) => c.poId !== copy.poId)] }
          : { memberId: member, copies: [copy], truncated: false, retentionDays, preparedAt: copy.preparedAt }
      await writePrepared(kept)
      await reload()
    }
    setEditing({ copy, item: null })
  }

  async function discard(item: StoredItem) {
    const out = { gone: false }
    // Only while it may still be thrown away: never sent, refused or expired (BR-APP-05)
    await updateQueue((items) =>
      items.filter((i) => {
        const drop = i.key === item.key && discardRight(i) === 'ALLOWED'
        out.gone ||= drop
        return !drop
      }),
    )
    if (out.gone) for (const p of item.photos) await deletePhoto(p.localId)
    setDiscarding(null)
    await reload()
  }

  async function askSignOut() {
    // BR-APP-09: online, what may be recorded goes first with its keys, then the receiver is warned by kind
    if (onlineNow()) await sendUnknownNow(await context())
    await reload()
    setSigningOut(true)
  }

  async function signOut() {
    // BR-APP-09: the receiver confirmed; their queue and copies go from the phone whether or not the server answers
    const member = session.member ?? prepared?.memberId ?? null
    if (member) await forgetMember(member)
    setSigningOut(false)
    setSignOutFailed(null)
    await reload()
    // BR-AUTH-12 LOGOUT: in the app, this phone's push device ends first, as the workspace's sign-out does
    const device = storedPushDevice()
    if (device) {
      await fetch('/api/go/push/end', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: device }) }).catch(() => null)
      storePushDevice(null)
    }
    const result = await signOutWith(() => authClient.signOut())
    if (result !== 'done') return setSignOutFailed(result)
    router.replace('/login')
    router.refresh()
  }

  async function deleteHeld() {
    const member = session.member ?? prepared?.memberId
    if (member) await forgetOthers(member)
    setDeletingHeld(false)
    await reload()
  }

  if (!ready) return null

  const me = session.known ? session.member : (prepared?.memberId ?? null)
  const now = new Date().toISOString()
  // Nobody signed in: the receipts on the phone wait for their owner and show as a count only (BR-APP-09)
  const mine = me ? queue.filter((i) => i.by === me) : []
  const held = me ? queue.filter((i) => i.by !== me) : []
  const waitingForOwner = me ? 0 : queue.length
  const expired = (i: StoredItem) => i.status === 'EXPIRED' || isExpired(i, now, retentionDays)
  const counts = {
    waiting: mine.filter((i) => !expired(i) && neverSent(i)).length,
    attention: mine.filter((i) => !expired(i) && i.status === 'NEEDS_ATTENTION').length,
    unknown: mine.filter((i) => !neverSent(i) && i.status !== 'NEEDS_ATTENTION').length,
  }
  const ownCopies = prepared !== null && prepared.memberId === me
  const copies = ownCopies ? prepared.copies : []
  const copyOld = (copy: PoCopy) => Date.parse(now) - Date.parse(copy.preparedAt) > retentionDays * MS_PER_DAY

  const inApp = inBcsGoApp()
  const foundText = (f: Found): string => {
    switch (f.kind) {
      case 'COPY':
        return copyOld(f.copy) ? t('prepare.old', { days: retentionDays }) : `${f.copy.supplier}${f.copy.site ? ` · ${f.copy.site}` : ''} · ${t('prepare.lines', { count: f.copy.lines.length })}`
      case 'NOT_BCS':
        return t('find.notBcs')
      case 'NOT_FOUND':
        return t('find.notFound')
      case 'NOT_ON_PHONE':
        return t('find.notOnPhone')
      case 'SIGNED_OUT':
        return t('signIn')
      case 'MODULE_OFF':
        return t('moduleOff')
    }
  }

  if (editing) {
    return (
      <ReceiptForm
        copy={editing.copy}
        before={editing.item ? { payload: editing.item.payload, photos: editing.item.photos } : null}
        onCancel={() => setEditing(null)}
        onSave={(payload, photos) => save(editing.copy, editing.item, payload, photos)}
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <StatusBadge look={online ? ONLINE : OFFLINE} label={online ? t('online') : t('offline')} className="text-base md:text-sm" />
        <dl className="grid grid-cols-3 gap-2">
          <Count label={t('queue.waiting')} value={counts.waiting} />
          <Count label={t('queue.attention')} value={counts.attention} />
          <Count label={t('queue.unknown')} value={counts.unknown} />
        </dl>
      </div>

      {session.known && !session.member ? (
        <Notice tone="warning">
          {t('signIn')}
          {waitingForOwner ? ` ${t('queue.waitingSignIn', { count: waitingForOwner })}` : ''}{' '}
          <a className="font-medium text-primary underline underline-offset-4 hover:no-underline" href="/login">
            {t('signInLink')}
          </a>
        </Notice>
      ) : null}
      {moduleOff ? <Notice tone="warning">{t('moduleOff')}</Notice> : null}
      {keepRefused ? <Notice tone="warning">{t('prepare.keepRefused')}</Notice> : null}
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}

      {me ? (
        <section aria-labelledby="go-find" className="flex flex-col gap-3">
          <h2 id="go-find" className="text-lg font-semibold text-ink">
            {t('find.title')}
          </h2>
          {inApp ? (
            <Button className="self-start" onClick={() => void scan()} disabled={scanning || moduleOff}>
              {scanning ? t('find.scanning') : t('find.scan')}
            </Button>
          ) : null}
          {scanProblem ? <Notice tone="warning">{scanProblem}</Notice> : null}
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              findNumber()
            }}
          >
            <div className="min-w-0 flex-1 basis-56">
              <Field id="go-find-number" label={t('find.typedLabel')} hint={t('find.typedHint')} autoComplete="off" value={typed} onChange={(event) => setTyped(event.currentTarget.value)} />
            </div>
            <Button type="submit" variant="secondary" disabled={!typed.trim()}>
              {t('find.typedButton')}
            </Button>
          </form>
        </section>
      ) : null}

      <section aria-labelledby="go-queue" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="go-queue" className="text-lg font-semibold text-ink">
            {t('queue.title')}
          </h2>
          <Button variant="secondary" disabled={!online || mine.length === 0} onClick={() => void drain()}>
            {t('queue.sendNow')}
          </Button>
        </div>
        {mine.length === 0 ? (
          <Empty className="border border-line">
            <EmptyHeader>
              <EmptyTitle>{t('queue.empty')}</EmptyTitle>
              <EmptyDescription>{t('queue.emptyHint')}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="gap-3">
            {mine.map((item) => {
              const status = expired(item) ? 'EXPIRED' : item.status
              const right = editRight(item)
              const copy = copies.find((c) => c.poId === item.poId) ?? null
              const editable = status !== 'EXPIRED' && (right === 'EDIT_IN_PLACE' || right === 'RESUBMIT_NEW_KEY') && copy !== null && !copyOld(copy) && !moduleOff
              return (
                <Item key={item.key} role="listitem" variant="outline" className="items-start">
                  <ItemContent className="gap-2">
                    <ItemTitle className="text-base">{item.poNumber}</ItemTitle>
                    <ItemDescription className="text-base text-ink-muted md:text-sm">
                      {item.supplier} · {t('queue.capturedAt', { at: format.dateTime(new Date(item.capturedAt), { dateStyle: 'medium', timeStyle: 'short' }) })}
                    </ItemDescription>
                    <StatusBadge look={STATUS_LOOKS[status]} label={t(`queue.status.${status}`)} className="text-base md:text-sm" />
                    {status === 'NEEDS_ATTENTION' ? <p className="text-ink">{t(`queue.reason.${reasonOf(item)}`)}</p> : null}
                    {status === 'NEEDS_ATTENTION' && right === 'REFRESH_COPY_FIRST' ? <p className="text-ink-muted">{t('queue.refreshFirst')}</p> : null}
                  </ItemContent>
                  <ItemActions className="flex-wrap">
                    {editable ? (
                      <Button variant="secondary" onClick={() => setEditing({ copy, item })}>
                        {t('queue.edit', { number: item.poNumber ?? '' })}
                      </Button>
                    ) : null}
                    {discardRight(item) === 'ALLOWED' ? (
                      <Button variant="danger" onClick={() => setDiscarding(item)}>
                        {t('queue.discard', { number: item.poNumber ?? '' })}
                      </Button>
                    ) : null}
                  </ItemActions>
                </Item>
              )
            })}
          </ItemGroup>
        )}
        {held.length ? (
          <Notice tone="info">
            <p>{t('queue.held', { count: held.length })}</p>
            {me ? (
              <Button variant="link" onClick={() => setDeletingHeld(true)}>
                {t('queue.deleteHeld')}
              </Button>
            ) : null}
          </Notice>
        ) : null}
      </section>

      <section aria-labelledby="go-copies" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="go-copies" className="text-lg font-semibold text-ink">
            {t('prepare.title')}
          </h2>
          <Button onClick={() => void prepare(true)} disabled={preparing || !online}>
            {preparing ? t('prepare.busy') : t('prepare.button')}
          </Button>
        </div>
        {ownCopies ? <p className="text-ink-muted">{t('prepare.preparedAt', { at: format.dateTime(new Date(prepared.preparedAt), { dateStyle: 'medium', timeStyle: 'short' }) })}</p> : null}
        {ownCopies && prepared.truncated ? <Notice tone="info">{t('prepare.truncated', { count: prepared.copies.length })}</Notice> : null}
        {copies.length === 0 ? (
          <Empty className="border border-line">
            <EmptyHeader>
              <EmptyTitle>{ownCopies ? t('prepare.noneToReceive') : t('prepare.none')}</EmptyTitle>
              <EmptyDescription>{t('prepare.noneHint')}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-3">
            {copies.map((copy) => {
              const old = copyOld(copy)
              return (
                <li key={copy.poId}>
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">{copy.number}</CardTitle>
                      <CardDescription className="text-base text-ink-muted md:text-sm">
                        {copy.supplier}
                        {copy.site ? ` · ${copy.site}` : ''} · {t('prepare.lines', { count: copy.lines.length })}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-2">
                      {old ? <Notice tone="warning">{t('prepare.old', { days: retentionDays })}</Notice> : null}
                      <Button className="self-start" disabled={old || !me || moduleOff} onClick={() => setEditing({ copy, item: null })}>
                        {t('prepare.record', { number: copy.number ?? '' })}
                      </Button>
                    </CardContent>
                  </Card>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {me ? (
        <div className="flex flex-col items-start gap-2">
          <Button variant="secondary" onClick={() => void askSignOut()} aria-describedby={signOutFailed ? 'go-sign-out-failed' : undefined}>
            {t('signOut.button')}
          </Button>
          {signOutFailed ? <SignOutFailure id="go-sign-out-failed" result={signOutFailed} /> : null}
        </div>
      ) : null}

      <Sheet open={found !== null} onOpenChange={(open) => !open && setFound(null)}>
        <SheetContent side="bottom" className="mx-auto w-full max-w-2xl">
          <SheetHeader>
            <SheetTitle>{found?.kind === 'COPY' ? (found.copy.number ?? t('find.resultTitle')) : t('find.resultTitle')}</SheetTitle>
            <SheetDescription>{found ? foundText(found) : ''}</SheetDescription>
          </SheetHeader>
          {found?.kind === 'COPY' && !copyOld(found.copy) && !moduleOff ? (
            <div className="flex flex-col gap-2 px-4 pb-4">
              {found.from === 'SERVER' ? <p className="text-ink-muted">{t('find.fromServer')}</p> : null}
              <Button className="self-start" onClick={() => void openFound(found.copy, found.from)}>
                {t('prepare.record', { number: found.copy.number ?? '' })}
              </Button>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      <AlertDialog open={discarding !== null} onOpenChange={(open) => !open && setDiscarding(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('queue.discardTitle', { number: discarding?.poNumber ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('queue.discardBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-3">
            <AlertDialogCancel className="h-11 px-4 text-base">{t('queue.keep')}</AlertDialogCancel>
            <Button variant="danger" onClick={() => discarding && void discard(discarding)}>
              {t('queue.discardConfirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <WarnDialog open={signingOut} onOpenChange={setSigningOut} title={t('signOut.title')} warn={signOutPlan(false, mine).warn} empty={mine.length === 0} confirm={t('signOut.confirm')} cancel={t('signOut.cancel')} onConfirm={() => void signOut()} />
      <WarnDialog open={deletingHeld} onOpenChange={setDeletingHeld} title={t('queue.deleteHeldTitle', { count: held.length })} warn={signOutPlan(false, held).warn} empty={false} confirm={t('queue.deleteHeldConfirm')} cancel={t('queue.keep')} onConfirm={() => void deleteHeld()} />
    </div>
  )
}

function Count({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="flex flex-col border-l-2 border-line pl-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tabular text-xl font-semibold text-ink">{value}</dd>
    </div>
  )
}

/** BR-APP-09: what deleting the receipts on the phone loses, by kind, before the receiver confirms */
function WarnDialog(props: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly title: string
  readonly warn: Readonly<Record<string, SignOutWarning>>
  readonly empty: boolean
  readonly confirm: string
  readonly cancel: string
  readonly onConfirm: () => void
}) {
  const t = useTranslations('goReceive.signOut')
  const notSent = countOf(props.warn, 'NOT_SENT')
  const mayBe = countOf(props.warn, 'MAY_BE_RECORDED')
  const rejected = countOf(props.warn, 'REJECTED')
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <ul className="flex flex-col gap-2 text-left">
              {notSent ? <li>{t('notSent', { count: notSent })}</li> : null}
              {mayBe ? <li className="font-medium text-ink">{t('mayBeRecorded', { count: mayBe })}</li> : null}
              {rejected ? <li>{t('rejected', { count: rejected })}</li> : null}
              {props.empty ? <li>{t('nothing')}</li> : null}
            </ul>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-3">
          <AlertDialogCancel className="h-11 px-4 text-base">{props.cancel}</AlertDialogCancel>
          <Button variant="danger" onClick={props.onConfirm}>
            {props.confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
