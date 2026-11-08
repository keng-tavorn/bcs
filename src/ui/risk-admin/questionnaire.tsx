'use client'

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useSay, type Say } from './say'
import { useId, useState, type FormEvent } from 'react'
import { StatusBadge } from '../document/badges'
import type { BadgeLook } from '../document/badge-looks'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { ListEmpty } from '../page/page'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../shadcn/alert-dialog'
import { Button } from '../shadcn/button'
import { Checkbox } from '../shadcn/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../shadcn/dialog'
import { Input } from '../shadcn/input'
import { Label } from '../shadcn/label'
import { NativeSelect, NativeSelectOption } from '../shadcn/native-select'
import { Switch } from '../shadcn/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../shadcn/tabs'
import { Textarea } from '../shadcn/textarea'
import { RISK_DOMAINS_UI, RISK_TIERS, SCREENING_KEYS, type RiskAdminOutcome, type RiskDomainUi, type RiskTierCodeUi, type ScreeningKey } from './model'

// /admin/risk/questionnaire and /admin/risk/questionnaire/[versionId] (S11-04 · BR-RSK-01 · BR-RSK-02 · BR-RSK-05): the
// versions of the questionnaire, and one version: its questions edited in a form (words in two languages, options with
// points and a floor tier, the condition that puts the question in a set, the scope evidence must match, whether the
// AI may read its evidence) — never raw JSON; the lint as it stands; the question set a screening context would get;
// and sending, publishing (someone else) or sending back. A condition the simple editor cannot show stays as it is.

export type QuestionnaireStatusUi = 'DRAFT' | 'PENDING_PUBLISH' | 'PUBLISHED' | 'SUPERSEDED'

export const STATUS_LOOK: Record<QuestionnaireStatusUi, BadgeLook> = {
  DRAFT: { tone: 'neutral', icon: 'FilePen' },
  PENDING_PUBLISH: { tone: 'warn', icon: 'Hourglass' },
  PUBLISHED: { tone: 'ok', icon: 'CircleCheck' },
  SUPERSEDED: { tone: 'neutral', icon: 'Ban' },
}

export interface OptionUi {
  readonly code: string
  readonly labelTh: string
  readonly labelEn: string
  readonly points: number
  readonly minTier?: RiskTierCodeUi
  readonly evidence?: boolean
}

export type ConditionUi = { readonly all: readonly ConditionUi[] } | { readonly any: readonly ConditionUi[] } | { readonly field: string; readonly op: string; readonly value?: unknown }

export interface QuestionUi {
  readonly code: string
  readonly domain: RiskDomainUi
  readonly textTh: string
  readonly textEn: string
  readonly helpTh: string | null
  readonly helpEn: string | null
  readonly options: readonly OptionUi[]
  readonly appliesWhen: ConditionUi | null
  readonly required: boolean
  readonly evidenceScopeRequired: boolean
  readonly evidenceScope: string | null
  readonly aiReadable: boolean
}

export interface LintIssueUi {
  readonly code: string
  readonly question?: string
  readonly documentType?: string
  readonly reason: string
}

export interface VersionUi {
  readonly id: string
  readonly code: string
  readonly versionNo: number
  readonly status: QuestionnaireStatusUi
  /** "1 พ.ย. 2569 08:00" in the reader's language */
  readonly effectiveText: string
  readonly questions: number
  readonly submittedByName: string | null
  readonly publishedByName: string | null
  readonly submittedByMe: boolean
}

export interface VersionDetailUi extends VersionUi {
  readonly version: number
  readonly changeReason: string | null
  readonly questionList: readonly QuestionUi[]
  readonly lint: { readonly errors: readonly LintIssueUi[]; readonly warnings: readonly LintIssueUi[] }
}

export interface PreviewInputUi {
  readonly screening: Readonly<Record<ScreeningKey, 'Y' | 'N'>>
  readonly categoryCodes: readonly string[]
  readonly payeeType: 'JURISTIC' | 'INDIVIDUAL' | 'FOREIGN'
  readonly isForeign: boolean
}

export type PreviewOutcome = { readonly ok: true; readonly inherentTier: RiskTierCodeUi; readonly questions: readonly string[] } | Extract<RiskAdminOutcome, { ok: false }>

