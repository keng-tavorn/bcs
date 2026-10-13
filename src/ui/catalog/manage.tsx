'use client'

import { ChevronDown, Pencil, Plus } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai/date'
import { formatSatang } from '@/core/money/format'
import { useAction } from '../admin-org/use-action'
import { StatusBadge, type BadgeLook } from '../document/badges'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { checkboxClass, inputClass } from '../request-form/controls'
import { Switch } from '../settings-notifications/switch'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../shadcn/alert-dialog'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../shadcn/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../shadcn/dialog'
import { agreementFormErrors, agreementState, canEndAgreement, itemFormErrors, itemFormValues, lastDayOf, type AgreementState } from './model'
import { catalogErrorField, catalogErrorKey, type CatalogFailure, type CatalogOutcome } from './outcome'
import type { AgreementView, CatalogItemView, ItemEditInput, ItemFormValues, NewAgreementInput, NewItemInput, SupplierChoice } from './types'

// /catalog/manage (S6-10 · FR-INT-102 AC3 · OQ-114): PROCUREMENT keeps the catalogue — adds an item, edits it or takes
// it out of use — and its agreed prices: adds one with a supplier for a period picked as its first and last day, and
// ends one in effect, today becoming its last day (irreversible, so it asks first in an Alert Dialog). Every form opens
// in a Dialog only when its button is pressed (NG-13); a refusal is said in the form, beside the field it is about when
// there is one, with how to fix it (§9.9 rule 7). The services check catalog.manage and every rule again. Money as
// satang text from the server, typed as baht; never floating point.

export interface CatalogManageActions {
  readonly createItem: (input: NewItemInput, idempotencyKey: string) => Promise<CatalogOutcome<{ catalogItemId: string }>>
  readonly updateItem: (input: ItemEditInput, idempotencyKey: string) => Promise<CatalogOutcome<{ catalogItemId: string }>>
  readonly createAgreement: (input: NewAgreementInput, idempotencyKey: string) => Promise<CatalogOutcome<{ priceAgreementId: string }>>
  readonly endAgreement: (input: { priceAgreementId: string }, idempotencyKey: string) => Promise<CatalogOutcome<{ validTo: string }>>
}

type T = ReturnType<typeof useTranslations<'catalog'>>

const baht = (satang: string) => formatSatang(BigInt(satang))
const dayIn = (locale: string, d: string) => (locale === 'en' ? formatEnglishBeDate(d) : formatThaiDate(d))

const ITEM_LOOK: Readonly<Record<'ACTIVE' | 'INACTIVE', BadgeLook>> = { ACTIVE: { tone: 'ok', icon: 'CircleCheck' }, INACTIVE: { tone: 'neutral', icon: 'Ban' } }
const AGREEMENT_LOOK: Readonly<Record<AgreementState, BadgeLook>> = {
  IN_EFFECT: { tone: 'ok', icon: 'CircleCheck' },
  LAST_DAY: { tone: 'warn', icon: 'Hourglass' },
  UPCOMING: { tone: 'info', icon: 'Clock' },
}

/** The words of a refusal, with the reference support asks for */
function failureText(t: T, f: CatalogFailure): string {
  return t(`errors.${catalogErrorKey(f)}`, { requestId: f.requestId ?? '-' })
}

/** "เพิ่มรายการ": the page's main action, the item form in a Dialog */
export function AddItemButton({ create }: { create: CatalogManageActions['createItem'] }) {
  const t = useTranslations('catalog')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button className="min-h-11" onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden="true" />
        {t('manage.add')}
      </Button>
      {/* Drawn while open, so each opening starts from a blank form */}
      {open ? <ItemDialog open onOpenChange={setOpen} item={null} save={(v, key) => create(newItemInput(v), key)} /> : null}
    </>
  )
}

