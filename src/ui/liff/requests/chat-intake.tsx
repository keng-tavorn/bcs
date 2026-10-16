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

/** S17-08: the Intake Agent's reading of the draft (BR-LINE-13): reading, ready with its values, or nothing (no AI) */
export type LiffChatAi =
  | { readonly status: 'NONE' }
  | { readonly status: 'READING' }
  | {
      readonly status: 'READY'
      readonly agentActionId: string
      readonly requestTypeCode: string | null
      readonly values: ReadonlyArray<{ readonly path: string; readonly text: string; readonly mustConfirm: boolean }>
    }

export type LiffChatOutcome = { readonly ok: true; readonly href: string } | { readonly ok: false; readonly code: string; readonly field?: string; readonly reason?: string }

export interface LiffChatIntakeProps {
  readonly intake: LiffChatIntake
  readonly types: readonly CatalogEntry[]
  readonly catalogHref: string
  readonly ai: LiffChatAi
  readonly draft: (input: { intakeId: string; requestTypeCode: string; title?: string; ai?: { agentActionId: string; usePaths: string[] }; idempotencyKey: string }) => Promise<LiffChatOutcome>
  readonly dismiss: (input: { intakeId: string; idempotencyKey: string }) => Promise<LiffChatOutcome>
}

const TITLE_MAX = 200

const LINE_PATH = /^lines\.(\d+)\.(description|quantity|uom|unitPrice)$/

/** The reading's values as the panel offers them: its title, its lines (all four values each, or none offered), the rest */
function aiParts(ai: LiffChatAi) {
  if (ai.status !== 'READY') return null
  const title = ai.values.find((v) => v.path === 'title') ?? null
  const byLine = new Map<number, Record<string, string>>()
  for (const v of ai.values) {
    const m = LINE_PATH.exec(v.path)
    if (m) byLine.set(Number(m[1]), { ...byLine.get(Number(m[1])), [m[2]!]: v.text })
  }
  const lines = [...byLine.entries()].sort(([a], [b]) => a - b).map(([, l]) => l)
  const complete = lines.length > 0 && lines.every((l) => l.description && l.quantity && l.uom && l.unitPrice)
  return {
    agentActionId: ai.agentActionId,
    title,
    lines: complete ? lines : [],
    linePaths: complete ? ai.values.filter((v) => LINE_PATH.test(v.path)).map((v) => v.path) : [],
    linesMustConfirm: complete && ai.values.some((v) => LINE_PATH.test(v.path) && v.mustConfirm),
    others: ai.values.filter((v) => v.path !== 'title' && !LINE_PATH.test(v.path)),
  }
}

