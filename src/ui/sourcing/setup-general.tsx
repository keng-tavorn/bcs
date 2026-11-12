'use client'

import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { RFX_LONG_TEXT_MAX } from '@/lib/constants'
import { Notice } from '../form/notice'
import { Button } from '../shadcn/button'
import { Checkbox } from '../shadcn/checkbox'
import { Input } from '../shadcn/input'
import { Label } from '../shadcn/label'
import { Textarea } from '../shadcn/textarea'
import type { RfxOutcome } from './setup-model'
import { useRfxAct } from './use-rfx-act'

// Step "ทั่วไป" of /sourcing/[id]/edit (S10-12): the title and description in Thai and English, whether a supplier may
// bid on some lines only, whether a bid may include VAT (only where the organization allows it · OQ-212), and the
// sealed envelope — prices hidden until the close (BR-RFX-06); opening the envelope needs a reason (UNSEAL_REASON).
// The kind and category are fixed when the draft is made. rfx.update checks everything again.

export interface GeneralValues {
  /** The RFx in Thai and English (TH_EN): needed to invite a foreign supplier or an English-reading contact (BR-FORM-11) */
  readonly bilingual: boolean
  readonly title: string
  readonly titleEn: string
  readonly description: string
  readonly descriptionEn: string
  readonly allowPartialBids: boolean
  readonly allowVatInclusiveBids: boolean
  readonly sealed: boolean
  readonly unsealReason: string
}

export function SetupGeneral({
  initial,
  vatInclusiveAllowed,
  save,
}: {
  readonly initial: GeneralValues
  readonly vatInclusiveAllowed: boolean
  readonly save: (input: GeneralValues, key: string) => Promise<RfxOutcome>
}) {
  const t = useTranslations('sourcing.setup')
  const id = useId()
  const { act, pending, message, setMessage } = useRfxAct()
  const [v, setV] = useState<GeneralValues>(initial)
  const set = (patch: Partial<GeneralValues>) => setV((x) => ({ ...x, ...patch }))

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (!v.title.trim() || !v.description.trim()) return setMessage({ tone: 'danger', text: t('new.generalMissing') })
        if (v.bilingual && (!v.titleEn.trim() || !v.descriptionEn.trim())) return setMessage({ tone: 'danger', text: t('errors.ENGLISH_MISSING') })
        if (!v.sealed && initial.sealed && v.unsealReason.trim().length < 3) return setMessage({ tone: 'danger', text: t('errors.UNSEAL_REASON') })
        void act((key) => save(v, key), t('general.saved'))
      }}
    >
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <div className="flex items-start gap-3">
        <Checkbox id={`${id}-bilingual`} className="mt-1" checked={v.bilingual} onCheckedChange={(c) => set({ bilingual: c === true })} aria-describedby={`${id}-bilingual-hint`} />
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-bilingual`} className="font-normal">
            {t('field.bilingual')}
          </Label>
          <p id={`${id}-bilingual-hint`} className="text-base text-ink-muted md:text-sm">
            {t('field.bilingualHint')}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-title`}>{t('field.title')}</Label>
        <Input id={`${id}-title`} className="min-h-11 lg:min-h-10" value={v.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-title-en`}>{t('field.titleEn')}</Label>
        <Input id={`${id}-title-en`} className="min-h-11 lg:min-h-10" value={v.titleEn} maxLength={200} onChange={(e) => set({ titleEn: e.target.value })} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-desc`}>{t('field.description')}</Label>
        <Textarea id={`${id}-desc`} value={v.description} maxLength={RFX_LONG_TEXT_MAX} onChange={(e) => set({ description: e.target.value })} required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-desc-en`}>{t('field.descriptionEn')}</Label>
        <Textarea id={`${id}-desc-en`} value={v.descriptionEn} maxLength={RFX_LONG_TEXT_MAX} onChange={(e) => set({ descriptionEn: e.target.value })} />
      </div>
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