type Key = string
export interface QuestionnaireActions {
  readonly draft: (code: string, key: Key) => Promise<RiskAdminOutcome>
  readonly updateQuestion: (versionId: string, expectedVersion: number, question: QuestionUi, key: Key) => Promise<RiskAdminOutcome>
  readonly removeQuestion: (versionId: string, expectedVersion: number, questionCode: string, key: Key) => Promise<RiskAdminOutcome>
  readonly reorder: (versionId: string, expectedVersion: number, questionCodes: string[], key: Key) => Promise<RiskAdminOutcome>
  readonly submit: (versionId: string, expectedVersion: number, effectiveDate: string, changeReason: string, key: Key) => Promise<RiskAdminOutcome>
  readonly publish: (versionId: string, expectedVersion: number, key: Key) => Promise<RiskAdminOutcome>
  readonly reject: (versionId: string, expectedVersion: number, reason: string, key: Key) => Promise<RiskAdminOutcome>
  readonly preview: (versionId: string, input: PreviewInputUi) => Promise<PreviewOutcome>
}

const CONTROL = 'h-11 bg-bg text-base lg:h-10 md:text-base'
const SELECT = 'w-full [&_select]:h-11 [&_select]:text-base lg:[&_select]:h-10'

function useRun() {
  const router = useRouter()
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  async function run(call: (key: Key) => Promise<RiskAdminOutcome>): Promise<RiskAdminOutcome> {
    setPending(true)
    let outcome: RiskAdminOutcome
    try {
      outcome = await call(submission.key)
      submission.next()
    } catch {
      outcome = { ok: false, code: 'NO_ANSWER' }
    }
    setPending(false)
    if (outcome.ok) router.refresh()
    return outcome
  }
  return { pending, run }
}

function useFailureText() {
  const t = useSay('risk.admin.errors')
  return (o: RiskAdminOutcome) => {
    if (o.ok) return ''
    const key = o.reason && t.has(`reason.${o.reason}`) ? `reason.${o.reason}` : t.has(`code.${o.code}`) ? `code.${o.code}` : 'code.FAILED'
    return t(key)
  }
}

// ---------- the versions ----------

