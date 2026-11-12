'use client'

import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
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
import { Input } from '../shadcn/input'
import { Label } from '../shadcn/label'
import { NativeSelect, NativeSelectOption } from '../shadcn/native-select'
import type { NeedLineShape, NewRfxCatalogItem } from './new-rfx-form'
import type { RfxOutcome } from './setup-model'
import { useRfxAct } from './use-rfx-act'

// Step "บรรทัด" of /sourcing/[id]/edit (S10-12): the RFx's lines with quantity, delivery site, reference price and where
// that price comes from (BR-RFX-11), and the requests they came from; a line taken out goes back to the pool (its
// request line is free again · INV-RFX-03), asked first. An RFx of a need takes more lines here (a catalogue item or
// typed). Lines from the pool are added from the pool. rfx.addLines and rfx.removeLine check everything again.

export interface SetupLineView {
  readonly id: string
  readonly title: string
  /** The line's English (BR-FORM-11), typed by procurement; from the catalogue item's English name when it has one */
  readonly descriptionEn: string
  readonly uomEn: string
  readonly quantity: string
  readonly site: string | null
  readonly reference: string | null
  readonly from: string | null
}

/** The English of one line: its description and unit, saved together */
function LineEnglish({ line, pending, save }: { readonly line: SetupLineView; readonly pending: boolean; readonly save: (english: { readonly descriptionEn: string; readonly uomEn: string }) => Promise<unknown> }) {
  const t = useTranslations('sourcing.setup')
  const id = useId()
  const [descriptionEn, setDescriptionEn] = useState(line.descriptionEn)
  const [uomEn, setUomEn] = useState(line.uomEn)
  return (
    <form
      className="mt-2 flex flex-col gap-2 md:flex-row md:items-end"
      aria-label={t('lines.englishLabel', { line: line.title })}
      onSubmit={(e) => {
        e.preventDefault()
        void save({ descriptionEn, uomEn })
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Label htmlFor={`${id}-desc-en`}>{t('field.lineDescriptionEn')}</Label>
        <Input id={`${id}-desc-en`} className="min-h-11 lg:min-h-10" value={descriptionEn} maxLength={200} onChange={(e) => setDescriptionEn(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1 md:w-32">
        <Label htmlFor={`${id}-uom-en`}>{t('field.uomEn')}</Label>
        <Input id={`${id}-uom-en`} className="min-h-11 lg:min-h-10" value={uomEn} maxLength={40} onChange={(e) => setUomEn(e.target.value)} />
      </div>
      <Button type="submit" variant="outline" className="min-h-11 shrink-0 lg:min-h-10" disabled={pending}>
        {t('lines.englishSave')}
      </Button>
    </form>
  )
}

const blank = (): NeedLineShape => ({ description: '', quantity: '', uom: '', catalogItemId: null, refUnitPrice: '' })

export function SetupLines({
  lines,
  need,
  catalog,
  remove,
  add,
  bilingual,
  saveEnglish,
}: {
  readonly lines: readonly SetupLineView[]
  /** The RFx is in Thai and English: each line takes its English description and unit */
  readonly bilingual: boolean
  readonly saveEnglish: (rfxLineId: string, english: { readonly descriptionEn: string; readonly uomEn: string }, key: string) => Promise<RfxOutcome>
  /** An RFx of a need takes typed lines; null for an RFx of pool lines */
  readonly need: { readonly categoryCode: string } | null
  readonly catalog: readonly NewRfxCatalogItem[]
  readonly remove: (rfxLineId: string, key: string) => Promise<RfxOutcome>
  readonly add: (line: NeedLineShape, key: string) => Promise<RfxOutcome>
}) {
  const t = useTranslations('sourcing.setup')
  const id = useId()
  const { act, pending, message, setMessage } = useRfxAct()
  const [line, setLine] = useState<NeedLineShape>(blank())
  const set = (patch: Partial<NeedLineShape>) => setLine((l) => ({ ...l, ...patch }))

  return (
    <div className="flex flex-col gap-4">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <ol aria-label={t('lines.label')} className="flex flex-col divide-y divide-line">
        {lines.map((l) => (
          <li key={l.id} className="flex flex-col gap-1 py-3 md:flex-row md:items-start md:justify-between md:gap-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium break-words text-ink">{l.title}</span>
              <span className="text-ink-muted">{l.quantity}</span>
              {l.site ? <span className="text-ink-muted">{t('lines.site', { site: l.site })}</span> : null}
              <span className="text-ink-muted">{l.reference ?? t('lines.noReference')}</span>
              {l.from ? <span className="text-ink-muted">{l.from}</span> : null}
              {bilingual ? <LineEnglish line={l} pending={pending} save={(english) => act((key) => saveEnglish(l.id, english, key), t('lines.englishSaved'))} /> : null}
            </div>
            {lines.length > 1 ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" className="min-h-11 shrink-0 self-start lg:min-h-10" disabled={pending}>
                    {t('lines.remove')}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('lines.removeTitle')}</AlertDialogTitle>
                    <AlertDialogDescription>{t('lines.removeBody', { line: l.title })}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('back')}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void act((key) => remove(l.id, key), t('lines.removed'))}>{t('lines.removeConfirm')}</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
          </li>
        ))}
      </ol>
      {need ? (
        <form
          className="flex flex-col gap-3 border-t border-line pt-4"
          aria-labelledby={`${id}-add`}
          onSubmit={(e) => {
            e.preventDefault()
            if (!line.description.trim() || !line.quantity.trim() || !line.uom.trim()) return setMessage({ tone: 'danger', text: t('new.lineMissing') })
            void act((key) => add(line, key), t('lines.added')).then((done) => done && setLine(blank()))
          }}
        >
          <h2 id={`${id}-add`} className="font-semibold text-ink">
            {t('lines.addTitle')}
          </h2>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-item`}>{t('field.catalogItem')}</Label>
            <NativeSelect
              id={`${id}-item`}
              className="min-h-11 w-full lg:min-h-10"
              value={line.catalogItemId ?? ''}
              onChange={(e) => {
                const item = catalog.find((c) => c.id === e.target.value)
                set(item ? { catalogItemId: item.id, description: item.name, uom: item.uom, refUnitPrice: item.refUnitPrice ?? '' } : { catalogItemId: null })
              }}
            >
              <NativeSelectOption value="">{t('field.noCatalogItem')}</NativeSelectOption>
              {catalog
                .filter((c) => c.categoryCode === need.categoryCode)
                .map((c) => (
                  <NativeSelectOption key={c.id} value={c.id}>
                    {c.label}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-desc`}>{t('field.lineDescription')}</Label>
            <Input id={`${id}-desc`} className="min-h-11 lg:min-h-10" value={line.description} maxLength={200} onChange={(e) => set({ description: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-qty`}>{t('field.quantity')}</Label>
              <Input id={`${id}-qty`} inputMode="decimal" className="min-h-11 lg:min-h-10" value={line.quantity} onChange={(e) => set({ quantity: e.target.value })} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-uom`}>{t('field.uom')}</Label>
              <Input id={`${id}-uom`} className="min-h-11 lg:min-h-10" value={line.uom} maxLength={40} onChange={(e) => set({ uom: e.target.value })} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-ref`}>{t('field.refUnitPrice')}</Label>
            <Input id={`${id}-ref`} inputMode="decimal" className="min-h-11 lg:min-h-10" value={line.refUnitPrice ?? ''} onChange={(e) => set({ refUnitPrice: e.target.value })} />
          </div>
          <Button type="submit" variant="outline" className="min-h-11 self-start lg:min-h-10" disabled={pending}>
            {t('lines.add')}
          </Button>
        </form>
      ) : (
        <p className="text-ink-muted">{t('lines.fromPoolHint')}</p>
      )}
    </div>
  )
}
