'use client'

import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { RFX_LONG_TEXT_MAX } from '@/lib/constants'
import { Notice } from '../form/notice'
import { Button } from '../shadcn/button'
import { Checkbox } from '../shadcn/checkbox'
import { Input } from '../shadcn/input'
import { Label } from '../shadcn/label'
import { NativeSelect, NativeSelectOption } from '../shadcn/native-select'
import { Textarea } from '../shadcn/textarea'
import type { RfxOutcome } from './setup-model'
import { useRfxAct } from './use-rfx-act'

// The form of /sourcing/new (S10-12): an RFx's kind, title and description in Thai (English optional · FR-INT-201) and
// what bids it takes; then, from the pool, the ticked lines as they are (one category · BR-RFX-01), or, for a need, its
// category and lines (a catalogue item fills the line and its reference price, or the line is typed with a reference
// price before VAT · BR-RFX-11). Two short steps for a need, so no page asks more than eight things at once (§9.9).
// "สร้างร่าง RFx" makes the draft (rfx.create) and opens its next step; the command checks everything again.

export interface NewRfxPoolLine {
  readonly requestLineId: string
  readonly label: string
  readonly quantity: string
  readonly categoryCode: string | null
}

export interface NewRfxCatalogItem {
  readonly id: string
  readonly label: string
  readonly name: string
  readonly uom: string
  readonly categoryCode: string
  readonly refUnitPrice: string | null
}

export interface NewRfxInputShape {
  readonly kind: 'RFQ' | 'RFP' | 'RFI'
  readonly title: string
  readonly titleEn: string
  readonly description: string
  readonly descriptionEn: string
  readonly allowPartialBids: boolean
  readonly allowVatInclusiveBids: boolean
  readonly requestLineIds?: readonly string[]
  readonly need?: { readonly categoryCode: string; readonly lines: ReadonlyArray<NeedLineShape> }
}

export interface NeedLineShape {
  readonly description: string
  readonly quantity: string
  readonly uom: string
  readonly catalogItemId: string | null
  readonly refUnitPrice: string | null
}

const KINDS = ['RFQ', 'RFP', 'RFI'] as const
const blank = (): NeedLineShape => ({ description: '', quantity: '', uom: '', catalogItemId: null, refUnitPrice: '' })