export function VersionList({ versions, defaultCode, draft }: { versions: readonly VersionUi[]; defaultCode: string | null; draft: QuestionnaireActions['draft'] }) {
  const t = useSay('risk.admin.questionnaire')
  const failureText = useFailureText()
  const router = useRouter()
  const id = useId()
  const drafting = useRun()
  const [code, setCode] = useState(defaultCode ?? '')
  const [failure, setFailure] = useState<string | null>(null)

  async function onDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    const outcome = await drafting.run((key) => draft(code.trim().toUpperCase(), key))
    if (outcome.ok && outcome.id) router.push(`/admin/risk/questionnaire/${outcome.id}`)
    else if (!outcome.ok) setFailure(failureText(outcome))
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={(e) => void onDraft(e)} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        {defaultCode === null ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-code`} className="text-base">
              {t('code')}
            </Label>
            <Input id={`${id}-code`} value={code} onChange={(e) => setCode(e.target.value)} required aria-describedby={`${id}-code-hint`} className={CONTROL} />
            <p id={`${id}-code-hint`} className="text-ink-muted">
              {t('codeHint')}
            </p>
          </div>
        ) : null}
        <Button type="submit" className="min-h-11 self-start lg:min-h-10" disabled={drafting.pending}>
          <Plus aria-hidden="true" />
          {defaultCode ? t('draftFrom', { code: defaultCode }) : t('draftNew')}
        </Button>
      </form>
      {failure ? <Notice tone="danger">{failure}</Notice> : null}
      {versions.length === 0 ? (
        <ListEmpty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <ul aria-label={t('versions')} className="flex flex-col divide-y divide-line border-y border-line">
          {versions.map((v) => (
            <li key={v.id} className="flex flex-col gap-1.5 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-1">
                <Link href={`/admin/risk/questionnaire/${v.id}`} className="font-medium text-primary underline-offset-4 hover:underline">
                  {t('versionName', { code: v.code, no: v.versionNo })}
                </Link>
                <span className="text-ink-muted">{t('versionMeta', { effective: v.effectiveText, count: v.questions })}</span>
                {v.publishedByName ? <span className="text-ink-muted">{t('byline', { submitted: v.submittedByName ?? '-', published: v.publishedByName })}</span> : null}
              </div>
              <StatusBadge look={STATUS_LOOK[v.status]} label={t(`status.${v.status}`)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---------- one version ----------

export function VersionEditor({ detail, actions, domainName, tierName }: { detail: VersionDetailUi; actions: QuestionnaireActions; domainName: Readonly<Record<RiskDomainUi, string>>; tierName: Readonly<Record<RiskTierCodeUi, string>> }) {
  const t = useSay('risk.admin.questionnaire')
  const failureText = useFailureText()
  const working = useRun()
  const [editing, setEditing] = useState<{ question: QuestionUi; isNew: boolean } | null>(null)
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const draft = detail.status === 'DRAFT'
  const codes = detail.questionList.map((q) => q.code)

  async function act(call: (key: Key) => Promise<RiskAdminOutcome>, done: string) {
    setMessage(null)
    const outcome = await working.run(call)
    setMessage(outcome.ok ? { tone: 'success', text: done } : { tone: 'danger', text: failureText(outcome) })
  }

  const move = (index: number, by: -1 | 1) => {
    const next = codes.slice()
    const [code] = next.splice(index, 1)
    next.splice(index + by, 0, code!)
    void act((key) => actions.reorder(detail.id, detail.version, next, key), t('reordered'))
  }

  const blank: QuestionUi = { code: '', domain: 'GENERAL', textTh: '', textEn: '', helpTh: null, helpEn: null, options: [{ code: 'Y', labelTh: '', labelEn: '', points: 0 }, { code: 'N', labelTh: '', labelEn: '', points: 0 }], appliesWhen: null, required: true, evidenceScopeRequired: false, evidenceScope: null, aiReadable: false }

  return (
    <div className="flex flex-col gap-4">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {draft ? (
        <Button className="min-h-11 self-start lg:min-h-10" onClick={() => setEditing({ question: blank, isNew: true })}>
          <Plus aria-hidden="true" />
          {t('addQuestion')}
        </Button>
      ) : (
        <p className="text-ink-muted">{t('readOnly')}</p>
      )}
      {detail.questionList.length === 0 ? (
        <ListEmpty title={t('noQuestions')} hint={t('noQuestionsHint')} />
      ) : (
        <ol aria-label={t('questions')} className="flex flex-col divide-y divide-line border-y border-line">
          {detail.questionList.map((q, i) => (
            <li key={q.code} className="flex flex-col gap-2 py-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium tabular">{q.code}</span>
                <span className="text-ink-muted">{domainName[q.domain]}</span>
                {!q.required ? <span className="text-ink-muted">{t('optional')}</span> : null}
                {q.evidenceScopeRequired ? <span className="text-ink-muted">{t('scopeShort', { scope: q.evidenceScope ?? '-' })}</span> : null}
                {q.aiReadable ? <span className="text-ink-muted">{t('aiReadableShort')}</span> : null}
              </div>
              <p>{q.textTh}</p>
              <p className="text-ink-muted">{q.options.map((o) => `${o.labelTh} (${t('pointsShort', { count: o.points })}${o.minTier ? ` · ${t('floorShort', { tier: tierName[o.minTier] })}` : ''}${o.evidence ? ` · ${t('evidenceShort')}` : ''})`).join(' · ')}</p>
              {q.appliesWhen ? <p className="text-ink-muted">{t('whenShort', { when: conditionText(q.appliesWhen, t) })}</p> : null}
              {draft ? (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" className="min-h-11 lg:min-h-10" onClick={() => setEditing({ question: q, isNew: false })} aria-label={t('editOf', { code: q.code })}>
                    {t('edit')}
                  </Button>
                  <Button variant="outline" className="min-h-11 lg:min-h-10" disabled={i === 0 || working.pending} onClick={() => move(i, -1)} aria-label={t('upOf', { code: q.code })}>
                    <ArrowUp aria-hidden="true" />
                    {t('up')}
                  </Button>
                  <Button variant="outline" className="min-h-11 lg:min-h-10" disabled={i === codes.length - 1 || working.pending} onClick={() => move(i, 1)} aria-label={t('downOf', { code: q.code })}>
                    <ArrowDown aria-hidden="true" />
                    {t('down')}
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="outline" className="min-h-11 lg:min-h-10" disabled={working.pending} aria-label={t('removeOf', { code: q.code })}>
                        <Trash2 aria-hidden="true" />
                        {t('remove')}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t('removeTitle', { code: q.code })}</AlertDialogTitle>
                        <AlertDialogDescription>{t('removeBody')}</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel className="min-h-11 text-base">{t('keep')}</AlertDialogCancel>
                        <AlertDialogAction className="min-h-11 text-base" onClick={() => void act((key) => actions.removeQuestion(detail.id, detail.version, q.code, key), t('removed', { code: q.code }))}>
                          {t('remove')}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {editing ? (
        <QuestionDialog
          key={editing.question.code || 'new'}
          initial={editing.question}
          isNew={editing.isNew}
          domainName={domainName}
          tierName={tierName}
          save={(q, key) => actions.updateQuestion(detail.id, detail.version, q, key)}
          onClose={() => setEditing(null)}
          onSaved={(code) => {
            setEditing(null)
            setMessage({ tone: 'success', text: t('saved', { code }) })
          }}
        />
      ) : null}
    </div>
  )
}

/** A condition in words; a shape the simple editor cannot show is still read out */
function conditionText(c: ConditionUi, t: Say): string {
  if ('all' in c) return c.all.map((x) => conditionText(x, t)).join(` ${t('and')} `)
  if ('any' in c) return c.any.map((x) => conditionText(x, t)).join(` ${t('or')} `)
  const field = t.has(`fieldsWhen.${c.field}`) ? t(`fieldsWhen.${c.field}`) : c.field
  const word = (v: unknown) => (t.has(`values.${String(v)}`) ? t(`values.${String(v)}`) : String(v ?? ''))
  const value = Array.isArray(c.value) ? c.value.map(word).join(', ') : word(c.value)
  return `${field} ${t.has(`ops.${c.op}`) ? t(`ops.${c.op}`) : c.op} ${value}`
}

// ---------- the question form: three steps on tabs ----------

const WHEN_FIELDS = [...SCREENING_KEYS, '$category', '$payeeType', '$isForeign', '$inherentTier'] as const
type WhenField = (typeof WHEN_FIELDS)[number]
interface SimpleWhen {
  readonly join: 'all' | 'any'
  readonly parts: readonly { readonly field: WhenField; readonly value: string }[]
}

/** The one-level condition the editor shows, or null when the stored one has another shape */
function simpleOf(c: ConditionUi | null): SimpleWhen | null {
  if (c === null) return { join: 'all', parts: [] }
  const leaves = 'all' in c ? c.all : 'any' in c ? c.any : [c]
  const parts: { field: WhenField; value: string }[] = []
  for (const l of leaves) {
    if ('all' in l || 'any' in l || !(WHEN_FIELDS as readonly string[]).includes(l.field)) return null
    const expected = l.field === '$category' ? 'anyIn' : 'eq'
    if (l.op !== expected) return null
    parts.push({ field: l.field as WhenField, value: Array.isArray(l.value) ? l.value.join(', ') : String(l.value) })
  }
  return { join: 'any' in c ? 'any' : 'all', parts }
}

function conditionOf(w: SimpleWhen): ConditionUi | null {
  const leaves: ConditionUi[] = w.parts.map((p) =>
    p.field === '$category'
      ? { field: p.field, op: 'anyIn', value: p.value.split(/[\s,]+/).map((v) => v.trim().toUpperCase()).filter((v) => v !== '') }
      : p.field === '$isForeign'
        ? { field: p.field, op: 'eq', value: p.value === 'true' }
        : { field: p.field, op: 'eq', value: p.value },
  )
  if (leaves.length === 0) return null
  if (leaves.length === 1) return leaves[0]!
  return w.join === 'all' ? { all: leaves } : { any: leaves }
}

const VALUE_CHOICES: Record<WhenField, readonly string[] | null> = {
  processesPersonalData: ['Y', 'N'],
  accessesSystems: ['Y', 'N'],
  accessesPremises: ['Y', 'N'],
  $category: null,
  $payeeType: ['JURISTIC', 'INDIVIDUAL', 'FOREIGN'],
  $isForeign: ['true', 'false'],
  $inherentTier: RISK_TIERS,
}

function QuestionDialog({
  initial,
  isNew,
  domainName,
  tierName,
  save,
  onClose,
  onSaved,
}: {
  initial: QuestionUi
  isNew: boolean
  domainName: Readonly<Record<RiskDomainUi, string>>
  tierName: Readonly<Record<RiskTierCodeUi, string>>
  save: (q: QuestionUi, key: Key) => Promise<RiskAdminOutcome>
  onClose: () => void
  onSaved: (code: string) => void
}) {
  const t = useSay('risk.admin.questionnaire.form')
  const tq = useSay('risk.admin.questionnaire')
  const failureText = useFailureText()
  const id = useId()
  const saving = useRun()
  const [q, setQ] = useState<QuestionUi>(initial)
  const [when, setWhen] = useState<SimpleWhen | null>(() => simpleOf(initial.appliesWhen))
  const [failure, setFailure] = useState<string | null>(null)
  const set = <K extends keyof QuestionUi>(k: K, v: QuestionUi[K]) => setQ((old) => ({ ...old, [k]: v }))
  const setOption = (i: number, patch: Partial<OptionUi>) => set('options', q.options.map((o, j) => (j === i ? { ...o, ...patch } : o)))

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    const question: QuestionUi = { ...q, code: q.code.trim().toUpperCase(), appliesWhen: when ? conditionOf(when) : initial.appliesWhen, evidenceScope: q.evidenceScopeRequired ? q.evidenceScope : q.evidenceScope || null }
    const outcome = await saving.run((key) => save(question, key))
    if (outcome.ok) onSaved(question.code)
    else setFailure(failureText(outcome))
  }

  const text = (name: 'code' | 'textTh' | 'textEn' | 'helpTh' | 'helpEn', options: { multiline?: boolean; required?: boolean; disabled?: boolean; hint?: string } = {}) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${id}-${name}`} className="text-base">
        {t(name)}
      </Label>
      {options.multiline ? (
        <Textarea id={`${id}-${name}`} value={q[name] ?? ''} onChange={(e) => set(name, e.target.value)} required={options.required} className="min-h-20 bg-bg text-base md:text-base" />
      ) : (
        <Input id={`${id}-${name}`} value={q[name] ?? ''} onChange={(e) => set(name, e.target.value)} required={options.required} disabled={options.disabled} aria-describedby={options.hint ? `${id}-${name}-hint` : undefined} className={CONTROL} />
      )}
      {options.hint ? (
        <p id={`${id}-${name}-hint`} className="text-ink-muted">
          {options.hint}
        </p>
      ) : null}
    </div>
  )

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isNew ? t('titleNew') : t('titleEdit', { code: initial.code })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form id={`${id}-form`} onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
          <Tabs defaultValue="words">
            <TabsList aria-label={t('steps')}>
              <TabsTrigger value="words" className="min-h-11 text-base lg:min-h-9">
                {t('stepWords')}
              </TabsTrigger>
              <TabsTrigger value="options" className="min-h-11 text-base lg:min-h-9">
                {t('stepOptions')}
              </TabsTrigger>
              <TabsTrigger value="when" className="min-h-11 text-base lg:min-h-9">
                {t('stepWhen')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="words" className="flex flex-col gap-3 pt-2">
              {text('code', { required: true, disabled: !isNew, hint: t('codeHint') })}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-domain`} className="text-base">
                  {t('domain')}
                </Label>
                <NativeSelect id={`${id}-domain`} value={q.domain} onChange={(e) => set('domain', e.target.value as RiskDomainUi)} className={SELECT}>
                  {RISK_DOMAINS_UI.map((d) => (
                    <NativeSelectOption key={d} value={d}>
                      {domainName[d]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              {text('textTh', { multiline: true, required: true })}
              {text('textEn', { multiline: true, required: true })}
              {text('helpTh', { multiline: true })}
              {text('helpEn', { multiline: true })}
            </TabsContent>
            <TabsContent value="options" className="flex flex-col gap-3 pt-2">
              <p className="text-ink-muted">{t('optionsHint')}</p>
              {q.options.map((o, i) => (
                <fieldset key={i} className="flex flex-col gap-2 border-b border-line pb-3">
                  <legend className="mb-1 font-medium">{t('optionN', { n: i + 1 })}</legend>
                  <div className="grid gap-2 sm:grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)_6rem]">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`${id}-o${i}-code`}>{t('optionCode')}</Label>
                      <Input id={`${id}-o${i}-code`} value={o.code} onChange={(e) => setOption(i, { code: e.target.value.toUpperCase() })} required className={CONTROL} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`${id}-o${i}-th`}>{t('optionLabelTh')}</Label>
                      <Input id={`${id}-o${i}-th`} value={o.labelTh} onChange={(e) => setOption(i, { labelTh: e.target.value })} required className={CONTROL} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`${id}-o${i}-en`}>{t('optionLabelEn')}</Label>
                      <Input id={`${id}-o${i}-en`} value={o.labelEn} onChange={(e) => setOption(i, { labelEn: e.target.value })} required className={CONTROL} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`${id}-o${i}-pts`}>{t('optionPoints')}</Label>
                      <Input id={`${id}-o${i}-pts`} type="number" inputMode="numeric" min={0} value={o.points} onChange={(e) => setOption(i, { points: Number(e.target.value) })} className={`${CONTROL} tabular`} />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`${id}-o${i}-floor`}>{t('optionFloor')}</Label>
                      <NativeSelect id={`${id}-o${i}-floor`} value={o.minTier ?? ''} onChange={(e) => setOption(i, { minTier: e.target.value === '' ? undefined : (e.target.value as RiskTierCodeUi) })} className={SELECT}>
                        <NativeSelectOption value="">{t('noFloor')}</NativeSelectOption>
                        {RISK_TIERS.map((c) => (
                          <NativeSelectOption key={c} value={c}>
                            {tierName[c]}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                    <div className="flex min-h-11 items-center gap-2">
                      <Checkbox id={`${id}-o${i}-ev`} checked={o.evidence === true} onCheckedChange={(v) => set('options', q.options.map((x, j) => ({ ...x, evidence: j === i ? v === true : v === true ? false : x.evidence })))} />
                      <Label htmlFor={`${id}-o${i}-ev`} className="text-base">
                        {t('optionEvidence')}
                      </Label>
                    </div>
                    {q.options.length > 2 ? (
                      <Button type="button" variant="outline" className="min-h-11 lg:min-h-10" onClick={() => set('options', q.options.filter((_, j) => j !== i))} aria-label={t('removeOptionN', { n: i + 1 })}>
                        <Trash2 aria-hidden="true" />
                        {t('removeOption')}
                      </Button>
                    ) : null}
                  </div>
                </fieldset>
              ))}
              {q.options.length < 10 ? (
                <Button type="button" variant="outline" className="min-h-11 self-start lg:min-h-10" onClick={() => set('options', [...q.options, { code: '', labelTh: '', labelEn: '', points: 0 }])}>
                  <Plus aria-hidden="true" />
                  {t('addOption')}
                </Button>
              ) : null}
            </TabsContent>
            <TabsContent value="when" className="flex flex-col gap-3 pt-2">
              {when === null ? (
                <Notice tone="info">{t('whenComplex', { when: initial.appliesWhen ? conditionText(initial.appliesWhen, tq) : '' })}</Notice>
              ) : (
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1 font-medium">{t('when')}</legend>
                  <p className="text-ink-muted">{t('whenHint')}</p>
                  {when.parts.length > 1 ? (
                    <NativeSelect aria-label={t('whenJoin')} value={when.join} onChange={(e) => setWhen({ ...when, join: e.target.value === 'any' ? 'any' : 'all' })} className={SELECT}>
                      <NativeSelectOption value="all">{t('joinAll')}</NativeSelectOption>
                      <NativeSelectOption value="any">{t('joinAny')}</NativeSelectOption>
                    </NativeSelect>
                  ) : null}
                  {when.parts.map((p, i) => (
                    <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                      <NativeSelect aria-label={t('whenField', { n: i + 1 })} value={p.field} onChange={(e) => setWhen({ ...when, parts: when.parts.map((x, j) => (j === i ? { field: e.target.value as WhenField, value: VALUE_CHOICES[e.target.value as WhenField]?.[0] ?? '' } : x)) })} className={SELECT}>
                        {WHEN_FIELDS.map((f) => (
                          <NativeSelectOption key={f} value={f}>
                            {tq(`fieldsWhen.${f}`)}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      {VALUE_CHOICES[p.field] ? (
                        <NativeSelect aria-label={t('whenValue', { n: i + 1 })} value={p.value} onChange={(e) => setWhen({ ...when, parts: when.parts.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} className={SELECT}>
                          {VALUE_CHOICES[p.field]!.map((v) => (
                            <NativeSelectOption key={v} value={v}>
                              {tq.has(`values.${v}`) ? tq(`values.${v}`) : v}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      ) : (
                        <Input aria-label={t('whenCategories', { n: i + 1 })} value={p.value} onChange={(e) => setWhen({ ...when, parts: when.parts.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} className={CONTROL} />
                      )}
                      <Button type="button" variant="outline" className="min-h-11 lg:min-h-10" onClick={() => setWhen({ ...when, parts: when.parts.filter((_, j) => j !== i) })} aria-label={t('removeWhenN', { n: i + 1 })}>
                        <Trash2 aria-hidden="true" />
                        {t('removeWhen')}
                      </Button>
                    </div>
                  ))}
                  <Button type="button" variant="outline" className="min-h-11 self-start lg:min-h-10" onClick={() => setWhen({ ...when, parts: [...when.parts, { field: 'processesPersonalData', value: 'Y' }] })}>
                    <Plus aria-hidden="true" />
                    {t('addWhen')}
                  </Button>
                </fieldset>
              )}
              <div className="flex min-h-11 items-center gap-3">
                <Switch id={`${id}-required`} checked={q.required} onCheckedChange={(v) => set('required', v)} />
                <Label htmlFor={`${id}-required`} className="text-base">
                  {t('required')}
                </Label>
              </div>
              <div className="flex min-h-11 items-center gap-3">
                <Switch id={`${id}-scopeRequired`} checked={q.evidenceScopeRequired} onCheckedChange={(v) => set('evidenceScopeRequired', v)} />
                <Label htmlFor={`${id}-scopeRequired`} className="text-base">
                  {t('evidenceScopeRequired')}
                </Label>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-scope`} className="text-base">
                  {t('evidenceScope')}
                </Label>
                <Input id={`${id}-scope`} value={q.evidenceScope ?? ''} onChange={(e) => set('evidenceScope', e.target.value)} aria-describedby={`${id}-scope-hint`} className={CONTROL} />
                <p id={`${id}-scope-hint`} className="text-ink-muted">
                  {t('evidenceScopeHint')}
                </p>
              </div>
              <div className="flex min-h-11 items-center gap-3">
                <Switch id={`${id}-ai`} checked={q.aiReadable} onCheckedChange={(v) => set('aiReadable', v)} aria-describedby={`${id}-ai-hint`} />
                <Label htmlFor={`${id}-ai`} className="text-base">
                  {t('aiReadable')}
                </Label>
              </div>
              <p id={`${id}-ai-hint`} className="text-ink-muted">
                {t('aiReadableHint')}
              </p>
            </TabsContent>
          </Tabs>
          {failure ? <Notice tone="danger">{failure}</Notice> : null}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" className="min-h-11 lg:min-h-10" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form={`${id}-form`} className="min-h-11 lg:min-h-10" disabled={saving.pending} aria-busy={saving.pending || undefined}>
            {saving.pending ? t('saving') : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------- the lint, the dry-run and the decisions ----------

export function LintPanel({ lint }: { lint: VersionDetailUi['lint'] }) {
  const t = useSay('risk.admin.questionnaire.lint')
  const line = (i: LintIssueUi) => t(`issue.${i.code}`, { question: i.question ?? '-', type: i.documentType ?? '-', reason: t.has(`reason.${i.reason}`) ? t(`reason.${i.reason}`) : i.reason })
  if (lint.errors.length === 0 && lint.warnings.length === 0) return <Notice tone="success">{t('clean')}</Notice>
  return (
    <div className="flex flex-col gap-2">
      {lint.errors.length > 0 ? (
        <Notice tone="danger">
          <span className="font-medium">{t('errors', { count: lint.errors.length })}</span>
          <ul className="list-disc pl-5">
            {lint.errors.map((i, n) => (
              <li key={n}>{line(i)}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {lint.warnings.length > 0 ? (
        <Notice tone="warning">
          <span className="font-medium">{t('warnings', { count: lint.warnings.length })}</span>
          <ul className="list-disc pl-5">
            {lint.warnings.map((i, n) => (
              <li key={n}>{line(i)}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </div>
  )
}

export function PreviewPanel({ versionId, preview, tierName }: { versionId: string; preview: QuestionnaireActions['preview']; tierName: Readonly<Record<RiskTierCodeUi, string>> }) {
  const t = useSay('risk.admin.questionnaire.preview')
  const tq = useSay('risk.admin.questionnaire')
  const failureText = useFailureText()
  const id = useId()
  const [input, setInput] = useState<PreviewInputUi>({ screening: { processesPersonalData: 'N', accessesSystems: 'N', accessesPremises: 'N' }, categoryCodes: [], payeeType: 'JURISTIC', isForeign: false })
  const [categories, setCategories] = useState('')
  const [result, setResult] = useState<PreviewOutcome | null>(null)
  const [busy, setBusy] = useState(false)

  async function onRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    try {
      setResult(await preview(versionId, { ...input, categoryCodes: categories.split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter((c) => c !== '') }))
    } catch {
      setResult({ ok: false, code: 'NO_ANSWER' })
    }
    setBusy(false)
  }

  return (
    <form onSubmit={(e) => void onRun(e)} className="flex flex-col gap-3">
      <p className="text-ink-muted">{t('intro')}</p>
      {SCREENING_KEYS.map((k) => (
        <div key={k} className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-${k}`} className="text-base">
            {tq(`fieldsWhen.${k}`)}
          </Label>
          <NativeSelect id={`${id}-${k}`} value={input.screening[k]} onChange={(e) => setInput({ ...input, screening: { ...input.screening, [k]: e.target.value === 'Y' ? 'Y' : 'N' } })} className={SELECT}>
            <NativeSelectOption value="N">{tq('values.N')}</NativeSelectOption>
            <NativeSelectOption value="Y">{tq('values.Y')}</NativeSelectOption>
          </NativeSelect>
        </div>
      ))}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-cat`} className="text-base">
          {tq('fieldsWhen.$category')}
        </Label>
        <Input id={`${id}-cat`} value={categories} onChange={(e) => setCategories(e.target.value)} className={CONTROL} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-payee`} className="text-base">
          {tq('fieldsWhen.$payeeType')}
        </Label>
        <NativeSelect id={`${id}-payee`} value={input.payeeType} onChange={(e) => setInput({ ...input, payeeType: e.target.value as PreviewInputUi['payeeType'], isForeign: e.target.value === 'FOREIGN' })} className={SELECT}>
          {(['JURISTIC', 'INDIVIDUAL', 'FOREIGN'] as const).map((p) => (
            <NativeSelectOption key={p} value={p}>
              {tq(`values.${p}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <Button type="submit" variant="outline" className="min-h-11 self-start lg:min-h-10" disabled={busy}>
        {t('run')}
      </Button>
      {result ? (
        result.ok ? (
          <div className="flex flex-col gap-1" aria-live="polite">
            <span>{t('tier', { tier: tierName[result.inherentTier] })}</span>
            <span>{result.questions.length > 0 ? t('questions', { count: result.questions.length, codes: result.questions.join(', ') }) : t('noneAsked')}</span>
          </div>
        ) : (
          <Notice tone="danger">{failureText(result)}</Notice>
        )
      ) : null}
    </form>
  )
}

export function DecisionPanel({ detail, actions, today }: { detail: VersionDetailUi; actions: QuestionnaireActions; today: string }) {
  const t = useSay('risk.admin.questionnaire.decide')
  const failureText = useFailureText()
  const id = useId()
  const working = useRun()
  const [date, setDate] = useState(today)
  const [reason, setReason] = useState('')
  const [returnReason, setReturnReason] = useState('')
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)

  async function act(call: (key: Key) => Promise<RiskAdminOutcome>, done: string) {
    setMessage(null)
    const outcome = await working.run(call)
    setMessage(outcome.ok ? { tone: 'success', text: done } : { tone: 'danger', text: failureText(outcome) })
  }

  if (detail.status === 'DRAFT') {
    return (
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void act((key) => actions.submit(detail.id, detail.version, date, reason, key), t('submitted'))
        }}
      >
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-date`} className="text-base">
            {t('effectiveDate')}
          </Label>
          <Input id={`${id}-date`} type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} required className={CONTROL} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-reason`} className="text-base">
            {t('changeReason')}
          </Label>
          <Textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} required className="min-h-20 bg-bg text-base md:text-base" />
        </div>
        <Button type="submit" className="min-h-11 self-start lg:min-h-10" disabled={working.pending || detail.lint.errors.length > 0}>
          {t('submit')}
        </Button>
        {detail.lint.errors.length > 0 ? <p className="text-ink-muted">{t('fixLintFirst')}</p> : null}
      </form>
    )
  }
  if (detail.status !== 'PENDING_PUBLISH') return null
  if (detail.submittedByMe) return <p className="text-ink-muted">{t('sentByYou')}</p>
  return (
    <div className="flex flex-col gap-3">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {detail.changeReason ? <p>{t('reasonGiven', { reason: detail.changeReason })}</p> : null}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button className="min-h-11 self-start lg:min-h-10" disabled={working.pending}>
            {t('publish')}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('publishTitle', { no: detail.versionNo })}</AlertDialogTitle>
            <AlertDialogDescription>{t('publishBody', { effective: detail.effectiveText })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11 text-base">{t('keep')}</AlertDialogCancel>
            <AlertDialogAction className="min-h-11 text-base" onClick={() => void act((key) => actions.publish(detail.id, detail.version, key), t('published'))}>
              {t('publish')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <form
        className="mt-4 flex flex-col gap-2 border-t border-line pt-4"
        onSubmit={(e) => {
          e.preventDefault()
          void act((key) => actions.reject(detail.id, detail.version, returnReason, key), t('rejected'))
        }}
      >
        <Label htmlFor={`${id}-return`} className="text-base">
          {t('returnReason')}
        </Label>
        <Textarea id={`${id}-return`} value={returnReason} onChange={(e) => setReturnReason(e.target.value)} required className="min-h-20 bg-bg text-base md:text-base" />
        <Button type="submit" variant="outline" className="min-h-11 self-start lg:min-h-10" disabled={working.pending}>
          {t('reject')}
        </Button>
      </form>
    </div>
  )
}
