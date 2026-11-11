'use client'

import { Sparkles } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { RFX_LONG_TEXT_MAX } from '@/lib/constants'
import { AiReviewBox, useAiNoteText, type AiFieldView } from '../ai/ai-review'
import { Notice } from '../form/notice'
import { Badge } from '../shadcn/badge'
import { Button } from '../shadcn/button'
import { Checkbox } from '../shadcn/checkbox'
import { Input } from '../shadcn/input'
import { Label } from '../shadcn/label'
import { NativeSelect, NativeSelectOption } from '../shadcn/native-select'
import { Textarea } from '../shadcn/textarea'
import type { RfxOutcome } from './setup-model'
import { useRfxAct } from './use-rfx-act'

// Step "ทั่วไป" of /sourcing/[id]/edit (S10-12): the title and description in Thai and English, whether a supplier may
// bid on some lines only, whether a bid may include VAT (only where the organization allows it · OQ-212), and the
// sealed envelope — prices hidden until the close (BR-RFX-06); opening the envelope needs a reason (UNSEAL_REASON).
// The category is fixed when the draft is made. rfx.update checks everything again.
// S10-16 (FR-AI-305 AC1 · BR-AI-31): RFQ ↔ RFP and each line's English may change while a draft; "ร่าง RFx ด้วย AI"
// (only when every gate of the AI is open) asks the Sourcing Agent for the words, which wait in the form marked
// "เติมโดย AI โปรดตรวจ": the kind and each line's English are confirmed one by one, the rest together or by saving
// (BR-AI-16 BR-AI-17); rfx.open refuses while any waits (AI_REVIEW_PENDING). With AI off the form is as before (EG-1).

export interface GeneralLine {
  readonly id: string
  readonly lineNo: number
  readonly description: string
  readonly uom: string
  readonly descriptionEn: string
  readonly uomEn: string
}

export interface GeneralValues {
  readonly kind: 'RFQ' | 'RFP' | 'RFI'
  readonly title: string
  readonly titleEn: string
  readonly description: string
  readonly descriptionEn: string
  readonly allowPartialBids: boolean
  readonly allowVatInclusiveBids: boolean
  readonly sealed: boolean
  readonly unsealReason: string
  readonly lines: readonly GeneralLine[]
}

/** The Sourcing Agent's draft still open on the RFx (rfxDraftAiOf) */
export interface GeneralAiDraft {
  readonly agentActionId: string
  readonly proposed: Readonly<Record<string, string>>
  readonly requiredPaths: readonly string[]
  readonly confirmedPaths: readonly string[]
  /** Taken in already: the RFx holds its values; not yet, the form starts from them */
  readonly applied: boolean
}

export interface GeneralSave {
  readonly kind?: 'RFQ' | 'RFP'
  readonly title: string
  readonly titleEn: string
  readonly description: string
  readonly descriptionEn: string
  readonly allowPartialBids: boolean
  readonly allowVatInclusiveBids: boolean
  readonly sealed: boolean
  readonly unsealReason: string
  readonly lines?: ReadonlyArray<{ readonly rfxLineId: string; readonly descriptionEn: string; readonly uomEn: string }>
  readonly aiAssist?: { readonly agentActionId: string; readonly confirmedPaths: readonly string[] }
}

type TextField = 'title' | 'titleEn' | 'description' | 'descriptionEn'
const TEXT_FIELDS: readonly TextField[] = ['title', 'titleEn', 'description', 'descriptionEn']

/** The form's value at an AI path ("kind", "title", "lines.<lineNo>.descriptionEn" …) */
function valueAt(v: GeneralValues, path: string): string | null {
  if (path === 'kind') return v.kind
  if ((TEXT_FIELDS as readonly string[]).includes(path)) return v[path as TextField]
  const m = /^lines\.(\d+)\.(descriptionEn|uomEn)$/.exec(path)
  const line = m ? v.lines.find((l) => l.lineNo === Number(m[1])) : undefined
  return line && m ? line[m[2] as 'descriptionEn' | 'uomEn'] : null
}

/** What the AI proposed put into the form (a draft not taken in yet), where the form has that place */
function withProposed(v: GeneralValues, proposed: Readonly<Record<string, string>>): GeneralValues {
  let out = v
  for (const [path, value] of Object.entries(proposed)) {
    if (path === 'kind' && v.kind !== 'RFI' && (value === 'RFQ' || value === 'RFP')) out = { ...out, kind: value }
    else if ((TEXT_FIELDS as readonly string[]).includes(path)) out = { ...out, [path]: value }
    else {
      const m = /^lines\.(\d+)\.(descriptionEn|uomEn)$/.exec(path)
      if (m) out = { ...out, lines: out.lines.map((l) => (l.lineNo === Number(m[1]) ? { ...l, [m[2]!]: value } : l)) }
    }
  }
  return out
}

