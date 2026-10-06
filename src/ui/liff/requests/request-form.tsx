'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { amountToSatang } from '@/core/money/dto'
import type { FormAction, FormValues } from '../../request-form/model'
import { showSatang } from '../../request-form/money'
import type { FormFailure, FormOutcome } from '../../request-form/outcome'
import type { SaveStop, SendBlock } from '../../request-form/review-step'
import type { Attachment, PreviewRequestInput, RequestFormData, ScreenLocale, SentView } from '../../request-form/types'
import type { Autosave, SaveState } from '../../request-form/use-autosave'
import { usePreview, type PreviewAction } from '../../request-form/use-preview'
import { LiffActionBar } from '../action-bar'
import { Button } from '../button'
import { LiffContent } from '../content'
import { LiffLink } from '../liff-link'
import { LiffNotice, NoticeIcon } from '../notice'
import { LiffDetailsStep } from './details-step'
import { createEarlySaver, type EarlyBase, type EarlySaver } from './early-save'
import type * as EngineModule from './engine'
import { fieldLabelOf } from './field'
import { useRequestKey } from './key'
import { openingLines, previewLinesOf } from './lines'
import { useLiffReady, type LiffReadiness } from './ready'
import type { LiffFileActions } from './review-step'
import type { LiffFormStart } from './start'

// The short request form of LIFF (§9.4 "/liff/requests/new: แคตตาล็อกและฟอร์มแบบย่อ", S5-06, FR-LINE-003 AC1): the
// workspace's request form (src/ui/request-form/request-form.tsx) for a phone in the LINE app. The same data
// (getNewRequestForm / getRequestForEdit), the same rules as the requester types (model.ts: core/forms and core/money,
// which the server runs again), the same defaults (BR-FORM-02: the department, the budget line the requester used last
// for this type, their latest delivery site), the same drafts that save themselves (FR-INT-006, through the LIFF
// autosave route) and the same submit command — on the LIFF channel, so the request's Events say LIFF. Shorter:
//  1. รายละเอียดคำขอ — the title, the budget line with what is left on it (FR-INT-004 AC1), the type's questions;
//  2. รายการที่ขอ — the delivery site, the lines, the totals and the budget check (the workspace's items step);
//  3. ตรวจและส่ง — totals, budget, the route the DOA expects (FR-DOA-003 AC2) and the documents the rules ask for.
// The first JavaScript of the page (§9.4: 200 KB gzip with the LINE SDK and the page data in its HTML) carries step 1
// only: it opens with what the server worked out (./start.ts) and the draft's lines, written into the page once
// (./lines.ts); the rules and the autosave (./engine.tsx) load on the requester's first touch of the form, steps 2 and 3
// — with their words (./step-words.tsx) — when they get there. The main button sits at the bottom of the screen (§9.9);
// over budget it cannot send and says why and by how much (FR-INT-004 AC2). Before anything goes to the server — the
// preview, a file, the send — the LIFF session is renewed when due (./ready.ts), and nothing is sent after a refusal that
// will not change on this page load. Edits made before the engine arrived are saved with a keepalive request when LINE's
// window goes away (./early-save.ts), and the engine's autosave goes on from that save once it has its answer.

type Engine = typeof EngineModule
type LiffStep = 'details' | 'items' | 'review'

// Each with its words, which the page's HTML does not carry (./step-words.tsx)
const ItemsStep = lazy(() => import('./items-with-words').then((m) => ({ default: m.LiffItemsStep })))
const LiffReviewStep = lazy(() => import('./review-with-words').then((m) => ({ default: m.LiffReviewStep })))
const LiffSent = lazy(() => import('./review-with-words').then((m) => ({ default: m.LiffSent })))
const SaveFailureText = lazy(() => import('./review-with-words').then((m) => ({ default: m.SaveFailureText })))

/** Problems that would send something other than what is on screen (as the workspace's review step) */
const BLOCKING: ReadonlySet<string> = new Set(['TITLE', 'NO_LINES', 'LINE_INCOMPLETE', 'QUOTATION_INCOMPLETE'])
/** A field the server refused (VALIDATION_FAILED, reason FORM: the visible field it names, formData.<id>) */
const FORM_FIELD = /^formData\.([A-Za-z][A-Za-z0-9_]*)/

