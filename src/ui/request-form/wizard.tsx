'use client'

import { Check, CircleAlert, Info } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from '../cn'
import { Badge } from '../shadcn/badge'
import { Item, ItemContent, ItemMedia, ItemTitle } from '../shadcn/item'
import { Progress } from '../shadcn/progress'
import { BudgetLineField, FormFields, LinesSection, TitleField, type StepProps } from './details-items'
import { documentFieldIds } from './document-fields'
import { kindLabelOf, OtherFiles, Quotations, RulesSection, type DocumentsProps } from './documents-step'
import type { PlannedStep } from './form-steps'
import type { RuleStatus } from './model'
import { DeliverySiteField, SuggestedSupplierField } from './place-supplier'
import { BudgetStatus, RoutePreview } from './summary'
import type { RouteView } from './types'

// The parts of the workspace's step-by-step request form (FR-INT-011, §9.10): the vertical list of steps on the left
// (Item and Progress: shadcn/ui has no stepper), the "ขั้น n จาก m" bar of a smaller screen, the body of one step from
// the plan of ./form-steps.ts, and the "ก่อนส่ง" panel on the right of a wide screen (AC4) — what is left on the budget
// line, the expected route with its explanation, and the documents the rules ask for at the current amount.

export interface NamedStep {
  readonly step: PlannedStep
  readonly name: string
}

/**
 * The steps, numbered as the real sequence they are (§9.9): the current one in --primary and bold with a bar on its left,
 * those passed with a check, an optional one labelled "ไม่บังคับ" — weight, mark and words, never colour alone. A step
 * passed or the current one may be opened; the ones ahead come by "ถัดไป", which checks the step first (AC3).
 */
export function StepList({ steps, current, furthest, onSelect }: { steps: readonly NamedStep[]; current: number; furthest: number; onSelect: (index: number) => void }) {
  const t = useTranslations('requestForm.wizard')
  return (
    <nav aria-label={t('label')}>
      <ol className="flex flex-col gap-1">
        {steps.map(({ step, name }, i) => {
          const here = i === current
          const passed = i < current || (i <= furthest && !here)
          const open = i <= furthest
          return (
            <li key={step.key}>
              <Item
                asChild
                size="sm"
                className={cn(
                  'min-h-11 rounded-md border-l-4 border-transparent text-left text-base md:text-sm',
                  here ? 'border-l-primary bg-primary-tint font-semibold text-primary' : 'text-ink',
                  open && !here ? 'hover:bg-surface' : null,
                )}
              >
                <button type="button" aria-current={here ? 'step' : undefined} disabled={!open} onClick={() => onSelect(i)} className="disabled:cursor-not-allowed disabled:text-ink-muted">
                  <ItemMedia className="w-5">
                    {passed ? <Check className="size-4 text-primary" aria-hidden="true" /> : <span className="tabular">{i + 1}</span>}
                  </ItemMedia>
                  <ItemContent className="gap-0.5">
                    <ItemTitle className="text-base font-[inherit] md:text-sm">
                      <span className="sr-only">{t('number', { n: i + 1 })} </span>
                      {name}
                      {passed ? <span className="sr-only"> ({t('passed')})</span> : null}
                    </ItemTitle>
                    {step.optional ? (
                      <Badge variant="outline" className="text-sm text-ink-muted">
                        {t('optional')}
                      </Badge>
                    ) : null}
                  </ItemContent>
                </button>
              </Item>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/** A smaller screen's bar: "ขั้น 2 จาก 5" and the step's name over a progress line (AC1) */
export function StepBar({ current, total, name }: { current: number; total: number; name: string }) {
  const t = useTranslations('requestForm.wizard')
  return (
    <div className="flex flex-col gap-2">
      <p className="flex flex-wrap gap-x-2 text-base md:text-sm">
        <span className="font-semibold text-primary">{t('progress', { n: current + 1, total })}</span>
        <span className="text-ink-muted">{name}</span>
      </p>
      <Progress value={((current + 1) / total) * 100} aria-label={t('progress', { n: current + 1, total })} className="h-1.5" />
    </div>
  )
}

/** One step's body: the parts and fields the plan puts on it, in a fixed order */
export function StepBody({ step, props, documents, endDateRequired }: { step: PlannedStep; props: StepProps; documents: DocumentsProps; endDateRequired: boolean }) {
  const t = useTranslations('requestForm')
  const has = (part: PlannedStep['sections'][number]) => step.sections.includes(part)
  const asked = documentFieldIds(props.data.form.rules)
  // The questions the rules ask for are asked by the rules' own part, under them (./document-fields.ts)
  const fields = has('rules') ? step.fields.filter((id) => !asked.has(id)) : step.fields
  return (
    <div className="@container flex flex-col gap-6">
      {has('title') ? <TitleField {...props} /> : null}
      {has('budgetLine') ? <BudgetLineField {...props} /> : null}
      {has('supplier') ? <SuggestedSupplierField {...props} /> : null}
      {has('rules') ? <RulesSection {...documents} /> : null}
      <FormFields {...props} ids={fields} />
      {has('deliverySite') ? <DeliverySiteField {...props} /> : null}
      {has('lines') ? <LinesSection {...props} endDateRequired={endDateRequired} /> : null}
      {has('quotations') ? <Quotations {...documents} /> : null}
      {has('files') ? <OtherFiles {...documents} kindLabel={(kind) => kindLabelOf(t, kind)} /> : null}
    </div>
  )
}

/**
 * "ก่อนส่ง" (AC4, §9.9 principle 3): told beforehand, on every step of a wide screen — the chosen line's balance against
 * the amount before VAT, the route the request would take now with its explanation, and the documents the rules ask for
 * at the current amount and answers, each met or not in words and an icon. A smaller screen has it on the check step.
 */
export function BeforeSendPanel({ props, rules, route, purchase }: { props: StepProps; rules: readonly RuleStatus[]; route: RouteView | null; purchase: boolean }) {
  const t = useTranslations('requestForm')
  const { values, budget, totals, previewLoading, locale } = props
  return (
    <aside aria-labelledby="before-send" className="flex flex-col gap-5 rounded-md border border-line bg-bg p-4">
      <h2 id="before-send" className="text-lg font-semibold">
        {t('wizard.beforeSend')}
      </h2>
      {purchase ? (
        <section aria-labelledby="before-send-budget" className="flex flex-col gap-2">
          <h3 id="before-send-budget" className="font-semibold">
            {t('budget.title')}
          </h3>
          <BudgetStatus lineChosen={Boolean(values.budgetLineId)} budget={budget} need={totals?.net ?? null} loading={previewLoading} />
        </section>
      ) : null}
      <section aria-labelledby="before-send-route" className="flex flex-col gap-2">
        <h3 id="before-send-route" className="font-semibold">
          {t('route.title')}
        </h3>
        <RoutePreview route={purchase ? route : { kind: 'NO_ROUTE' }} loading={previewLoading} locale={locale} reported={false} />
      </section>
      <section aria-labelledby="before-send-documents" className="flex flex-col gap-2">
        <h3 id="before-send-documents" className="font-semibold">
          {t('documents.requiredTitle')}
        </h3>
        {rules.length === 0 ? (
          <p className="text-ink-muted">{t('documents.noneRequired')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3">
                <span>{t('documents.rule', { rule: r.id })}</span>
                {r.met ? (
                  <span className="inline-flex items-center gap-1 text-ink">
                    <Info className="size-4 text-info" aria-hidden="true" />
                    {t('documents.met')}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-danger">
                    <CircleAlert className="size-4" aria-hidden="true" />
                    {t('documents.notMet')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}
