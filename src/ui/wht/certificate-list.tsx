'use client'

import { Eye } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { FileButton } from '../finance/file-button'
import { Notice } from '../form/notice'
import { Button } from '../shadcn/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table'
import { useTaxFailureText } from './failure-text'
import { NO_ANSWER, type RevealOutcome, type TaxFailure } from './outcome'

// The 50 ทวิ issued (S8-13 /finance/wht, FR-AP-104 AC5): number, payee with branch, tax id, form, date paid, amount paid
// and tax withheld (right-aligned, tabular digits). An individual payee's national id arrives masked; a member with
// wht.revealTaxId presses "ดูเลขเต็ม" — a server action that writes the SensitiveAccessLog row — and the whole number
// replaces the masked one in place with a line that the opening was logged. Only that member gets the PDF download
// (the file policy logs it again). Phones get a list instead of the table (§9.9).

export interface CertificateRowView {
  readonly id: string
  readonly number: string
  readonly form: string
  readonly paidOn: string
  readonly base: string
  readonly tax: string
  readonly payee: string
  readonly branch: string
  /** Formatted; masked for an individual payee */
  readonly taxId: string
  readonly masked: boolean
  readonly fileId: string | null
}

type Reveal = (input: { certificateId: string }) => Promise<RevealOutcome>

export function CertificateList({ rows, canReveal, reveal, open }: { rows: readonly CertificateRowView[]; canReveal: boolean; reveal: Reveal; open: (fileId: string) => Promise<string | null> }) {
  const t = useTranslations('apTax.wht')
  const failureText = useTaxFailureText()
  const [revealed, setRevealed] = useState<Readonly<Record<string, string>>>({})
  const [pending, setPending] = useState<string | null>(null)
  const [failures, setFailures] = useState<Readonly<Record<string, TaxFailure>>>({})

  async function show(row: CertificateRowView) {
    setPending(row.id)
    setFailures(({ [row.id]: _gone, ...rest }) => rest)
    let outcome: RevealOutcome
    try {
      outcome = await reveal({ certificateId: row.id })
    } catch {
      outcome = NO_ANSWER
    }
    setPending(null)
    if (outcome.ok) setRevealed((r) => ({ ...r, [row.id]: outcome.taxId }))
    else setFailures((f) => ({ ...f, [row.id]: outcome }))
  }

  const taxIdCell = (row: CertificateRowView) => {
    const whole = revealed[row.id]
    return (
      <div className="flex flex-col items-start gap-1">
        <span className="tabular">{whole ?? row.taxId}</span>
        {row.masked && !whole ? <span className="text-ink-muted">{t('maskedNote')}</span> : null}
        {whole ? (
          <Notice tone="info">
            {t('revealedNote')}
          </Notice>
        ) : null}
      </div>
    )
  }

  const actions = (row: CertificateRowView) => {
    if (!canReveal) return null
    const failure = failures[row.id]
    return (
      <div className="flex flex-col items-start gap-1">
        {row.masked && !revealed[row.id] ? (
          <Button variant="outline" className="min-h-11 lg:min-h-10" disabled={pending === row.id} aria-busy={pending === row.id || undefined} aria-label={t('revealOf', { name: row.payee })} onClick={() => void show(row)}>
            <Eye aria-hidden="true" />
            {pending === row.id ? t('revealing') : t('reveal')}
          </Button>
        ) : null}
        {row.fileId ? <FileButton fileId={row.fileId} label={t('downloadOf', { number: row.number })} busyLabel={t('downloading')} failedText={t('downloadFailed')} open={open} /> : null}
        {failure ? <Notice tone="danger">{failureText(failure)}</Notice> : null}
      </div>
    )
  }

  return (
    <>
      <Table aria-label={t('list')} className="hidden text-base md:table md:text-sm">
        <TableHeader>
          <TableRow>
            <TableHead>{t('columns.number')}</TableHead>
            <TableHead>{t('columns.payee')}</TableHead>
            <TableHead>{t('columns.taxId')}</TableHead>
            <TableHead>{t('columns.form')}</TableHead>
            <TableHead>{t('columns.paidOn')}</TableHead>
            <TableHead className="text-right">{t('columns.base')}</TableHead>
            <TableHead className="text-right">{t('columns.tax')}</TableHead>
            {canReveal ? <TableHead>{t('columns.actions')}</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="align-top">{row.number}</TableCell>
              <TableCell className="align-top whitespace-normal">
                {row.payee}
                <span className="block text-ink-muted">{t('branch', { branch: row.branch })}</span>
              </TableCell>
              <TableCell className="align-top">{taxIdCell(row)}</TableCell>
              <TableCell className="align-top">{row.form}</TableCell>
              <TableCell className="align-top">{row.paidOn}</TableCell>
              <TableCell className="tabular text-right align-top">{row.base}</TableCell>
              <TableCell className="tabular text-right align-top">{row.tax}</TableCell>
              {canReveal ? <TableCell className="align-top whitespace-normal">{actions(row)}</TableCell> : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ul aria-label={t('list')} className="flex flex-col divide-y divide-line border-y border-line md:hidden">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-col gap-1.5 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{row.number}</span>
              <span className="text-ink-muted">{`${row.form} · ${row.paidOn}`}</span>
            </div>
            <span>{`${row.payee} · ${t('branch', { branch: row.branch })}`}</span>
            {taxIdCell(row)}
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
              <dt className="text-ink-muted">{t('columns.base')}</dt>
              <dd className="tabular text-right">{row.base}</dd>
              <dt className="text-ink-muted">{t('columns.tax')}</dt>
              <dd className="tabular text-right">{row.tax}</dd>
            </dl>
            {actions(row)}
          </li>
        ))}
      </ul>
    </>
  )
}
