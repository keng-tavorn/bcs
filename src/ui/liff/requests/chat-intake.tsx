'use client'

import { useTranslations } from 'next-intl'
import { useId, useState, useTransition } from 'react'
import type { CatalogEntry } from '../../request-form/types'
import { Button } from '../button'
import { LiffLink } from '../liff-link'
import { LiffNotice } from '../notice'
import { useLiffSubmissionKey } from '../submission-key'
import { checkboxClass, inputClass } from './classes'

// A request begun in the LINE chat, in LIFF (S17-07 · BR-LINE-12 · FR-LINE-301 AC3 AC4 AC7): what the member typed as a
// reference (never sent anywhere from here), how the photos stand, the title the draft starts with (the first line,
// editable) and the request type to pick. "สร้างร่างคำขอ" makes the request draft through chat_intake.draft and opens it
// in the LIFF form, where the requester checks, edits and sends it; "ไม่ใช่คำขอ" closes the chat draft. Opening this page
// changes nothing (a GET never makes a draft). The light components of LIFF only (ADR-052).

export type LiffChatImageState = 'PENDING' | 'STORED' | 'FAILED'

export interface LiffChatIntake {
  readonly id: string
  readonly status: 'OPEN' | 'DRAFTED' | 'DISMISSED' | 'EXPIRED'
  readonly text: string | null
  readonly textTruncated: boolean
  readonly purged: boolean
  readonly proposedTitle: string
  readonly images: ReadonlyArray<{ readonly seq: number; readonly state: LiffChatImageState }>
  /** The LIFF page of the request it became (DRAFTED) */
  readonly requestHref: string | null
}

export type LiffChatOutcome = { readonly ok: true; readonly href: string } | { readonly ok: false; readonly code: string; readonly field?: string }

export interface LiffChatIntakeProps {
  readonly intake: LiffChatIntake
  readonly types: readonly CatalogEntry[]
  readonly catalogHref: string
  readonly draft: (input: { intakeId: string; requestTypeCode: string; title: string; idempotencyKey: string }) => Promise<LiffChatOutcome>
  readonly dismiss: (input: { intakeId: string; idempotencyKey: string }) => Promise<LiffChatOutcome>
}

const TITLE_MAX = 200

