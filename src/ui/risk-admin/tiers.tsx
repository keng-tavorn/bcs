'use client'

import { useFailureText, useRun } from './run'
import { useSay } from './say'
import { useId, useState, type FormEvent } from 'react'
import { StatusBadge } from '../document/badges'
import type { BadgeLook } from '../document/badge-looks'
import { Notice } from '../form/notice'
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../shadcn/dialog'
import { Input } from '../shadcn/input'
import { Label } from '../shadcn/label'
import { NativeSelect, NativeSelectOption } from '../shadcn/native-select'
import { Switch } from '../shadcn/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../shadcn/tabs'
import { RISK_TIERS, SCREENING_KEYS, type RiskAdminOutcome, type RiskTierCodeUi, type ScreeningKey, type TierChangeInput, type TierValues } from './model'

// /admin/risk/tiers (S11-04 · BR-RSK-02 · ADR-229): the three tiers and the gate policy in effect, each with the change
// that waits for someone else to confirm it. A member proposes in a Dialog (the three tiers on tabs, five fields each;
// the policy on seven), another member confirms in an AlertDialog, and either discards. The one who proposed sees why
// they cannot confirm (the service refuses SAME_EDITOR anyway). The engine and the PO gate read only the values in
// effect, so the page says so next to every pending value. Phones get a list instead of the tables (§9.9).

export interface TierRowUi {
  readonly code: RiskTierCodeUi
  /** In the reader's language */
  readonly name: string
  readonly inEffect: TierValues
  readonly pending: TierChangeInput | null
  /** "เสนอโดย … · …" */
  readonly pendingText: string | null
  readonly pendingByMe: boolean
  readonly version: number
}

export interface PolicyValuesUi {
  readonly screeningTierMap: Readonly<Record<ScreeningKey, RiskTierCodeUi>>
  readonly highRiskCategories: readonly string[]
  readonly registryFlagBlocks: boolean
  readonly mediumOverdueBlocks: boolean
  readonly overrideChatButton: boolean
}

export interface PolicyUi {
  readonly inEffect: PolicyValuesUi
  readonly confirmed: boolean
  readonly pending: Partial<PolicyValuesUi> | null
  readonly pendingText: string | null
  readonly pendingByMe: boolean
  readonly version: number
}

export interface TierActions {
  readonly proposeTiers: (changes: Partial<Record<RiskTierCodeUi, TierChangeInput>>, key: string) => Promise<RiskAdminOutcome>
  readonly confirmTiers: (rows: { code: RiskTierCodeUi; version: number }[], key: string) => Promise<RiskAdminOutcome>
  readonly discardTiers: (rows: { code: RiskTierCodeUi; version: number }[], key: string) => Promise<RiskAdminOutcome>
  readonly proposePolicy: (changes: Partial<PolicyValuesUi>, key: string) => Promise<RiskAdminOutcome>
  readonly confirmPolicy: (version: number, key: string) => Promise<RiskAdminOutcome>
  readonly discardPolicy: (version: number, key: string) => Promise<RiskAdminOutcome>
}

const IN_EFFECT: BadgeLook = { tone: 'ok', icon: 'CircleCheck' }
const WAITING: BadgeLook = { tone: 'warn', icon: 'Hourglass' }
const TIER_LOOK: Record<RiskTierCodeUi, BadgeLook> = { LOW: { tone: 'neutral', icon: 'CircleDot' }, MEDIUM: { tone: 'warn', icon: 'Gauge' }, HIGH: { tone: 'danger', icon: 'Lock' } }
const CONTROL = 'h-11 bg-bg text-base lg:h-10 md:text-base'
const FIELDS = ['minPoints', 'reviewMonths', 'reminderDaysBefore', 'blocksPo', 'requiresExplicitAnswers'] as const