function newItemInput(v: ItemFormValues): NewItemInput {
  return { code: v.code.trim(), nameTh: v.nameTh, nameEn: v.nameEn, uom: v.uom, categoryCode: v.categoryCode, isService: v.isService, accountCode: v.accountCode, whtIncomeType: v.whtIncomeType, refUnitPrice: v.refUnitPrice }
}

/** The add and edit form of an item (the code is set once, when the item is added) */
function ItemDialog({
  open,
  onOpenChange,
  item,
  save,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: CatalogItemView | null
  save: (values: ItemFormValues, idempotencyKey: string) => Promise<CatalogOutcome<{ catalogItemId: string }>>
}) {
  const t = useTranslations('catalog')
  const id = useId()
  const action = useAction()
  const [values, setValues] = useState<ItemFormValues>(() => itemFormValues(item))
  const [checked, setChecked] = useState(false)
  const [failure, setFailure] = useState<CatalogFailure | null>(null)
  const isNew = item === null
  const errors = checked ? itemFormErrors(values, isNew) : {}
  const serverField = failure ? catalogErrorField(failure) : null
  const set = <K extends keyof ItemFormValues>(key: K, value: ItemFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }))
    setFailure(null)
  }
  const errorOf = (field: 'code' | 'nameTh' | 'uom' | 'categoryCode' | 'refUnitPrice'): string | undefined => {
    const own = errors[field]
    if (own) return t(`errors.${own}`)
    return failure && serverField === field ? failureText(t, failure) : undefined
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setChecked(true)
    setFailure(null)
    if (Object.keys(itemFormErrors(values, isNew)).length > 0) return
    const outcome = await action.run((key) => save(values, key))
    if (outcome.ok) {
      onOpenChange(false)
      action.done()
      return
    }
    setFailure(outcome)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto p-6 sm:max-w-160">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">{item ? t('item.titleEdit', { code: item.code }) : t('item.titleAdd')}</DialogTitle>
          <DialogDescription className="text-base text-ink-muted md:text-sm">{t('item.intro')}</DialogDescription>
        </DialogHeader>
        <form noValidate className="flex flex-col gap-4" onSubmit={(e) => void onSubmit(e)}>
          {failure && !serverField ? <Notice tone="danger">{failureText(t, failure)}</Notice> : null}
          {isNew ? (
            <Field id={`${id}-code`} label={t('item.code')} hint={t('item.codeHint')} value={values.code} maxLength={40} autoComplete="off" required onChange={(e) => set('code', e.currentTarget.value.toUpperCase())} error={errorOf('code')} />
          ) : null}
          <Field id={`${id}-name`} label={t('item.nameTh')} value={values.nameTh} maxLength={200} required onChange={(e) => set('nameTh', e.currentTarget.value)} error={errorOf('nameTh')} />
          <Field id={`${id}-name-en`} label={t('item.nameEn')} value={values.nameEn} maxLength={200} onChange={(e) => set('nameEn', e.currentTarget.value)} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={`${id}-uom`} label={t('item.uom')} hint={t('item.uomHint')} value={values.uom} maxLength={30} required onChange={(e) => set('uom', e.currentTarget.value)} error={errorOf('uom')} />
            <Field id={`${id}-category`} label={t('item.categoryCode')} hint={t('item.categoryHint')} value={values.categoryCode} maxLength={50} required onChange={(e) => set('categoryCode', e.currentTarget.value)} error={errorOf('categoryCode')} />
          </div>
          <Field
            id={`${id}-price`}
            label={t('item.refUnitPrice')}
            hint={t('item.refUnitPriceHint')}
            className="tabular text-right"
            inputMode="decimal"
            value={values.refUnitPrice}
            maxLength={20}
            required
            onChange={(e) => set('refUnitPrice', e.currentTarget.value)}
            error={errorOf('refUnitPrice')}
          />
          <Collapsible className="flex flex-col gap-3 border-t border-line pt-3">
            <CollapsibleTrigger className="group inline-flex min-h-11 items-center gap-2 self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
              <ChevronDown className="size-4 transition-transform duration-150 group-data-[state=open]:rotate-180" aria-hidden="true" />
              {t('item.accounting')}
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-4">
              <label className="flex min-h-11 items-center gap-3">
                <input type="checkbox" className={checkboxClass} checked={values.isService} onChange={(e) => set('isService', e.currentTarget.checked)} />
                <span>{t('item.isService')}</span>
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id={`${id}-account`} label={t('item.accountCode')} value={values.accountCode} maxLength={20} onChange={(e) => set('accountCode', e.currentTarget.value)} />
                <Field id={`${id}-wht`} label={t('item.whtIncomeType')} value={values.whtIncomeType} maxLength={20} onChange={(e) => set('whtIncomeType', e.currentTarget.value)} />
              </div>
            </CollapsibleContent>
          </Collapsible>
          {!isNew ? (
            <Switch
              id={`${id}-active`}
              label={t('item.active')}
              stateLabel={values.active ? t('status.ACTIVE') : t('status.INACTIVE')}
              hint={t('item.activeHint')}
              checked={values.active}
              onChange={(e) => set('active', e.currentTarget.checked)}
            />
          ) : null}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={action.pending}>
              {t('item.cancel')}
            </Button>
            <Button type="submit" disabled={action.pending} aria-busy={action.pending || undefined}>
              {action.pending ? t('item.saving') : isNew ? t('item.save') : t('item.saveEdit')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The add form of an agreed price: supplier, price before VAT, first and last day (both included), its source */
function AgreementDialog({
  open,
  onOpenChange,
  item,
  suppliers,
  today,
  create,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: CatalogItemView
  suppliers: readonly SupplierChoice[]
  today: string
  create: CatalogManageActions['createAgreement']
}) {
  const t = useTranslations('catalog')
  const locale = useLocale()
  const id = useId()
  const action = useAction()
  const blank = { supplierId: '', unitPrice: '', validFrom: today, lastDay: '', sourceRef: '' }
  const [values, setValues] = useState(blank)
  const [checked, setChecked] = useState(false)
  const [failure, setFailure] = useState<CatalogFailure | null>(null)
  const errors = checked ? agreementFormErrors(values, today) : {}
  const serverField = failure ? catalogErrorField(failure) : null
  const set = (key: keyof typeof blank, value: string) => {
    setValues((v) => ({ ...v, [key]: value }))
    setFailure(null)
  }
  const errorOf = (field: 'supplierId' | 'unitPrice' | 'validFrom' | 'lastDay'): string | undefined => {
    const own = errors[field]
    if (own) return t(`errors.${own}`)
    return failure && serverField === field ? failureText(t, failure) : undefined
  }
  const dayHint = (base: string, day: string) => (/^\d{4}-\d{2}-\d{2}$/.test(day) ? `${base} · ${t('agreement.chosen', { date: dayIn(locale, day) })}` : base)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setChecked(true)
    setFailure(null)
    if (Object.keys(agreementFormErrors(values, today)).length > 0) return
    const outcome = await action.run((key) => create({ catalogItemId: item.id, ...values }, key))
    if (outcome.ok) {
      onOpenChange(false)
      action.done()
      return
    }
    setFailure(outcome)
  }

  const supplierError = errorOf('supplierId')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto p-6 sm:max-w-160">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">{t('agreement.title', { name: item.nameTh })}</DialogTitle>
          <DialogDescription className="text-base text-ink-muted md:text-sm">{t('agreement.intro')}</DialogDescription>
        </DialogHeader>
        {suppliers.length === 0 ? (
          <Notice tone="warning">{t('agreement.noSuppliers')}</Notice>
        ) : (
          <form noValidate className="flex flex-col gap-4" onSubmit={(e) => void onSubmit(e)}>
            {failure && !serverField ? <Notice tone="danger">{failureText(t, failure)}</Notice> : null}
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-supplier`} className="font-medium text-ink">
                {t('agreement.supplier')}
              </label>
              <select
                id={`${id}-supplier`}
                className={inputClass}
                value={values.supplierId}
                required
                aria-invalid={supplierError ? true : undefined}
                aria-describedby={supplierError ? `${id}-supplier-error` : undefined}
                onChange={(e) => set('supplierId', e.currentTarget.value)}
              >
                <option value="">{t('agreement.supplierChoose')}</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {t('agreement.supplierOption', { code: s.code, name: s.nameTh })}
                  </option>
                ))}
              </select>
              {supplierError ? (
                <p id={`${id}-supplier-error`} className="text-base text-danger md:text-sm">
                  {supplierError}
                </p>
              ) : null}
            </div>
            <Field
              id={`${id}-price`}
              label={t('agreement.unitPrice', { uom: item.uom })}
              hint={t('agreement.reference', { amount: baht(item.refUnitPriceSatang) })}
              className="tabular text-right"
              inputMode="decimal"
              value={values.unitPrice}
              maxLength={20}
              required
              onChange={(e) => set('unitPrice', e.currentTarget.value)}
              error={errorOf('unitPrice')}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={`${id}-from`} type="date" label={t('agreement.validFrom')} hint={dayHint(t('agreement.validFromHint'), values.validFrom)} value={values.validFrom} required onChange={(e) => set('validFrom', e.currentTarget.value)} error={errorOf('validFrom')} />
              <Field id={`${id}-last`} type="date" label={t('agreement.lastDay')} hint={dayHint(t('agreement.lastDayHint'), values.lastDay)} value={values.lastDay} min={values.validFrom || today} required onChange={(e) => set('lastDay', e.currentTarget.value)} error={errorOf('lastDay')} />
            </div>
            <Field id={`${id}-source`} label={t('agreement.sourceRef')} value={values.sourceRef} maxLength={200} onChange={(e) => set('sourceRef', e.currentTarget.value)} />
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={action.pending}>
                {t('item.cancel')}
              </Button>
              <Button type="submit" disabled={action.pending} aria-busy={action.pending || undefined}>
                {action.pending ? t('item.saving') : t('agreement.save')}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** "สิ้นสุดราคาตกลง": asks first (it cannot be undone), then today is the agreed price's last day */
function EndAgreement({ item, agreement, today, end }: { item: CatalogItemView; agreement: AgreementView; today: string; end: CatalogManageActions['endAgreement'] }) {
  const t = useTranslations('catalog')
  const locale = useLocale()
  const action = useAction()
  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<CatalogFailure | null>(null)

  async function confirm() {
    setFailure(null)
    const outcome = await action.run((key) => end({ priceAgreementId: agreement.id }, key))
    if (outcome.ok) {
      setOpen(false)
      action.done()
      return
    }
    setFailure(outcome)
  }

  return (
    <>
      <Button variant="danger" className="self-start" onClick={() => setOpen(true)} aria-label={t('manage.endLabel', { supplier: agreement.supplierName, name: item.nameTh })}>
        {t('manage.end')}
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => (next ? null : setOpen(false))}>
        <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-lg font-semibold text-ink">{t('end.title', { supplier: agreement.supplierName })}</AlertDialogTitle>
            <AlertDialogDescription className="text-base text-ink-muted">{t('end.text', { today: dayIn(locale, today), name: item.nameTh })}</AlertDialogDescription>
          </AlertDialogHeader>
          {failure ? <Notice tone="danger">{failureText(t, failure)}</Notice> : null}
          <AlertDialogFooter className="gap-3">
            <AlertDialogCancel className="h-11 px-4 text-base" disabled={action.pending}>
              {t('end.keep')}
            </AlertDialogCancel>
            <Button variant="danger" onClick={() => void confirm()} disabled={action.pending} aria-busy={action.pending || undefined}>
              {action.pending ? t('item.saving') : t('end.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** The items of the manage page: each with its status, prices and agreed prices, and the buttons that change them */
export function ManageList({ items, suppliers, today, actions }: { items: readonly CatalogItemView[]; suppliers: readonly SupplierChoice[]; today: string; actions: Omit<CatalogManageActions, 'createItem'> }) {
  const t = useTranslations('catalog')
  return (
    <ul aria-label={t('manage.listLabel')} className="flex flex-col divide-y divide-line">
      {items.map((item) => (
        <ManageRow key={item.id} item={item} suppliers={suppliers} today={today} actions={actions} />
      ))}
    </ul>
  )
}

function ManageRow({ item, suppliers, today, actions }: { item: CatalogItemView; suppliers: readonly SupplierChoice[]; today: string; actions: Omit<CatalogManageActions, 'createItem'> }) {
  const t = useTranslations('catalog')
  const locale = useLocale()
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  return (
    <li className="flex flex-col gap-3 py-4" aria-label={t('manage.rowLabel', { code: item.code, name: item.nameTh })}>
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between md:gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold break-words text-ink">{item.nameTh}</span>
            <StatusBadge look={ITEM_LOOK[item.active ? 'ACTIVE' : 'INACTIVE']} label={item.active ? t('status.ACTIVE') : t('status.INACTIVE')} />
          </span>
          <span className="text-base break-words text-ink-muted md:text-sm">{t('row.meta', { code: item.code, category: item.categoryCode, uom: item.uom })}</span>
          <span className="text-base text-ink md:text-sm">{t('row.referenceLine', { amount: baht(item.refUnitPriceSatang), uom: item.uom })}</span>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setEditing(true)} aria-label={t('manage.editLabel', { code: item.code })}>
            <Pencil className="size-4" aria-hidden="true" />
            {t('manage.edit')}
          </Button>
          {item.active ? (
            <Button variant="secondary" onClick={() => setAdding(true)} aria-label={t('manage.addAgreementLabel', { name: item.nameTh })}>
              <Plus className="size-4" aria-hidden="true" />
              {t('manage.addAgreement')}
            </Button>
          ) : null}
        </div>
      </div>
      {item.agreements.length ? (
        <ul aria-label={t('manage.agreementsLabel', { name: item.nameTh })} className="flex flex-col gap-2 border-l-2 border-line pl-3">
          {item.agreements.map((a) => {
            const state = agreementState(a, today)
            return (
              <li key={a.id} className="flex flex-col gap-1.5 md:flex-row md:items-center md:justify-between md:gap-4">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusBadge look={AGREEMENT_LOOK[state]} label={t(`agreementState.${state}`)} />
                    <span className="font-medium text-ink">{t('row.agreed', { supplier: a.supplierName, amount: baht(a.unitPriceSatang), uom: item.uom })}</span>
                  </span>
                  <span className="text-base text-ink-muted md:text-sm">
                    {t('row.period', { from: dayIn(locale, a.validFrom), to: dayIn(locale, lastDayOf(a.validTo)) })}
                    {a.sourceRef ? ` · ${t('row.source', { ref: a.sourceRef })}` : ''}
                  </span>
                </div>
                {canEndAgreement(a, today) ? <EndAgreement item={item} agreement={a} today={today} end={actions.endAgreement} /> : null}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-base text-ink-muted md:text-sm">{t('row.noAgreement')}</p>
      )}
      {editing ? (
      <ItemDialog
        open
        onOpenChange={setEditing}
        item={item}
        save={(v, key) =>
          actions.updateItem(
            { catalogItemId: item.id, nameTh: v.nameTh, nameEn: v.nameEn, uom: v.uom, categoryCode: v.categoryCode, isService: v.isService, accountCode: v.accountCode, whtIncomeType: v.whtIncomeType, refUnitPrice: v.refUnitPrice, active: v.active },
            key,
          )
        }
      />
      ) : null}
      {item.active && adding ? <AgreementDialog open onOpenChange={setAdding} item={item} suppliers={suppliers} today={today} create={actions.createAgreement} /> : null}
    </li>
  )
}