export function LiffChatIntakePanel({ intake, types, catalogHref, ai, draft, dismiss }: LiffChatIntakeProps) {
  const t = useTranslations('liffChat')
  const id = useId()
  const parts = aiParts(ai)
  const [title, setTitle] = useState(intake.proposedTitle)
  // The type the AI proposed is picked to start with, when it is one of the list
  const [type, setType] = useState<string | null>(ai.status === 'READY' && types.some((x) => x.code === ai.requestTypeCode) ? ai.requestTypeCode : null)
  // Every value of the reading is taken unless the owner leaves it out (the lines together)
  const [useLines, setUseLines] = useState(true)
  const [leftOut, setLeftOut] = useState<ReadonlySet<string>>(new Set())
  const [problem, setProblem] = useState<{ readonly code: string; readonly field?: string; readonly reason?: string } | null>(null)
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
    const usePaths = parts
      ? [
          ...(parts.title && title.trim() === parts.title.text ? ['title'] : []),
          ...parts.others.filter((v) => !leftOut.has(v.path)).map((v) => v.path),
          ...(useLines ? parts.linePaths : []),
        ]
      : []
    send(
      () =>
        draft({
          intakeId: intake.id,
          requestTypeCode: type,
          title: title.trim(),
          ...(parts && usePaths.length > 0 ? { ai: { agentActionId: parts.agentActionId, usePaths } } : {}),
          idempotencyKey: key.key,
        }),
      (href) => window.location.assign(href),
    )
  }
  const onDismiss = () => send(() => dismiss({ intakeId: intake.id, idempotencyKey: key.key }), () => setClosed(true))

  const problemWords = (p: { readonly code: string; readonly field?: string; readonly reason?: string }) =>
    p.code === 'VALIDATION_FAILED' && p.field === 'title'
      ? t('errors.title')
      : p.reason === 'INTAKE_TYPE'
        ? t('errors.typeUnavailable')
        : p.reason === 'NO_DEPARTMENT'
          ? t('errors.noDepartment')
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
          {intake.images.some((i) => i.state === 'PENDING') ? <p className="text-ink-muted">{t('imagesPending')}</p> : null}
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

  const aiBadge = <span className="rounded-sm border border-info px-1.5 text-sm text-info">{t('ai.badge')}</span>
  const aiSection =
    ai.status === 'READING' ? (
      <LiffNotice tone="info">{t('ai.reading')}</LiffNotice>
    ) : parts ? (
      <section aria-labelledby={`${id}-ai`} className="flex flex-col gap-3">
        <h2 id={`${id}-ai`} className="flex flex-wrap items-center gap-2 text-lg font-semibold">
          {t('ai.heading')} {aiBadge}
        </h2>
        <p className="text-ink-muted">{t('ai.intro')}</p>
        {parts.title ? (
          <div className="flex flex-col gap-1">
            <span className="font-medium">{t('ai.title')}</span>
            <span>{parts.title.text}</span>
            <Button variant="secondary" className="self-start" onClick={() => setTitle(parts.title!.text)} disabled={title.trim() === parts.title.text}>
              {t('ai.useTitle')}
            </Button>
          </div>
        ) : null}
        {parts.lines.length > 0 ? (
          <label className="flex min-h-11 items-start gap-3 rounded-md border border-line px-3 py-2">
            <input type="checkbox" className={`${checkboxClass} mt-0.5`} checked={useLines} onChange={(e) => setUseLines(e.currentTarget.checked)} />
            <span className="flex flex-col gap-1">
              <span className="font-medium">{t('ai.lines', { count: parts.lines.length })}</span>
              {parts.lines.map((l, i) => (
                <span key={i}>{t('ai.line', { description: l.description!, quantity: l.quantity!, uom: l.uom!, unitPrice: l.unitPrice! })}</span>
              ))}
              {parts.linesMustConfirm ? <span className="text-ink-muted">{t('ai.confirmLater')}</span> : null}
            </span>
          </label>
        ) : null}
        {parts.others.map((v) => (
          <label key={v.path} className="flex min-h-11 items-start gap-3 rounded-md border border-line px-3 py-2">
            <input
              type="checkbox"
              className={`${checkboxClass} mt-0.5`}
              checked={!leftOut.has(v.path)}
              onChange={(e) => {
                const next = new Set(leftOut)
                if (e.currentTarget.checked) next.delete(v.path)
                else next.add(v.path)
                setLeftOut(next)
              }}
            />
            <span className="flex flex-col gap-1">
              <span className="font-medium">{t(`ai.field.${v.path === 'deliverySiteId' ? 'site' : v.path === 'suggestedSupplierId' ? 'supplier' : 'other'}`)}</span>
              <span>{v.text}</span>
              {v.mustConfirm ? <span className="text-ink-muted">{t('ai.confirmLater')}</span> : null}
            </span>
          </label>
        ))}
      </section>
    ) : null

  const titleError = problem?.code === 'VALIDATION_FAILED' && problem.field === 'title'
  const typeError = problem?.code === 'VALIDATION_FAILED' && problem.field === 'requestTypeCode'
  return (
    <div className="flex flex-col gap-6">
      <p>{t('intro')}</p>
      {reference}
      {aiSection}
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