export interface LiffRequestFormActions extends LiffFileActions {
  readonly preview: PreviewAction
  readonly submit: (input: { requestId: string; expectedVersion: number; resubmit: boolean }, idempotencyKey: string) => Promise<FormOutcome<{ requestId: string; sent: SentView }>>
}

export interface LiffRequestFormPaths {
  /** The request pages: a request is <requests>/<id>, its draft <requests>/<id>/edit (/liff/requests) */
  readonly requests: string
  /** The catalogue of request types (/liff/requests/new) */
  readonly catalog: string
  /** The LIFF autosave route (POST) */
  readonly autosave: string
}

const NO_SESSION: FormFailure = { ok: false, code: 'UNAUTHENTICATED' }

/**
 * The form's server actions, each sent only once the LIFF session is kept (./ready.ts): a renewal started by the same tap
 * would otherwise end the session the action carries. Sending is checked again in the form's own submit.
 */
function gatedActions(actions: LiffRequestFormActions, ready: () => Promise<LiffReadiness>): LiffRequestFormActions {
  const go = async () => (await ready()) === 'go'
  return {
    ...actions,
    preview: async (input) => ((await go()) ? actions.preview(input) : NO_SESSION),
    attach: async (requestId, fileId, kind, key) => ((await go()) ? actions.attach(requestId, fileId, kind, key) : NO_SESSION),
    detach: async (requestId, fileId, key) => ((await go()) ? actions.detach(requestId, fileId, key) : NO_SESSION),
    requestUpload: async (input) => ((await go()) ? actions.requestUpload(input) : { ok: false, reason: 'FAILED' }),
    completeUpload: async (ticket) => ((await go()) ? actions.completeUpload(ticket) : { ok: false, reason: 'FAILED' }),
    downloadUrl: async (requestId, fileId) => ((await go()) ? actions.downloadUrl(requestId, fileId) : null),
  }
}

/** The edits of step 1 before the engine arrives: the same as the workspace's formReducer does with them */
function earlyReduce(values: FormValues, action: FormAction): FormValues {
  switch (action.type) {
    case 'title':
      return { ...values, title: action.value }
    case 'budgetLine':
      return { ...values, budgetLineId: action.value }
    case 'field':
      return { ...values, fields: { ...values.fields, [action.id]: action.value } }
    default:
      // The other edits come from steps that show only with the engine
      return values
  }
}