export function SetupGeneral({
  initial,
  vatInclusiveAllowed,
  save,
  ai,
}: {
  readonly initial: GeneralValues
  readonly vatInclusiveAllowed: boolean
  readonly save: (input: GeneralSave, key: string) => Promise<RfxOutcome>
  /** null: AI is off for this RFx (no button, nothing shown) */
  readonly ai: { readonly available: boolean; readonly draft: GeneralAiDraft | null; readonly ask: (key: string) => Promise<RfxOutcome> } | null
}) {
  const t = useTranslations('sourcing.setup')
  const tAi = useTranslations('aiAssist')
  const noteText = useAiNoteText()
  const id = useId()
  const { act, pending, message, setMessage } = useRfxAct()
  const draft = ai?.draft ?? null
  const [v, setV] = useState<GeneralValues>(() => (draft && !draft.applied ? withProposed(initial, draft.proposed) : initial))
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(() => new Set(draft?.confirmedPaths ?? []))
  const set = (patch: Partial<GeneralValues>) => setV((x) => ({ ...x, ...patch }))
  const setLine = (lineId: string, patch: Partial<GeneralLine>) => setV((x) => ({ ...x, lines: x.lines.map((l) => (l.id === lineId ? { ...l, ...patch } : l)) }))

  // a value the AI put in still waits while the form holds it unchanged and nobody confirmed it (BR-AI-17)
  const required = new Set(draft?.requiredPaths ?? [])
  const proposedPaths = draft ? Object.keys(draft.proposed).filter((p) => valueAt(v, p) === draft.proposed[p]) : []
  const marked = new Set(proposedPaths.filter((p) => !confirmed.has(p)))
  const labelOf = (path: string): string => {
    if (path === 'kind') return t('field.kind')
    if ((TEXT_FIELDS as readonly string[]).includes(path)) return t(`field.${path as TextField}`)
    const m = /^lines\.(\d+)\.(descriptionEn|uomEn)$/.exec(path)
    return m ? t(m[2] === 'uomEn' ? 'ai.lineUomEn' : 'ai.lineDescriptionEn', { no: Number(m[1]) }) : path
  }
  const fields: AiFieldView[] = proposedPaths.map((p) => ({ path: p, label: labelOf(p), value: p === 'kind' ? t(`kindLong.${draft!.proposed[p] as 'RFQ'}`) : draft!.proposed[p]!, required: required.has(p) }))
  const badge = (path: string) =>
    marked.has(path) ? (
      <Badge variant="info" className="text-base md:text-sm">
        <Sparkles aria-hidden="true" />
        {tAi('badge')}
      </Badge>
    ) : null

  function submit() {
    if (!v.title.trim() || !v.description.trim()) return setMessage({ tone: 'danger', text: t('new.generalMissing') })
    if (!v.sealed && initial.sealed && v.unsealReason.trim().length < 3) return setMessage({ tone: 'danger', text: t('errors.UNSEAL_REASON') })
    const lines = v.lines
      .filter((l) => {
        const was = initial.lines.find((x) => x.id === l.id)
        return !was || was.descriptionEn !== l.descriptionEn || was.uomEn !== l.uomEn
      })
      .map((l) => ({ rfxLineId: l.id, descriptionEn: l.descriptionEn, uomEn: l.uomEn }))
    // saving confirms what may be confirmed together; the kind and each line's English only by their own box (BR-AI-16)
    const aiAssist = draft ? { agentActionId: draft.agentActionId, confirmedPaths: proposedPaths.filter((p) => !required.has(p) || confirmed.has(p)) } : undefined
    const input: GeneralSave = {
      title: v.title,
      titleEn: v.titleEn,
      description: v.description,
      descriptionEn: v.descriptionEn,
      allowPartialBids: v.allowPartialBids,
      allowVatInclusiveBids: v.allowVatInclusiveBids,
      sealed: v.sealed,
      unsealReason: v.unsealReason,
      ...(v.kind !== 'RFI' && (v.kind !== initial.kind || (draft && Object.hasOwn(draft.proposed, 'kind'))) ? { kind: v.kind } : {}),
      ...(lines.length ? { lines } : {}),
      ...(aiAssist ? { aiAssist } : {}),
    }
    const waiting = proposedPaths.filter((p) => required.has(p) && !confirmed.has(p)).length
    void act((key) => save(input, key), waiting ? t('ai.savedWaiting', { count: waiting }) : t('general.saved'))
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {ai?.available ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" className="min-h-11 lg:min-h-10" disabled={pending} aria-busy={pending || undefined} aria-describedby={`${id}-ai-hint`} onClick={() => void act((key) => ai.ask(key), t('ai.drafted'))}>
            <Sparkles aria-hidden="true" />
            {t('ai.draft')}
          </Button>
          <span id={`${id}-ai-hint`} className="text-base text-ink-muted md:text-sm">
            {t('ai.hint')}
          </span>
        </div>
      ) : null}
      {draft && fields.length ? (
        <AiReviewBox
          title={t('ai.boxTitle')}
          fields={fields}
          confirmed={confirmed}
          onConfirm={(path, checked) => setConfirmed((c) => (checked ? new Set([...c, path]) : new Set([...c].filter((p) => p !== path))))}
          onConfirmRest={() => setConfirmed((c) => new Set([...c, ...fields.filter((f) => !f.required).map((f) => f.path)]))}
          reading={null}
          notes={[]}
          noteText={noteText}
        />
      ) : null}
      {initial.kind !== 'RFI' ? (
        <div className="flex flex-col gap-2 md:w-72">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor={`${id}-kind`}>{t('field.kind')}</Label>
            {badge('kind')}
          </div>
          <NativeSelect id={`${id}-kind`} className="min-h-11 lg:min-h-10" value={v.kind} onChange={(e) => set({ kind: e.target.value as 'RFQ' | 'RFP' })}>
            <NativeSelectOption value="RFQ">{t('kindLong.RFQ')}</NativeSelectOption>
            <NativeSelectOption value="RFP">{t('kindLong.RFP')}</NativeSelectOption>
          </NativeSelect>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={`${id}-title`}>{t('field.title')}</Label>
          {badge('title')}
        </div>
        <Input id={`${id}-title`} className="min-h-11 lg:min-h-10" value={v.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} required />
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={`${id}-title-en`}>{t('field.titleEn')}</Label>
          {badge('titleEn')}
        </div>
        <Input id={`${id}-title-en`} className="min-h-11 lg:min-h-10" value={v.titleEn} maxLength={200} onChange={(e) => set({ titleEn: e.target.value })} />
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={`${id}-desc`}>{t('field.description')}</Label>
          {badge('description')}
        </div>
        <Textarea id={`${id}-desc`} value={v.description} maxLength={RFX_LONG_TEXT_MAX} onChange={(e) => set({ description: e.target.value })} required />
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={`${id}-desc-en`}>{t('field.descriptionEn')}</Label>
          {badge('descriptionEn')}
        </div>
        <Textarea id={`${id}-desc-en`} value={v.descriptionEn} maxLength={RFX_LONG_TEXT_MAX} onChange={(e) => set({ descriptionEn: e.target.value })} />
      </div>
      {v.lines.length ? (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 font-medium">{t('ai.linesTitle')}</legend>
          {v.lines.map((l) => (
            <div key={l.id} className="flex flex-col gap-2 rounded-md border border-line p-3">
              <p className="break-words text-ink">{t('lines.title', { no: l.lineNo, description: l.description })}</p>
              <div className="flex flex-col gap-2 md:flex-row md:items-end">
                <div className="flex flex-1 flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Label htmlFor={`${id}-l${l.lineNo}-en`}>{t('ai.lineDescriptionEn', { no: l.lineNo })}</Label>
                    {badge(`lines.${l.lineNo}.descriptionEn`)}
                  </div>
                  <Input id={`${id}-l${l.lineNo}-en`} className="min-h-11 lg:min-h-10" value={l.descriptionEn} maxLength={200} onChange={(e) => setLine(l.id, { descriptionEn: e.target.value })} />
                </div>
                <div className="flex flex-col gap-2 md:w-48">
                  <div className="flex flex-wrap items-center gap-2">
                    <Label htmlFor={`${id}-l${l.lineNo}-uom`}>{t('ai.lineUomEn', { no: l.lineNo })}</Label>
                    {badge(`lines.${l.lineNo}.uomEn`)}
                  </div>
                  <Input id={`${id}-l${l.lineNo}-uom`} className="min-h-11 lg:min-h-10" value={l.uomEn} maxLength={40} placeholder={l.uom} onChange={(e) => setLine(l.id, { uomEn: e.target.value })} />
                </div>
              </div>
            </div>
          ))}
        </fieldset>
      ) : null}
      <div className="flex items-start gap-3">
        <Checkbox id={`${id}-partial`} className="mt-1" checked={v.allowPartialBids} onCheckedChange={(c) => set({ allowPartialBids: c === true })} />
        <Label htmlFor={`${id}-partial`} className="font-normal">
          {t('field.allowPartialBids')}
        </Label>
      </div>
      {vatInclusiveAllowed || initial.allowVatInclusiveBids ? (
        <div className="flex items-start gap-3">
          <Checkbox id={`${id}-vat`} className="mt-1" checked={v.allowVatInclusiveBids} onCheckedChange={(c) => set({ allowVatInclusiveBids: c === true })} />
          <Label htmlFor={`${id}-vat`} className="font-normal">
            {t('field.allowVatInclusiveBids')}
          </Label>
        </div>
      ) : null}
      <div className="flex items-start gap-3">
        <Checkbox id={`${id}-sealed`} className="mt-1" checked={v.sealed} onCheckedChange={(c) => set({ sealed: c === true })} aria-describedby={`${id}-sealed-hint`} />
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-sealed`} className="font-normal">
            {t('field.sealed')}
          </Label>
          <p id={`${id}-sealed-hint`} className="text-base text-ink-muted md:text-sm">
            {t('field.sealedHint')}
          </p>
        </div>
      </div>
      {!v.sealed && initial.sealed ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-unseal`}>{t('field.unsealReason')}</Label>
          <Textarea id={`${id}-unseal`} value={v.unsealReason} maxLength={500} onChange={(e) => set({ unsealReason: e.target.value })} />
        </div>
      ) : null}
      <Button type="submit" className="min-h-11 self-start lg:min-h-10" disabled={pending}>
        {pending ? t('general.saving') : t('general.save')}
      </Button>
    </form>
  )
}