export function NewRfxForm({
  poolLines,
  categories,
  catalog,
  vatInclusiveAllowed,
  create,
}: {
  readonly poolLines: readonly NewRfxPoolLine[]
  readonly categories: readonly string[]
  readonly catalog: readonly NewRfxCatalogItem[]
  readonly vatInclusiveAllowed: boolean
  readonly create: (input: NewRfxInputShape, key: string) => Promise<RfxOutcome>
}) {
  const t = useTranslations('sourcing.setup')
  const id = useId()
  const { act, pending, message, setMessage, router } = useRfxAct()
  const fromPool = poolLines.length > 0
  const [step, setStep] = useState<'general' | 'lines'>('general')
  const [kind, setKind] = useState<(typeof KINDS)[number]>('RFQ')
  const [title, setTitle] = useState('')
  const [titleEn, setTitleEn] = useState('')
  const [description, setDescription] = useState('')
  const [descriptionEn, setDescriptionEn] = useState('')
  const [partial, setPartial] = useState(false)
  const [vatInclusive, setVatInclusive] = useState(false)
  const [category, setCategory] = useState(categories[0] ?? '')
  const [lines, setLines] = useState<NeedLineShape[]>([blank()])
  const categoriesOfPool = new Set(poolLines.map((l) => l.categoryCode ?? ''))

  const general = { kind, title, titleEn, description, descriptionEn, allowPartialBids: partial, allowVatInclusiveBids: vatInclusive && vatInclusiveAllowed }
  const generalMissing = !title.trim() || !description.trim()

  function setLine(i: number, patch: Partial<NeedLineShape>) {
    setLines((all) => all.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  }

  function pickItem(i: number, itemId: string) {
    const item = catalog.find((c) => c.id === itemId)
    setLine(i, item ? { catalogItemId: item.id, description: item.name, uom: item.uom, refUnitPrice: item.refUnitPrice ?? '' } : { catalogItemId: null })
  }

  function next() {
    if (generalMissing) return setMessage({ tone: 'danger', text: t('new.generalMissing') })
    setMessage(null)
    if (fromPool) return void submit()
    setStep('lines')
  }

  async function submit() {
    if (!fromPool && lines.some((l) => !l.description.trim() || !l.quantity.trim() || !l.uom.trim())) return setMessage({ tone: 'danger', text: t('new.lineMissing') })
    const input: NewRfxInputShape = fromPool ? { ...general, requestLineIds: poolLines.map((l) => l.requestLineId) } : { ...general, need: { categoryCode: category, lines } }
    await act((key) => create(input, key), null, (o) => router.push(`/sourcing/${o.rfxEventId}/edit?step=${fromPool ? 'suppliers' : 'lines'}`))
  }

  const items = catalog.filter((c) => c.categoryCode === category)

  return (
    <div className="flex flex-col gap-4">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {step === 'general' ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            next()
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-kind`}>{t('field.kind')}</Label>
            <NativeSelect id={`${id}-kind`} className="min-h-11 w-full lg:min-h-10" value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>
              {KINDS.map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {t(`kindLong.${k}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-title`}>{t('field.title')}</Label>
            <Input id={`${id}-title`} className="min-h-11 lg:min-h-10" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-title-en`}>{t('field.titleEn')}</Label>
            <Input id={`${id}-title-en`} className="min-h-11 lg:min-h-10" value={titleEn} maxLength={200} onChange={(e) => setTitleEn(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-desc`}>{t('field.description')}</Label>
            <Textarea id={`${id}-desc`} value={description} maxLength={RFX_LONG_TEXT_MAX} onChange={(e) => setDescription(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-desc-en`}>{t('field.descriptionEn')}</Label>
            <Textarea id={`${id}-desc-en`} value={descriptionEn} maxLength={RFX_LONG_TEXT_MAX} onChange={(e) => setDescriptionEn(e.target.value)} />
          </div>
          <div className="flex items-start gap-3">
            <Checkbox id={`${id}-partial`} className="mt-1" checked={partial} onCheckedChange={(v) => setPartial(v === true)} />
            <Label htmlFor={`${id}-partial`} className="font-normal">
              {t('field.allowPartialBids')}
            </Label>
          </div>
          {vatInclusiveAllowed ? (
            <div className="flex items-start gap-3">
              <Checkbox id={`${id}-vat`} className="mt-1" checked={vatInclusive} onCheckedChange={(v) => setVatInclusive(v === true)} />
              <Label htmlFor={`${id}-vat`} className="font-normal">
                {t('field.allowVatInclusiveBids')}
              </Label>
            </div>
          ) : null}
          {fromPool ? (
            <section aria-labelledby={`${id}-pool`} className="flex flex-col gap-2 border-t border-line pt-4">
              <h2 id={`${id}-pool`} className="font-semibold text-ink">
                {t('new.poolLines', { count: poolLines.length })}
              </h2>
              {categoriesOfPool.size > 1 ? <Notice tone="warning">{t('errors.MIXED_CATEGORY')}</Notice> : null}
              <ul className="flex flex-col divide-y divide-line">
                {poolLines.map((l) => (
                  <li key={l.requestLineId} className="flex flex-wrap justify-between gap-x-4 py-2">
                    <span className="min-w-0 break-words text-ink">{l.label}</span>
                    <span className="tabular text-ink-muted">{l.quantity}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <Button type="submit" className="min-h-11 self-start lg:min-h-10" disabled={pending}>
            {fromPool ? (pending ? t('new.creating') : t('new.create')) : t('new.next')}
          </Button>
        </form>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-category`}>{t('field.category')}</Label>
            <NativeSelect
              id={`${id}-category`}
              className="min-h-11 w-full lg:min-h-10"
              value={category}
              onChange={(e) => {
                setCategory(e.target.value)
                setLines((all) => all.map((l) => ({ ...l, catalogItemId: null })))
              }}
            >
              {categories.map((c) => (
                <NativeSelectOption key={c} value={c}>
                  {c}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <ol className="flex flex-col gap-4">
            {lines.map((l, i) => (
              <li key={i} className="flex flex-col gap-3 border-t border-line pt-4">
                <h2 className="font-semibold text-ink">{t('new.lineNo', { no: i + 1 })}</h2>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`${id}-item-${i}`}>{t('field.catalogItem')}</Label>
                  <NativeSelect id={`${id}-item-${i}`} className="min-h-11 w-full lg:min-h-10" value={l.catalogItemId ?? ''} onChange={(e) => pickItem(i, e.target.value)}>
                    <NativeSelectOption value="">{t('field.noCatalogItem')}</NativeSelectOption>
                    {items.map((c) => (
                      <NativeSelectOption key={c.id} value={c.id}>
                        {c.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`${id}-line-desc-${i}`}>{t('field.lineDescription')}</Label>
                  <Input id={`${id}-line-desc-${i}`} className="min-h-11 lg:min-h-10" value={l.description} maxLength={200} onChange={(e) => setLine(i, { description: e.target.value })} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`${id}-qty-${i}`}>{t('field.quantity')}</Label>
                    <Input id={`${id}-qty-${i}`} inputMode="decimal" className="min-h-11 lg:min-h-10" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`${id}-uom-${i}`}>{t('field.uom')}</Label>
                    <Input id={`${id}-uom-${i}`} className="min-h-11 lg:min-h-10" value={l.uom} maxLength={40} onChange={(e) => setLine(i, { uom: e.target.value })} />
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`${id}-ref-${i}`}>{t('field.refUnitPrice')}</Label>
                  <Input id={`${id}-ref-${i}`} inputMode="decimal" className="min-h-11 lg:min-h-10" value={l.refUnitPrice ?? ''} onChange={(e) => setLine(i, { refUnitPrice: e.target.value })} />
                </div>
                {lines.length > 1 ? (
                  <Button type="button" variant="outline" className="min-h-11 self-start lg:min-h-10" onClick={() => setLines((all) => all.filter((_, j) => j !== i))}>
                    {t('new.removeLine', { no: i + 1 })}
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="min-h-11 lg:min-h-10" disabled={pending}>
              {pending ? t('new.creating') : t('new.create')}
            </Button>
            <Button type="button" variant="outline" className="min-h-11 lg:min-h-10" disabled={pending} onClick={() => setLines((all) => [...all, blank()])}>
              {t('new.addLine')}
            </Button>
            <Button type="button" variant="outline" className="min-h-11 lg:min-h-10" disabled={pending} onClick={() => setStep('general')}>
              {t('new.back')}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