export function LiffChatIntakePanel({ intake, types, catalogHref, draft, dismiss }: LiffChatIntakeProps) {
  const t = useTranslations('liffChat')
  const id = useId()
  const [title, setTitle] = useState(intake.proposedTitle)
  const [type, setType] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ readonly code: string; readonly field?: string } | null>(null)
  const [closed, setClosed] = useState(false)
  const [pending, start] = useTransition()
  const key = useLiffSubmissionKey()

  const send = (run: () => Promise<LiffChatOutcome>, after: (href: string) => void) =>
    start(async () => {
      setProblem(null)
      const outcome = await run().catch(() => ({ ok: false as const, code: 'NETWORK' }))
      key.next()
      if (outcome.ok) after(outcome.href)
      else setProblem(outcome)
    })

  const onDraft = () => {
    if (!title.trim()) return setProblem({ code: 'VALIDATION_FAILED', field: 'title' })
    if (!type) return setProblem({ code: 'VALIDATION_FAILED', field: 'requestTypeCode' })
    send(
      () => draft({ intakeId: intake.id, requestTypeCode: type, title: title.trim(), idempotencyKey: key.key }),
      (href) => window.location.assign(href),
    )
  }
  const onDismiss = () => send(() => dismiss({ intakeId: intake.id, idempotencyKey: key.key }), () => setClosed(true))

  const problemWords = (p: { readonly code: string; readonly field?: string }) =>
    p.code === 'VALIDATION_FAILED' && p.field === 'title'
      ? t('errors.title')
      : p.code === 'VALIDATION_FAILED' && p.field === 'requestTypeCode'
        ? t('errors.type')
        : p.code === 'INVALID_STATE_TRANSITION'
          ? t('errors.closed')
          : p.code === 'NOT_FOUND'
            ? t('errors.notFound')
            : p.code === 'UNAUTHENTICATED'
              ? t('errors.signIn')
              : t('errors.other')

  const reference = (
    <section aria-labelledby={`${id}-text`} className="flex flex-col gap-2">
      <h2 id={`${id}-text`} className="text-lg font-semibold">
        {t('textHeading')}
      </h2>
      {intake.purged ? (
        <p className="text-ink-muted">{t('textPurged')}</p>
      ) : intake.text ? (
        <>
          <p className="whitespace-pre-wrap break-words border-l-2 border-line pl-3">{intake.text}</p>
          {intake.textTruncated ? <p className="text-ink-muted">{t('textTruncated')}</p> : null}
        </>
      ) : (
        <p className="text-ink-muted">{t('textNone')}</p>
      )}
      <p className="text-ink-muted">{t('textReference')}</p>
      {intake.images.length > 0 ? (
        <>
          <h3 className="font-semibold">{t('imagesHeading', { count: intake.images.length })}</h3>
          <ul className="flex flex-col gap-1">
            {intake.images.map((image) => (
              <li key={image.seq}>{t(`image.${image.state}`, { seq: image.seq })}</li>
            ))}
          </ul>
          {intake.images.some((i) => i.state === 'FAILED') ? <LiffNotice tone="warning">{t('imagesFailed')}</LiffNotice> : null}
        </>
      ) : null}
    </section>
  )

  if (closed || intake.status === 'DISMISSED' || intake.status === 'EXPIRED') {
    return (
      <div className="flex flex-col gap-4">
        <LiffNotice tone="info">{closed || intake.status === 'DISMISSED' ? t('dismissed') : t('expired')}</LiffNotice>
        <LiffLink href={catalogHref}>{t('toCatalog')}</LiffLink>
      </div>
    )
  }
  if (intake.status === 'DRAFTED') {
    return (
      <div className="flex flex-col gap-4">
        <LiffNotice tone="success">{t('drafted')}</LiffNotice>
        {intake.requestHref ? <LiffLink href={intake.requestHref}>{t('openDraft')}</LiffLink> : null}
        {reference}
      </div>
    )
  }

  const titleError = problem?.code === 'VALIDATION_FAILED' && problem.field === 'title'
  const typeError = problem?.code === 'VALIDATION_FAILED' && problem.field === 'requestTypeCode'
  return (
    <div className="flex flex-col gap-6">
      <p>{t('intro')}</p>
      {reference}
      <section aria-labelledby={`${id}-make`} className="flex flex-col gap-4">
        <h2 id={`${id}-make`} className="text-lg font-semibold">
          {t('makeHeading')}
        </h2>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-title`} className="font-medium">
            {t('title')}
          </label>
          <input
            id={`${id}-title`}
            className={inputClass}
            value={title}
            maxLength={TITLE_MAX}
            onChange={(e) => setTitle(e.currentTarget.value)}
            aria-invalid={titleError || undefined}
            aria-describedby={`${id}-title-hint`}
            required
          />
          <p id={`${id}-title-hint`} className="text-ink-muted">
            {t('titleHint')}
          </p>
        </div>
        <fieldset className="flex flex-col gap-2" aria-invalid={typeError || undefined}>
          <legend className="mb-1 font-medium">{t('type')}</legend>
          {types.length === 0 ? <p className="text-ink-muted">{t('noTypes')}</p> : null}
          {types.map((entry) => (
            <label key={entry.code} className="flex min-h-11 items-start gap-3 rounded-md border border-line px-3 py-2 has-[:checked]:border-primary">
              <input type="radio" name={`${id}-type`} value={entry.code} className={`${checkboxClass} mt-0.5`} checked={type === entry.code} onChange={() => setType(entry.code)} />
              <span className="flex flex-col">
                <span className="font-medium">{entry.name}</span>
                {entry.description ? <span className="text-ink-muted">{entry.description}</span> : null}
              </span>
            </label>
          ))}
        </fieldset>
        {problem ? <LiffNotice tone="danger">{problemWords(problem)}</LiffNotice> : null}
        <div className="flex flex-col gap-3">
          <Button onClick={onDraft} disabled={pending}>
            {pending ? t('working') : t('make')}
          </Button>
          <Button variant="secondary" onClick={onDismiss} disabled={pending}>
            {t('dismiss')}
          </Button>
        </div>
        <p className="text-ink-muted">{t('sendLater')}</p>
      </section>
    </div>
  )
}
