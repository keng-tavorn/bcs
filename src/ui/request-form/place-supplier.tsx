'use client'

import { useTranslations } from 'next-intl'
import { Notice } from '../form/notice'
import { lineAgreement } from './catalog-lines'
import { describedBy, inputClass, Labelled } from './controls'
import type { StepProps } from './details-items'
import { droppedChoice } from './model'

// Where the goods go and the supplier the requester suggests (S4-02, FR-INT-003 AC1, BR-FORM-02, BR-CONS-01). The site
// opens the items step because it applies to every line of the request; the form fills it with the site of the
// requester's latest request (or the organization's only site) and the requester may change it or leave it open. The
// suggested supplier is optional and sits with the quotations: PROCUREMENT chooses the supplier of each line
// (FR-P2P-001 AC2). Neither is a field the requester must type (FR-INT-003 AC3). The server checks both on every save.

export function DeliverySiteField({ data, values, update }: StepProps) {
  const t = useTranslations('requestForm.site')
  const sites = data.deliverySites ?? []
  if (sites.length === 0) return null
  const chosen = sites.find((s) => s.id === values.deliverySiteId) ?? null
  // A new form that opened with the site BR-FORM-02 gave it
  const prefilled = !data.draft && chosen !== null && chosen.id === data.defaultDeliverySiteId
  const dropped = !values.deliverySiteId && droppedChoice(data.draft?.deliverySiteId, sites)
  return (
    <div className="flex flex-col gap-3">
      <Labelled
        id="delivery-site"
        label={t('label')}
        className="max-w-xl"
        hint={
          <>
            <span className="block">{prefilled ? t('prefilled') : t('hint')}</span>
            {chosen?.address ? <span className="block">{t('address', { address: chosen.address })}</span> : null}
          </>
        }
      >
        <select
          id="delivery-site"
          name="deliverySiteId"
          className={inputClass}
          value={values.deliverySiteId}
          aria-describedby={describedBy('delivery-site', true, false)}
          onChange={(e) => update({ type: 'deliverySite', value: e.currentTarget.value })}
        >
          <option value="">{t('none')}</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {t('option', { code: s.code, name: s.name })}
            </option>
          ))}
        </select>
      </Labelled>
      {dropped ? <Notice tone="warning">{t('dropped')}</Notice> : null}
    </div>
  )
}

export function SuggestedSupplierField({ data, values, update }: StepProps) {
  const t = useTranslations('requestForm.supplier')
  const tc = useTranslations('requestForm.catalog')
  // S6-10 (BR-PRC-06): catalogue lines whose agreed prices are with other suppliers than the one suggested
  const off = values.lines.filter((l) => lineAgreement(l, values).kind === 'OFF').length
  const suppliers = data.suppliers ?? []
  const dropped = !values.suggestedSupplierId && droppedChoice(data.draft?.suggestedSupplierId, suppliers)
  return (
    <section aria-labelledby="suggested-supplier-heading" className="flex flex-col gap-3">
      <h3 id="suggested-supplier-heading" className="subheading font-semibold">
        {t('title')}
      </h3>
      {suppliers.length === 0 ? (
        <p className="text-ink-muted">{t('noneInRegister')}</p>
      ) : (
        <Labelled id="suggested-supplier" label={t('label')} hint={t('hint')} className="max-w-xl">
          <select
            id="suggested-supplier"
            name="suggestedSupplierId"
            className={inputClass}
            value={values.suggestedSupplierId}
            aria-describedby={describedBy('suggested-supplier', true, false)}
            onChange={(e) => update({ type: 'suggestedSupplier', value: e.currentTarget.value })}
          >
            <option value="">{t('none')}</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {t('option', { code: s.code, name: s.name })}
              </option>
            ))}
          </select>
        </Labelled>
      )}
      {dropped ? <Notice tone="warning">{t('dropped')}</Notice> : null}
      {off ? <Notice tone="warning">{tc('supplierOff', { count: off })}</Notice> : null}
    </section>
  )
}

/** The site and the supplier as the summary of the last step says them */
export function placeAndSupplierText(data: StepProps['data'], values: StepProps['values']): { site: { code: string; name: string } | null; supplier: { code: string; name: string } | null } {
  const site = (data.deliverySites ?? []).find((s) => s.id === values.deliverySiteId) ?? null
  const supplier = (data.suppliers ?? []).find((s) => s.id === values.suggestedSupplierId) ?? null
  return { site: site ? { code: site.code, name: site.name } : null, supplier: supplier ? { code: supplier.code, name: supplier.name } : null }
}