export function TiersPanel({ tiers, actions }: { tiers: readonly TierRowUi[]; actions: TierActions }) {
  const t = useSay('risk.admin.tiers')
  const failureText = useFailureText()
  const deciding = useRun()
  const [editing, setEditing] = useState(false)
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const pending = tiers.filter((r) => r.pending !== null)
  const pendingRows = pending.map((r) => ({ code: r.code, version: r.version }))
  const mine = pending.some((r) => r.pendingByMe)

  async function decide(kind: 'confirm' | 'discard') {
    setMessage(null)
    const outcome = await deciding.run((key) => (kind === 'confirm' ? actions.confirmTiers(pendingRows, key) : actions.discardTiers(pendingRows, key)))
    setMessage(outcome.ok ? { tone: 'success', text: t(kind === 'confirm' ? 'confirmed' : 'discarded') } : { tone: 'danger', text: failureText(outcome) })
  }

  const value = (field: (typeof FIELDS)[number], v: number | boolean | undefined) =>
    v === undefined ? null : typeof v === 'boolean' ? t(v ? 'yes' : 'no') : field === 'minPoints' ? t('points', { count: v }) : field === 'reviewMonths' ? t('months', { count: v }) : t('days', { count: v })

  const pendingCell = (row: TierRowUi) =>
    row.pending ? (
      <div className="flex flex-col items-start gap-1">
        <StatusBadge look={WAITING} label={t('waiting')} />
        <ul className="flex flex-col gap-0.5">
          {FIELDS.filter((f) => row.pending![f] !== undefined).map((f) => (
            <li key={f}>{`${t(`fields.${f}`)}: ${value(f, row.pending![f])}`}</li>
          ))}
        </ul>
        {row.pendingText ? <span className="text-ink-muted">{row.pendingText}</span> : null}
      </div>
    ) : (
      <StatusBadge look={IN_EFFECT} label={t('inEffect')} />
    )

  return (
    <div className="flex flex-col gap-3">
      <p className="text-ink-muted">{t('engineReadsEffective')}</p>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <Table aria-label={t('list')} className="hidden text-base md:table md:text-sm">
        <TableHeader>
          <TableRow>
            <TableHead>{t('columns.tier')}</TableHead>
            {FIELDS.map((f) => (
              <TableHead key={f} className={f === 'blocksPo' || f === 'requiresExplicitAnswers' ? '' : 'text-right'}>
                {t(`fields.${f}`)}
              </TableHead>
            ))}
            <TableHead>{t('columns.pending')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tiers.map((row) => (
            <TableRow key={row.code}>
              <TableCell className="align-top">
                <StatusBadge look={TIER_LOOK[row.code]} label={row.name} />
              </TableCell>
              {FIELDS.map((f) => (
                <TableCell key={f} className={`tabular align-top ${f === 'blocksPo' || f === 'requiresExplicitAnswers' ? '' : 'text-right'}`}>
                  {value(f, row.inEffect[f])}
                </TableCell>
              ))}
              <TableCell className="align-top whitespace-normal">{pendingCell(row)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ul aria-label={t('list')} className="flex flex-col divide-y divide-line border-y border-line md:hidden">
        {tiers.map((row) => (
          <li key={row.code} className="flex flex-col gap-1.5 py-3">
            <StatusBadge look={TIER_LOOK[row.code]} label={row.name} />
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
              {FIELDS.map((f) => (
                <div key={f} className="contents">
                  <dt className="text-ink-muted">{t(`fields.${f}`)}</dt>
                  <dd className="tabular text-right">{value(f, row.inEffect[f])}</dd>
                </div>
              ))}
            </dl>
            {pendingCell(row)}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {pending.length === 0 ? (
          <Button className="min-h-11 lg:min-h-10" onClick={() => setEditing(true)}>
            {t('propose')}
          </Button>
        ) : (
          <>
            {mine ? <span className="text-ink-muted">{t('proposedByYou')}</span> : <ConfirmButton label={t('confirm')} title={t('confirmTitle')} body={t('confirmBody')} keep={t('keep')} busy={deciding.pending} onConfirm={() => void decide('confirm')} />}
            <Button variant="outline" className="min-h-11 lg:min-h-10" disabled={deciding.pending} onClick={() => void decide('discard')}>
              {t('discard')}
            </Button>
          </>
        )}
      </div>
      {editing ? (
        <TierDialog
          tiers={tiers}
          propose={actions.proposeTiers}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            setMessage({ tone: 'success', text: t('proposed') })
          }}
        />
      ) : null}
    </div>
  )
}

function ConfirmButton({ label, title, body, keep, busy, onConfirm }: { label: string; title: string; body: string; keep: string; busy: boolean; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button className="min-h-11 lg:min-h-10" disabled={busy}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11 text-base">{keep}</AlertDialogCancel>
          <AlertDialogAction className="min-h-11 text-base" onClick={onConfirm}>
            {label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function TierDialog({ tiers, propose, onClose, onSaved }: { tiers: readonly TierRowUi[]; propose: TierActions['proposeTiers']; onClose: () => void; onSaved: () => void }) {
  const t = useSay('risk.admin.tiers')
  const failureText = useFailureText()
  const id = useId()
  const saving = useRun()
  const [values, setValues] = useState<Record<RiskTierCodeUi, TierValues>>(() => Object.fromEntries(tiers.map((r) => [r.code, { ...r.inEffect }])) as Record<RiskTierCodeUi, TierValues>)
  const [failure, setFailure] = useState<string | null>(null)
  const set = (code: RiskTierCodeUi, field: (typeof FIELDS)[number], v: number | boolean) => setValues((old) => ({ ...old, [code]: { ...old[code], [field]: v } }))

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    // only what differs from the value in effect is proposed
    // an emptied number is not a value: say so instead of proposing 0
    if (tiers.some((r) => (['minPoints', 'reviewMonths', 'reminderDaysBefore'] as const).some((f) => !Number.isInteger(values[r.code][f])))) {
      setFailure(t('numbersRequired'))
      return
    }
    const changes: Partial<Record<RiskTierCodeUi, TierChangeInput>> = {}
    for (const row of tiers) {
      const diff: Record<string, number | boolean> = {}
      for (const f of FIELDS) if (values[row.code][f] !== row.inEffect[f]) diff[f] = values[row.code][f]
      if (Object.keys(diff).length > 0) changes[row.code] = diff as TierChangeInput
    }
    const outcome = await saving.run((key) => propose(changes, key))
    if (outcome.ok) onSaved()
    else setFailure(failureText(outcome))
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('dialogTitle')}</DialogTitle>
          <DialogDescription>{t('dialogDescription')}</DialogDescription>
        </DialogHeader>
        <form id={`${id}-form`} onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
          <Tabs defaultValue="MEDIUM">
            <TabsList aria-label={t('columns.tier')}>
              {tiers.map((r) => (
                <TabsTrigger key={r.code} value={r.code} className="min-h-11 text-base lg:min-h-9">
                  {r.name}
                </TabsTrigger>
              ))}
            </TabsList>
            {tiers.map((r) => (
              <TabsContent key={r.code} value={r.code} className="flex flex-col gap-3 pt-2">
                {(['minPoints', 'reviewMonths', 'reminderDaysBefore'] as const).map((f) => (
                  <div key={f} className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-${r.code}-${f}`} className="text-base">
                      {t(`fields.${f}`)}
                    </Label>
                    <Input
                      id={`${id}-${r.code}-${f}`}
                      type="number"
                      inputMode="numeric"
                      min={f === 'reviewMonths' ? 1 : 0}
                      max={f === 'reviewMonths' ? 120 : undefined}
                      value={Number.isNaN(values[r.code][f]) ? '' : values[r.code][f]}
                      disabled={f === 'minPoints' && r.code === 'LOW'}
                      aria-describedby={f === 'minPoints' ? `${id}-${r.code}-hint` : undefined}
                      onChange={(e) => set(r.code, f, e.target.value.trim() === '' ? Number.NaN : Number(e.target.value))}
                      className={CONTROL}
                    />
                    {f === 'minPoints' ? (
                      <p id={`${id}-${r.code}-hint`} className="text-ink-muted">
                        {t(r.code === 'LOW' ? 'lowFromZero' : 'minPointsHint')}
                      </p>
                    ) : null}
                  </div>
                ))}
                {(['blocksPo', 'requiresExplicitAnswers'] as const).map((f) => (
                  <div key={f} className="flex min-h-11 items-center gap-3">
                    <Switch id={`${id}-${r.code}-${f}`} checked={values[r.code][f]} onCheckedChange={(v) => set(r.code, f, v)} />
                    <Label htmlFor={`${id}-${r.code}-${f}`} className="text-base">
                      {t(`fields.${f}`)}
                    </Label>
                  </div>
                ))}
              </TabsContent>
            ))}
          </Tabs>
          {failure ? <Notice tone="danger">{failure}</Notice> : null}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" className="min-h-11 lg:min-h-10" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form={`${id}-form`} className="min-h-11 lg:min-h-10" disabled={saving.pending} aria-busy={saving.pending || undefined}>
            {saving.pending ? t('sending') : t('send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function PolicyPanel({ policy, actions, tierName }: { policy: PolicyUi; actions: TierActions; tierName: Readonly<Record<RiskTierCodeUi, string>> }) {
  const t = useSay('risk.admin.policy')
  const failureText = useFailureText()
  const deciding = useRun()
  const [editing, setEditing] = useState(false)
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)

  async function decide(kind: 'confirm' | 'discard') {
    setMessage(null)
    const outcome = await deciding.run((key) => (kind === 'confirm' ? actions.confirmPolicy(policy.version, key) : actions.discardPolicy(policy.version, key)))
    setMessage(outcome.ok ? { tone: 'success', text: t(kind === 'confirm' ? 'confirmed' : 'discarded') } : { tone: 'danger', text: failureText(outcome) })
  }

  const yesNo = (v: boolean) => t(v ? 'yes' : 'no')
  const rows = (values: Partial<PolicyValuesUi>) => [
    ...SCREENING_KEYS.filter(() => values.screeningTierMap !== undefined).map((k) => [t(`screening.${k}`), tierName[values.screeningTierMap![k]]] as const),
    ...(values.highRiskCategories !== undefined ? [[t('highRiskCategories'), values.highRiskCategories.length > 0 ? values.highRiskCategories.join(', ') : t('none')] as const] : []),
    ...(values.registryFlagBlocks !== undefined ? [[t('registryFlagBlocks'), yesNo(values.registryFlagBlocks)] as const] : []),
    ...(values.mediumOverdueBlocks !== undefined ? [[t('mediumOverdueBlocks'), yesNo(values.mediumOverdueBlocks)] as const] : []),
    ...(values.overrideChatButton !== undefined ? [[t('overrideChatButton'), yesNo(values.overrideChatButton)] as const] : []),
  ]

  return (
    <div className="flex flex-col gap-3">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <StatusBadge look={policy.confirmed ? IN_EFFECT : WAITING} label={policy.confirmed ? t('inEffect') : t('notConfirmed')} />
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto]">
        {rows(policy.inEffect).map(([label, v]) => (
          <div key={label} className="contents">
            <dt className="text-ink-muted">{label}</dt>
            <dd className="sm:text-right">{v}</dd>
          </div>
        ))}
      </dl>
      {policy.pending ? (
        <div className="flex flex-col gap-1 border-l-2 border-line pl-3">
          <StatusBadge look={WAITING} label={t('waiting')} />
          <ul className="flex flex-col gap-0.5">
            {rows(policy.pending).map(([label, v]) => (
              <li key={label}>{`${label}: ${v}`}</li>
            ))}
          </ul>
          {policy.pendingText ? <span className="text-ink-muted">{policy.pendingText}</span> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {policy.pending === null ? (
          <Button className="min-h-11 lg:min-h-10" onClick={() => setEditing(true)}>
            {t('propose')}
          </Button>
        ) : (
          <>
            {policy.pendingByMe ? <span className="text-ink-muted">{t('proposedByYou')}</span> : <ConfirmButton label={t('confirm')} title={t('confirmTitle')} body={t('confirmBody')} keep={t('keep')} busy={deciding.pending} onConfirm={() => void decide('confirm')} />}
            <Button variant="outline" className="min-h-11 lg:min-h-10" disabled={deciding.pending} onClick={() => void decide('discard')}>
              {t('discard')}
            </Button>
          </>
        )}
      </div>
      {editing ? (
        <PolicyDialog
          policy={policy}
          tierName={tierName}
          propose={actions.proposePolicy}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            setMessage({ tone: 'success', text: t('proposed') })
          }}
        />
      ) : null}
    </div>
  )
}

function PolicyDialog({ policy, tierName, propose, onClose, onSaved }: { policy: PolicyUi; tierName: Readonly<Record<RiskTierCodeUi, string>>; propose: TierActions['proposePolicy']; onClose: () => void; onSaved: () => void }) {
  const t = useSay('risk.admin.policy')
  const failureText = useFailureText()
  const id = useId()
  const saving = useRun()
  const [value, setValue] = useState<PolicyValuesUi>(policy.inEffect)
  const [categories, setCategories] = useState(policy.inEffect.highRiskCategories.join(', '))
  const [failure, setFailure] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    const next: PolicyValuesUi = { ...value, highRiskCategories: categories.split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter((c) => c !== '') }
    const changes: Partial<PolicyValuesUi> = {}
    for (const k of Object.keys(next) as (keyof PolicyValuesUi)[]) if (JSON.stringify(next[k]) !== JSON.stringify(policy.inEffect[k])) (changes as Record<string, unknown>)[k] = next[k]
    const outcome = await saving.run((key) => propose(changes, key))
    if (outcome.ok) onSaved()
    else setFailure(failureText(outcome))
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('dialogTitle')}</DialogTitle>
          <DialogDescription>{t('dialogDescription')}</DialogDescription>
        </DialogHeader>
        <form id={`${id}-form`} onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
          {SCREENING_KEYS.map((k) => (
            <div key={k} className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-${k}`} className="text-base">
                {t(`screening.${k}`)}
              </Label>
              <NativeSelect
                id={`${id}-${k}`}
                value={value.screeningTierMap[k]}
                onChange={(e) => setValue((old) => ({ ...old, screeningTierMap: { ...old.screeningTierMap, [k]: e.target.value as RiskTierCodeUi } }))}
                className="w-full [&_select]:h-11 [&_select]:text-base lg:[&_select]:h-10"
              >
                {RISK_TIERS.map((code) => (
                  <NativeSelectOption key={code} value={code}>
                    {tierName[code]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          ))}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-categories`} className="text-base">
              {t('highRiskCategories')}
            </Label>
            <Input id={`${id}-categories`} value={categories} onChange={(e) => setCategories(e.target.value)} aria-describedby={`${id}-categories-hint`} className={CONTROL} />
            <p id={`${id}-categories-hint`} className="text-ink-muted">
              {t('categoriesHint')}
            </p>
          </div>
          {(['registryFlagBlocks', 'mediumOverdueBlocks', 'overrideChatButton'] as const).map((k) => (
            <div key={k} className="flex min-h-11 items-center gap-3">
              <Switch id={`${id}-${k}`} checked={value[k]} onCheckedChange={(v) => setValue((old) => ({ ...old, [k]: v }))} />
              <Label htmlFor={`${id}-${k}`} className="text-base">
                {t(k)}
              </Label>
            </div>
          ))}
          {failure ? <Notice tone="danger">{failure}</Notice> : null}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" className="min-h-11 lg:min-h-10" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form={`${id}-form`} className="min-h-11 lg:min-h-10" disabled={saving.pending} aria-busy={saving.pending || undefined}>
            {saving.pending ? t('sending') : t('send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