export function LiffRequestForm({
  data,
  start,
  actions,
  paths,
  locale,
}: {
  readonly data: RequestFormData
  readonly start: LiffFormStart
  readonly actions: LiffRequestFormActions
  readonly paths: LiffRequestFormPaths
  readonly locale: ScreenLocale
}) {
  const t = useTranslations('requestForm')
  const ts = useTranslations('requestForm.steps')
  const tl = useTranslations('liffRequests.form')
  const format = useFormatter()
  const ready = useLiffReady()
  const gated = useMemo(() => gatedActions(actions, ready), [actions, ready])
  const [values, setValues] = useState<FormValues>(() => ({ ...start.values, lines: openingLines(data) }))
  const valuesRef = useRef(values)
  // Up to date as soon as an edit is on screen: a save while the page goes away reads it
  useLayoutEffect(() => {
    valuesRef.current = values
  })
  const [engine, setEngine] = useState<Engine | null>(null)
  const engineRef = useRef<Engine | null>(null)
  const loading = useRef(false)
  const [attachments, setAttachments] = useState<readonly Attachment[]>(data.draft?.attachments ?? [])
  const [step, setStep] = useState<LiffStep>('details')
  const [showErrors, setShowErrors] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<FormFailure | null>(null)
  const [sent, setSent] = useState<{ requestId: string; view: SentView } | null>(null)
  const submission = useRequestKey()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const purchase = data.type.documentType === 'PURCHASE_REQUEST'

  // The autosave lives in the engine: it starts with the engine, and tells the form its state and the draft's id
  const autosaveRef = useRef<Autosave | null>(null)
  const pendingEditRef = useRef(false)
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' })
  const [requestId, setRequestId] = useState<string | null>(data.draft?.requestId ?? null)
  const onSaveState = useCallback((state: SaveState, id: string | null) => {
    setSaveState(state)
    setRequestId(id)
  }, [])

  // The requester leaves before the engine arrived — LINE's window closes, they go back to the chat, or they open another
  // page of the LIFF app: the edits so far are saved (./early-save.ts), with a keepalive request that outlives the page.
  // With the engine, its autosave does all of this (use-autosave.ts); it starts once no early save is on its way or
  // unanswered (`earlyBusy`), from the draft and version the last one gave (`early`).
  const draftRequestId = data.draft?.requestId ?? null
  const draftVersion = data.draft?.version ?? null
  const [early, setEarly] = useState<EarlyBase>({ requestId: draftRequestId, version: draftVersion })
  const [earlyBusy, setEarlyBusy] = useState(false)
  const mounted = useRef(false)
  /** An edit made once the engine was there but before its autosave started: the autosave saves it (it may be a line) */
  const lateEdit = useRef(false)
  const saverRef = useRef<EarlySaver | null>(null)
  /** The page's early saver, made on its first use (an effect or a handler, never while rendering) */
  const earlySaver = useCallback(
    (): EarlySaver =>
      (saverRef.current ??= createEarlySaver({
        url: paths.autosave,
        requestTypeCode: data.type.code,
        typeName: data.type.name,
        titleMax: start.titleMax,
        base: { requestId: draftRequestId, version: draftVersion },
        values: () => valuesRef.current,
        onState: (state, created) => {
          // What the engine's autosave saves once it starts
          pendingEditRef.current = state.unsaved || lateEdit.current
          // Gone to another page of the app: that page keeps its own address
          if (!mounted.current) return
          setEarlyBusy(state.saving || state.unanswered)
          setSaveState(state.unanswered ? { kind: 'error', failure: null } : state.saving ? { kind: 'saving' } : { kind: 'idle' })
          if (state.base.requestId) {
            setEarly(state.base)
            setRequestId(state.base.requestId)
          }
          // A new draft has an address from now on, as after the autosave's first save
          if (created) window.history.replaceState(null, '', `${paths.requests}/${state.base.requestId}/edit`)
        },
      })),
    [paths.autosave, paths.requests, data.type.code, data.type.name, start.titleMax, draftRequestId, draftVersion],
  )
  useEffect(() => {
    mounted.current = true
    const saver = earlySaver()
    const save = () => {
      if (!autosaveRef.current) saver.save()
    }
    const onHidden = () => {
      if (document.visibilityState === 'hidden') save()
    }
    window.addEventListener('pagehide', save)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('pagehide', save)
      document.removeEventListener('visibilitychange', onHidden)
      mounted.current = false
      // Another page of the LIFF app: this script keeps running, so the save goes out and its answer comes back
      save()
    }
  }, [earlySaver])

  /** The rules and the autosave, fetched once — on the first touch of the form, never with the first screen */
  const loadEngine = useCallback(() => {
    if (loading.current) return
    loading.current = true
    void import('./engine').then(
      (m) => {
        engineRef.current = m
        setEngine(m)
        // An early save that got no answer goes again, so that the autosave can start from its draft
        if (earlySaver().state().unanswered) earlySaver().save()
      },
      () => {
        loading.current = false
      },
    )
  }, [earlySaver])

  const update = useCallback(
    (action: FormAction) => {
      setValues((v) => (engineRef.current ? engineRef.current.formReducer(v, action) : earlyReduce(v, action)))
      if (autosaveRef.current) autosaveRef.current.changed()
      else {
        pendingEditRef.current = true
        // Before the engine an edit is of step 1, which an early save carries
        if (engineRef.current) lateEdit.current = true
        else earlySaver().changed()
      }
      loadEngine()
    },
    [loadEngine, earlySaver],
  )

  // What the rules see now (with the engine; before it, what the server worked out for the opening values)
  const evaluated = engine ? engine.evaluate(data, values, attachments) : null
  const startVisible = useMemo(() => new Set(start.visible), [start.visible])
  const visible = evaluated?.visible ?? startVisible
  const totals = evaluated?.totals ?? null

  // The server's view: the chosen line's balance and the expected route, shortly after amounts or the line change
  const previewLines = previewLinesOf(values)
  const previewKey = JSON.stringify([requestId, values.budgetLineId, values.priceIncludesVat, previewLines])
  const previewInput = useMemo<PreviewRequestInput | null>(() => {
    if (!purchase) return null
    const [id, budgetLineId, priceIncludesVat, lines] = JSON.parse(previewKey) as [string | null, string, boolean, PreviewRequestInput['lines']]
    return { requestTypeCode: data.type.code, requestId: id, budgetLineId: budgetLineId || null, priceIncludesVat, lines }
  }, [purchase, previewKey, data.type.code])
  const { preview, loading: previewLoading } = usePreview(gated.preview, previewInput)
  // The balance shown is always the chosen line's: an answer about the line chosen before is not shown
  const budget = preview && (preview.budget.kind !== 'LINE' || preview.budget.budgetLineId === values.budgetLineId) ? preview.budget : null

  // A new-supplier request has no items: its steps are details, and check and send
  const stepIds: readonly LiffStep[] = purchase ? ['details', 'items', 'review'] : ['details', 'review']
  const index = Math.max(0, stepIds.indexOf(step))
  const goTo = useCallback(
    (next: LiffStep) => {
      loadEngine()
      setStep(next)
      if (next === 'review') setShowErrors(true)
    },
    [loadEngine],
  )
  // Moving between steps: the new step's heading takes focus, so keyboard and screen reader users start at the top
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    headingRef.current?.focus()
    headingRef.current?.scrollIntoView({ block: 'start' })
    // The last step is fetched once the requester moved on
    if (step === 'items') void import('./review-with-words')
  }, [step])

  /** The draft must exist before a file is linked to it, or before it is sent */
  const draftId = useCallback(async (): Promise<string | null> => {
    const api = autosaveRef.current
    if (!api) {
      // The autosave waits for an early save without an answer: that one goes again
      earlySaver().save()
      return null
    }
    if (api.id()) return api.id()
    await api.saveNow({ force: true })
    return api.id()
  }, [earlySaver])

  async function submit() {
    setShowErrors(true)
    setSubmitError(null)
    setSubmitting(true)
    try {
      // A LIFF session near its idle limit is renewed first; after a refusal that will not change, nothing is sent
      const readiness = await ready()
      if (readiness === 'reloading') return
      if (readiness === 'ended') {
        setSubmitError(NO_SESSION)
        return
      }
      const api = autosaveRef.current
      // Without the autosave (it waits for an early save without an answer), that save goes again
      if (!api) earlySaver().save()
      const saved = api ? await api.saveNow({ force: true }) : false
      const id = api?.id() ?? null
      const version = api?.version() ?? null
      if (!api || !saved || !id || version === null) {
        // Why the save failed is shown at the top of the form (a conflict, a closed request or the connection). A request
        // closed to this page cannot be sent from it at all: its notice and the bar's reason say so, never "try again"
        if (api?.halted() !== 'closed') setSubmitError({ ok: false, code: 'DRAFT_NOT_SAVED' })
        return
      }
      const outcome = await gated.submit({ requestId: id, expectedVersion: version, resubmit: data.draft?.status === 'RETURNED' }, submission.key)
      submission.next()
      if (outcome.ok) {
        api.stop()
        setSent({ requestId: outcome.requestId, view: outcome.sent })
        return
      }
      setSubmitError(outcome)
    } catch {
      setSubmitError({ ok: false, code: 'FAILED' })
    } finally {
      setSubmitting(false)
    }
  }

  // A field the server refused is marked where it is asked — step 1, or beside the documents for a question the attachment
  // rules ask for — as on the web (FR-INT-002: the server checks every answer again)
  const fieldErrors: Record<string, string> = {}
  const refusedField = submitError?.code === 'VALIDATION_FAILED' && submitError.reason === 'FORM' ? FORM_FIELD.exec(submitError.field ?? '')?.[1] : undefined
  if (refusedField) {
    const def = data.form.fields.find((f) => f.id === refusedField)
    fieldErrors[refusedField] = t('errors.FORM_FIELD', { field: def ? fieldLabelOf(def, locale) : refusedField })
  }

  const title = values.title.trim() || data.type.name
  if (sent) {
    return (
      <Suspense
        fallback={
          <LiffContent>
            <Waiting />
          </LiffContent>
        }
      >
        <LiffSent
          sent={sent.view}
          title={title}
          kind={!purchase ? 'procurement' : data.draft?.status === 'RETURNED' ? 'resubmit' : 'send'}
          requestHref={`${paths.requests}/${sent.requestId}`}
          catalogHref={paths.catalog}
        />
      </Suspense>
    )
  }

  const saveStop: SaveStop | null = saveState.kind === 'conflict' ? 'conflict' : saveState.kind === 'closed' ? 'closed' : null
  const blockedSave = saveStop !== null
  // FR-INT-004 AC2: over budget (before VAT, BR-BUD-03) the button cannot send and says why and by how much. The review
  // step is told what stops it (sendBlock), so that its "ตรวจก่อนส่ง" says the same (§9.9 principle 3)
  const available = budget?.kind === 'LINE' ? amountToSatang(budget.available.amount) : null
  const shortfall = available !== null && totals !== null && totals.net > available ? totals.net - available : null
  const sendBlock: SendBlock | null =
    available !== null && shortfall !== null
      ? { kind: 'BUDGET', available, shortfall }
      : evaluated?.problems.some((p) => BLOCKING.has(p.kind))
        ? { kind: 'PROBLEMS' }
        : saveStop
          ? { kind: 'SAVE', stop: saveStop }
          : null
  const blockedReason =
    sendBlock?.kind === 'BUDGET'
      ? t('submit.blockedBudget', { available: showSatang(sendBlock.available), shortfall: showSatang(sendBlock.shortfall) })
      : sendBlock?.kind === 'PROBLEMS'
        ? t('submit.blockedProblems')
        : sendBlock?.kind === 'SAVE'
          ? // Closed to this page (sent or cancelled elsewhere): loading the latest version would not make it sendable
            sendBlock.stop === 'closed'
            ? t('submit.blockedClosed')
            : t('submit.blockedSave')
          : null
  const submitLabel = !purchase ? t('submit.toProcurement') : data.draft?.status === 'RETURNED' ? t('submit.resubmit') : t('submit.send')
  const previous = index > 0 ? stepIds[index - 1]! : null
  const next = index < stepIds.length - 1 ? stepIds[index + 1]! : null

  return (
    <>
      {engine && !earlyBusy ? (
        <engine.AutosaveHost
          apiRef={autosaveRef}
          pendingEditRef={pendingEditRef}
          onState={onSaveState}
          options={{
            url: paths.autosave,
            requestTypeCode: data.type.code,
            initialRequestId: early.requestId,
            initialVersion: early.version,
            getPayload: (isNew) => engine.draftPayload(valuesRef.current, data.type.name, isNew),
            // The draft has an address from now on: reloading the page in LINE opens it again
            onCreated: (id) => window.history.replaceState(null, '', `${paths.requests}/${id}/edit`),
            // Lines saved for the first time learn their ids, so the next save changes each one by its id
            onSaved: (parts) => setValues((v) => engine.formReducer(v, { type: 'saved', lines: parts.lines, quotations: parts.quotations })),
          }}
        />
      ) : null}
      {/* The first touch of the form brings its rules and its autosave */}
      <LiffContent>
        <div className="flex flex-1 flex-col gap-6" onPointerDownCapture={loadEngine} onKeyDownCapture={loadEngine} onFocusCapture={loadEngine}>
          {data.draft?.status === 'RETURNED' ? (
            <LiffNotice tone="warning">{data.draft.returnReason ? t('page.returnedReason', { reason: data.draft.returnReason }) : t('page.returned')}</LiffNotice>
          ) : null}
          {saveState.kind === 'conflict' ? (
            <LiffNotice tone="danger">
              <p>{t('save.conflict')}</p>
              <Button variant="secondary" className="mt-2" onClick={() => window.location.reload()}>
                {t('save.reload')}
              </Button>
            </LiffNotice>
          ) : null}
          {saveState.kind === 'closed' ? (
            <LiffNotice tone="warning">
              <p>{t('save.closed')}</p>
              {requestId ? <LiffLink href={`${paths.requests}/${requestId}`}>{t('save.openRequest')}</LiffLink> : null}
            </LiffNotice>
          ) : null}

          {/* The step's heading stands above its parts (18 px, LiffSection) and their headings (16 px), as on the web (§9.9) */}
          <div className="flex flex-col gap-1">
            <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold outline-none">
              {ts('heading', { n: index + 1, total: stepIds.length, name: ts(step) })}
            </h2>
            {saveState.kind === 'error' ? (
              <div role="status" className="flex flex-col gap-2">
                <p className="flex items-start gap-1.5 text-danger">
                  <NoticeIcon tone="danger" />
                  {saveState.failure ? (
                    <Suspense fallback={<span>{t('save.error')}</span>}>
                      <SaveFailureText failure={saveState.failure} fields={data.form.fields} locale={locale} />
                    </Suspense>
                  ) : (
                    <span>{t('save.error')}</span>
                  )}
                </p>
                <Button variant="secondary" className="self-start" onClick={() => void (autosaveRef.current ? autosaveRef.current.saveNow() : earlySaver().save())}>
                  {t('save.saveNow')}
                </Button>
              </div>
            ) : (
              <p role="status" className="text-ink-muted">
                {saveState.kind === 'dirty'
                  ? t('save.dirty')
                  : saveState.kind === 'saving'
                    ? t('save.saving')
                    : saveState.kind === 'saved'
                      ? tl('savedAt', { time: format.dateTime(new Date(saveState.at), { hour: '2-digit', minute: '2-digit' }) })
                      : requestId
                        ? t('save.idleSaved')
                        : t('save.idleNew')}
              </p>
            )}
          </div>

          {step === 'details' ? (
            <LiffDetailsStep
              data={data}
              values={values}
              update={update}
              locale={locale}
              visible={visible}
              showErrors={showErrors}
              budget={budget}
              previewLoading={previewLoading}
              fieldErrors={fieldErrors}
              titleMax={start.titleMax}
            />
          ) : evaluated && engine ? (
            <Suspense fallback={<Waiting />}>
              {step === 'items' ? (
                <ItemsStep
                  data={data}
                  values={values}
                  update={update}
                  locale={locale}
                  input={evaluated.input}
                  visible={evaluated.visible}
                  totals={evaluated.totals}
                  showErrors={showErrors}
                  budget={budget}
                  previewLoading={previewLoading}
                  fieldErrors={fieldErrors}
                  endDateRequired={evaluated.endDateRequired}
                />
              ) : (
                <LiffReviewStep
                  data={data}
                  values={values}
                  update={update}
                  locale={locale}
                  input={evaluated.input}
                  visible={evaluated.visible}
                  totals={evaluated.totals}
                  showErrors={showErrors}
                  budget={budget}
                  previewLoading={previewLoading}
                  fieldErrors={fieldErrors}
                  rules={evaluated.rules}
                  nets={evaluated.nets}
                  lowest={evaluated.lowest}
                  problems={evaluated.problems}
                  route={preview?.route ?? null}
                  onGoTo={goTo}
                  sendBlock={sendBlock}
                  submitError={submitError}
                  onReload={() => window.location.reload()}
                  files={{ attachments, setAttachments, draftId, requestId, actions: gated, ready, saveBlocked: blockedSave }}
                />
              )}
            </Suspense>
          ) : (
            <Waiting />
          )}
        </div>
      </LiffContent>

      <LiffActionBar label={tl('barLabel')}>
        {step === 'review' && blockedReason ? (
          <p id="liff-submit-blocked" className="flex items-start gap-1.5 font-medium text-danger">
            <NoticeIcon tone="danger" />
            <span>{blockedReason}</span>
          </p>
        ) : null}
        <div className="flex items-stretch gap-3">
          {previous ? (
            // The step it goes back to, by the number its heading shows (§9.9 rule 7): never mistaken for the link back to
            // the request types above the form; what a screen reader reads is what the button shows (WCAG 2.5.3). It keeps
            // its words on one line and grows with the row when the main button's words take two (English at 375 px)
            <Button variant="secondary" className="h-auto min-h-11 shrink-0 py-2" onClick={() => goTo(previous)}>
              {tl('back', { n: index })}
            </Button>
          ) : null}
          {next ? (
            <Button className="h-auto min-h-11 min-w-0 flex-1 py-2" onClick={() => goTo(next)}>
              {ts('next', { name: ts(next) })}
            </Button>
          ) : (
            <Button
              className="h-auto min-h-11 min-w-0 flex-1 py-2"
              onClick={() => void submit()}
              disabled={Boolean(blockedReason) || submitting || !evaluated}
              aria-describedby={blockedReason ? 'liff-submit-blocked' : undefined}
            >
              {submitting ? t('submit.sending') : submitLabel}
            </Button>
          )}
        </div>
      </LiffActionBar>
    </>
  )
}

/** While a part that is loaded on demand arrives */
function Waiting() {
  const tw = useTranslations('liffRequests.form')
  return (
    <p role="status" className="text-ink-muted">
      {tw('stepLoading')}
    </p>
  )
}
