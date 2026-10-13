'use client'

import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { Button } from '../../form/button'
import { Notice } from '../../form/notice'
import { Badge } from '../../shadcn/badge'
import { Combobox } from '../../shadcn/combobox'
import { Input } from '../../shadcn/input'
import { Label } from '../../shadcn/label'
import type { ApOutcome } from './outcome'
import { useApAction, useApErrorText } from './use-ap-action'

/** One line's coding as the form starts it: what is confirmed, else what is suggested */
export interface CodingLineView {
  readonly id: string
  readonly lineNo: number
  readonly description: string
  readonly accountCode: string | null
  readonly costCenterId: string | null
  readonly costCenterReason: string
  readonly whtIncomeTypeCode: string | null
  readonly budgetCostCenterId: string
  readonly confirmed: boolean
  /** The suggestion and where it came from (BR-AP-10): "ใช้ 3 ครั้งใน 12 เดือน", "จากบรรทัดงบ" */
  readonly suggestion: { readonly accountCode: string | null; readonly sourceText: string } | null
}

export interface CodingChoices {
  readonly accountCodes: ReadonlyArray<{ readonly value: string; readonly label: string }>
  readonly costCenters: ReadonlyArray<{ readonly value: string; readonly label: string }>
  /** The income types, "none" first; the label says when a rate is not confirmed */
  readonly incomeTypes: ReadonlyArray<{ readonly value: string; readonly label: string }>
}

/** The value of "no withholding" in the list of income types: never a code (codes are A-Z, 0-9 and _) */
export const NO_WITHHOLDING = '-'

/**
 * The account code, cost center and withholding income type of every line of a draft (FR-AP-108, BR-AP-10, BR-WHT-03):
 * each line starts with what was confirmed before, else the suggestion — the code the history of the same supplier and
 * category used most, or the budget line's — shown with its source beside it. Another cost center than the budget
 * line's needs a reason (the budget does not change). One button confirms every line (invoice.confirmCoding) with the
 * version read; the service checks the codes are active and the member is FINANCE. No AI (FR-AP-108 AC3).
 */
