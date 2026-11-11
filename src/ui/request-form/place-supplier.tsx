'use client'

import { useTranslations } from 'next-intl'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { lineAgreement } from './catalog-lines'
import { describedBy, inputClass, Labelled, textareaClass } from './controls'
import type { StepProps } from './details-items'
import { showDay } from './field-input'
import { droppedChoice } from './model'
import { lastPreferredDay, preferredProblems, preferredState, showsPreferredReason } from './preferred'
import type { PreferredSupplierOption, ScreenLocale } from './types'

// Where the goods go and the supplier the requester suggests (S4-02, FR-INT-003 AC1, BR-FORM-02, BR-CONS-01). The site
// opens the items step because it applies to every line of the request; the form fills it with the site of the
// requester's latest request (or the organization's only site) and the requester may change it or leave it open. The
// suggested supplier is optional and sits with the quotations: PROCUREMENT chooses the supplier of each line
// (FR-P2P-001 AC2). Neither is a field the requester must type (FR-INT-003 AC3). The server checks both on every save.
// S10-13 (BR-FORM-12 · BR-RFX-14): a catalogue line whose category has a preferred supplier in effect labels it when it is
// the one suggested ("แนะนำจากการจัดหา AWD-… ถึง …"), and warns when another (or none) is — then the reason is asked before
// sending, unless the preferred one carries a risk S11 would stop it for (RISK on). The requester may always choose
// another: the preferred supplier is where the form starts, not a rule.

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

export function SuggestedSupplierField(props: StepProps) {
  const { data, values, update } = props
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
      <PreferredNotices {...props} />
    </section>
  )
}

type PreferredT = ReturnType<typeof useTranslations<'requestForm.preferred'>>

/** "แนะนำจากการจัดหา AWD-… ถึง 8 พ.ย. 2570" or, for one procurement set, "แนะนำโดยฝ่ายจัดซื้อ ถึง …" */
function sourceText(t: PreferredT, p: PreferredSupplierOption, locale: ScreenLocale): string {
  const until = showDay(lastPreferredDay(p.validTo), locale)
  return p.awardNumber ? t('fromAward', { award: p.awardNumber, until }) : t('manual', { until })
}

/** With RISK on: the tier and the status that make it "recommended but at risk" (BR-RFX-14); null with RISK off */
function riskText(t: PreferredT, p: PreferredSupplierOption): string | null {
  if (!p.risk) return null
  const parts: string[] = []
  if (p.risk.tier) parts.push(t('tier', { tier: p.risk.tier }))
  if (p.risk.status === 'OVERDUE' || p.risk.status === 'REASSESS_REQUIRED') parts.push(t(`status.${p.risk.status}`))
  if (p.risk.registryFlag === 'CEASED' || p.risk.registryFlag === 'VAT_CANCELLED') parts.push(t(`flag.${p.risk.registryFlag}`))
  if (parts.length === 0) return null
  return p.riskExempt ? t('atRisk', { risk: parts.join(' · ') }) : parts.join(' · ')
}

/**
 * S10-13: the preferred suppliers of the lines' categories — the one suggested, labelled; the ones left, with the way back
 * to them and the reason box (BR-FORM-12). Nothing in a form that does not know the categories (values.preferred absent).
 */
function PreferredNotices({ data, values, update, locale, showErrors }: StepProps) {
  const t = useTranslations('requestForm.preferred')
  const tf = useTranslations('requestForm.fields')
  if (!values.preferred || values.preferred.length === 0) return null
  const state = preferredState(values)
  const offered = new Set((data.suppliers ?? []).map((s) => s.id))
  const missing = preferredProblems(values).length > 0
  const error = showErrors && missing ? t('reasonMissing') : undefined
  return (
    <>
      {state.kept.map((p) => {
        const risk = riskText(t, p)
        return (
          <Notice key={p.id} tone="info">
            <span className="block">{t('kept', { source: sourceText(t, p, locale), category: p.categoryCode })}</span>
            {risk ? <span className="block">{risk}</span> : null}
          </Notice>
        )
      })}
      {state.left.map((p) => {
        const risk = riskText(t, p)
        return (
          <Notice key={p.id} tone="warning">
            <span className="block">{t('left', { category: p.categoryCode, source: sourceText(t, p, locale), code: p.supplierCode, name: p.supplierName })}</span>
            {risk ? <span className="block">{risk}</span> : null}
            <span className="block">{p.riskExempt ? t('leftAtRisk') : t('leftAsk')}</span>
            {offered.has(p.supplierId) ? (
              <Button variant="link" className="mt-1" onClick={() => update({ type: 'suggestedSupplier', value: p.supplierId })}>
                {t('useIt', { code: p.supplierCode })}
              </Button>
            ) : null}
          </Notice>
        )
      })}
      {showsPreferredReason(values) ? (
        <Labelled id="preferred-override-reason" label={t('reasonLabel')} requiredText={missing ? tf('required') : undefined} hint={t('reasonHint')} error={error} className="max-w-xl">
          <textarea
            id="preferred-override-reason"
            name="preferredSupplierOverrideReason"
            className={textareaClass}
            value={values.preferredSupplierOverrideReason ?? ''}
            maxLength={REASON_MAX_LENGTH}
            aria-required={missing || undefined}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy('preferred-override-reason', true, Boolean(error))}
            onChange={(e) => update({ type: 'preferredReason', value: e.currentTarget.value })}
          />
        </Labelled>
      ) : null}
    </>
  )
}

/** The site and the supplier as the summary of the last step says them */
export function placeAndSupplierText(data: StepProps['data'], values: StepProps['values']): { site: { code: string; name: string } | null; supplier: { code: string; name: string } | null } {
  const site = (data.deliverySites ?? []).find((s) => s.id === values.deliverySiteId) ?? null
  const supplier = (data.suppliers ?? []).find((s) => s.id === values.suggestedSupplierId) ?? null
  return { site: site ? { code: site.code, name: site.name } : null, supplier: supplier ? { code: supplier.code, name: supplier.name } : null }
}