export function CodingForm({
  invoiceId,
  version,
  lines,
  choices,
  confirm,
}: {
  invoiceId: string
  version: number
  lines: readonly CodingLineView[]
  choices: CodingChoices
  confirm: (input: unknown, idempotencyKey: string) => Promise<ApOutcome>
}) {
  const t = useTranslations('apInvoice')
  const errorText = useApErrorText()
  const action = useApAction()
  const id = useId()
  const [rows, setRows] = useState(() =>
    Object.fromEntries(
      lines.map((l) => [
        l.id,
        {
          accountCode: l.accountCode ?? l.suggestion?.accountCode ?? null,
          costCenterId: l.costCenterId ?? l.budgetCostCenterId,
          reason: l.costCenterReason,
          incomeType: l.whtIncomeTypeCode ?? NO_WITHHOLDING,
        },
      ]),
    ),
  )
  const [missing, setMissing] = useState(false)
  const [done, setDone] = useState(false)

  const set = (lineId: string, patch: Partial<(typeof rows)[string]>) => {
    setRows((all) => ({ ...all, [lineId]: { ...all[lineId]!, ...patch } }))
    setDone(false)
    setMissing(false)
  }

  async function onConfirm() {
    const incomplete = lines.some((l) => {
      const r = rows[l.id]!
      return !r.accountCode || !r.costCenterId || (r.costCenterId !== l.budgetCostCenterId && !r.reason.trim())
    })
    if (incomplete) return setMissing(true)
    const outcome = await action.run((key) =>
      confirm(
        {
          invoiceId,
          version,
          lines: lines.map((l) => {
            const r = rows[l.id]!
            return {
              invoiceLineId: l.id,
              accountCode: r.accountCode,
              costCenterId: r.costCenterId,
              ...(r.costCenterId !== l.budgetCostCenterId ? { costCenterReason: r.reason } : {}),
              whtIncomeTypeCode: r.incomeType === NO_WITHHOLDING ? null : r.incomeType,
            }
          }),
        },
        key,
      ),
    )
    setDone(outcome.ok)
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-ink-muted">{t('coding.hint')}</p>
      <ul aria-label={t('coding.title')} className="flex flex-col divide-y divide-line border-y border-line">
        {lines.map((l) => {
          const r = rows[l.id]!
          const other = r.costCenterId !== l.budgetCostCenterId
          return (
            <li key={l.id} className="flex flex-col gap-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium break-words text-ink">{t('coding.line', { no: l.lineNo, description: l.description })}</span>
                <Badge variant={l.confirmed ? 'ok' : 'neutral'}>{l.confirmed ? t('coding.confirmed') : t('coding.notConfirmed')}</Badge>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${id}-code-${l.lineNo}`} className="text-base text-ink">
                    {t('coding.accountCode', { no: l.lineNo })}
                  </Label>
                  <Combobox
                    id={`${id}-code-${l.lineNo}`}
                    options={choices.accountCodes}
                    value={r.accountCode}
                    onValueChange={(v) => v && set(l.id, { accountCode: v })}
                    placeholder={t('coding.pickCode')}
                    searchPlaceholder={t('coding.searchCode')}
                    emptyText={t('coding.noCode')}
                    className="min-h-11 text-base"
                  />
                  <span className="text-base text-ink-muted md:text-sm">
                    {l.suggestion?.accountCode ? `${t('coding.suggested', { code: l.suggestion.accountCode })} · ${l.suggestion.sourceText}` : t('coding.noSuggestion')}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${id}-cc-${l.lineNo}`} className="text-base text-ink">
                    {t('coding.costCenter', { no: l.lineNo })}
                  </Label>
                  <Combobox
                    id={`${id}-cc-${l.lineNo}`}
                    options={choices.costCenters}
                    value={r.costCenterId}
                    onValueChange={(v) => v && set(l.id, { costCenterId: v })}
                    placeholder={t('coding.pickCenter')}
                    searchPlaceholder={t('coding.searchCenter')}
                    emptyText={t('coding.noCenter')}
                    className="min-h-11 text-base"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${id}-wht-${l.lineNo}`} className="text-base text-ink">
                    {t('coding.incomeType', { no: l.lineNo })}
                  </Label>
                  <Combobox
                    id={`${id}-wht-${l.lineNo}`}
                    options={choices.incomeTypes}
                    value={r.incomeType}
                    onValueChange={(v) => v && set(l.id, { incomeType: v })}
                    placeholder={t('coding.pickType')}
                    searchPlaceholder={t('coding.searchType')}
                    emptyText={t('coding.noType')}
                    className="min-h-11 text-base"
                  />
                </div>
              </div>
              {other ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${id}-reason-${l.lineNo}`} className="text-base text-ink">
                    {t('coding.reason', { no: l.lineNo })}
                  </Label>
                  <Input
                    id={`${id}-reason-${l.lineNo}`}
                    value={r.reason}
                    maxLength={500}
                    onChange={(e) => set(l.id, { reason: e.target.value })}
                    aria-describedby={`${id}-reason-${l.lineNo}-hint`}
                    aria-invalid={(missing && !r.reason.trim()) || undefined}
                    className="h-11 text-base"
                  />
                  <span id={`${id}-reason-${l.lineNo}-hint`} className="text-base text-ink-muted md:text-sm">
                    {t('coding.reasonHint')}
                  </span>
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
      <Button className="self-start" disabled={action.pending} aria-busy={action.pending || undefined} onClick={() => void onConfirm()}>
        {action.pending ? t('coding.confirming') : t('coding.confirm')}
      </Button>
      {missing ? <Notice tone="danger">{t('coding.missing')}</Notice> : null}
      {action.outcome && !action.outcome.ok ? <Notice tone="danger">{errorText(action.outcome)}</Notice> : null}
      {done ? <Notice tone="success">{t('coding.done')}</Notice> : null}
    </div>
  )
}
