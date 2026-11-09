'use client'

import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { formatDay } from '../liff/delegation/day'
import { useState, type ReactNode } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { Badge } from '../shadcn/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table'
import { Textarea } from '../shadcn/textarea'

// The documents of a supplier on /suppliers/[id] (S7-06 · BR-SDOC ข้อ 03 ข้อ 05): each document with its dates and state;
// PROCUREMENT verifies or rejects a PENDING one whose file was scanned clean; opening a file is a POST that answers a
// URL of five minutes (a sensitive type is logged). The server checks every right again. S7-09: a list under 768 px.

export interface DocumentRow {
  readonly id: string
  readonly version: number
  readonly typeNameTh: string
  readonly typeNameEn: string
  readonly sensitive: boolean
  readonly scope: string | null
  readonly issuedOn: string
  readonly expiresOn: string
  readonly status: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED' | 'SUPERSEDED'
  readonly scanStatus: string
}

export type DocumentActionResult = { readonly ok: true; readonly url?: string } | { readonly ok: false; readonly code: string }

export interface DocumentActions {
  verify(documentId: string, version: number, key: string): Promise<DocumentActionResult>
  reject(documentId: string, version: number, reason: string, key: string): Promise<DocumentActionResult>
  open(documentId: string, key: string): Promise<DocumentActionResult>
}

const KNOWN = ['FORBIDDEN', 'VALIDATION_FAILED', 'FILE_NOT_SCANNED', 'FILE_INFECTED', 'CONFLICT_VERSION'] as const
const TONE = { PENDING: 'outline', VERIFIED: 'secondary', REJECTED: 'destructive', EXPIRED: 'destructive', SUPERSEDED: 'outline' } as const

export function DocumentsPanel({ rows, canVerify, actions }: { readonly rows: readonly DocumentRow[]; readonly canVerify: boolean; readonly actions: DocumentActions }) {
  const t = useTranslations('supplierDocs')
  const locale = useLocale()
  const router = useRouter()
  const { key, next } = useSubmissionKey()
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(fn: () => Promise<DocumentActionResult>) {
    setBusy(true)
    setError(null)
    const r = await fn()
    setBusy(false)
    next()
    if (!r.ok) return setError(r.code)
    if (r.url) window.open(r.url, '_blank', 'noopener')
    setRejecting(null)
    setReason('')
    router.refresh()
  }

  if (rows.length === 0) return <p className="text-ink-muted">{t('documents.empty')}</p>
  const known = error && (KNOWN as readonly string[]).includes(error) ? (error as (typeof KNOWN)[number]) : null

  const type = (d: DocumentRow): ReactNode => (
    <div className="flex flex-col">
      <span className="font-medium">{locale === 'en' ? d.typeNameEn : d.typeNameTh}</span>
      {d.scope ? <span className="text-base text-ink-muted md:text-sm">{d.scope}</span> : null}
      {d.sensitive ? <span className="text-base text-ink-muted md:text-sm">{t('documents.sensitiveNote')}</span> : null}
    </div>
  )
  const dates = (d: DocumentRow): ReactNode => (
    <span className="tabular">
      {formatDay(d.issuedOn, locale) ?? d.issuedOn} – {formatDay(d.expiresOn, locale) ?? d.expiresOn}
    </span>
  )
  const state = (d: DocumentRow): ReactNode => (
    <div className="flex flex-col gap-1">
      <Badge variant={TONE[d.status]} className="self-start">
        {t(`documents.status.${d.status}`)}
      </Badge>
      {d.scanStatus === 'PENDING' || d.scanStatus === 'INFECTED' ? <span className="text-base text-ink-muted md:text-sm">{t(`documents.scan.${d.scanStatus}`)}</span> : null}
    </div>
  )
  const act = (d: DocumentRow, where: 'table' | 'list'): ReactNode => {
    const clean = d.scanStatus === 'CLEAN'
    return (
      <>
        <div className="flex flex-wrap gap-2">
          {clean ? (
            <Button variant="secondary" disabled={busy} onClick={() => run(() => actions.open(d.id, key))}>
              {t('documents.download')}
            </Button>
          ) : null}
          {canVerify && d.status === 'PENDING' && clean ? (
            <>
              <Button disabled={busy} onClick={() => run(() => actions.verify(d.id, d.version, key))}>
                {t('documents.verify')}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => setRejecting(rejecting === d.id ? null : d.id)}>
                {t('documents.reject')}
              </Button>
            </>
          ) : null}
        </div>
        {rejecting === d.id ? (
          <div className="mt-2 flex flex-col gap-2">
            <label htmlFor={`reason-${where}-${d.id}`} className="font-medium">
              {t('documents.rejectReason')}
            </label>
            <Textarea id={`reason-${where}-${d.id}`} value={reason} onChange={(e) => setReason(e.target.value)} />
            <Button disabled={busy || reason.trim().length < 3} onClick={() => run(() => actions.reject(d.id, d.version, reason, key))} className="self-start">
              {t('documents.confirmReject')}
            </Button>
          </div>
        ) : null}
      </>
    )
  }

  // A table from 768 px; under it the same as a list, so the page never scrolls sideways on a phone (§9.9). Only one of
  // the two is drawn (the other is display: none, out of the accessibility tree); the reason's id names its layout.
  return (
    <div className="flex flex-col gap-3">
      {error ? <Notice tone="danger">{known ? t(`errors.${known}`) : t('errors.FAILED')}</Notice> : null}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('documents.columns.type')}</TableHead>
              <TableHead>{t('documents.columns.dates')}</TableHead>
              <TableHead>{t('documents.columns.status')}</TableHead>
              <TableHead>{t('documents.columns.action')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((d) => (
              <TableRow key={d.id}>
                <TableCell className="align-top whitespace-normal">{type(d)}</TableCell>
                <TableCell className="align-top">{dates(d)}</TableCell>
                <TableCell className="align-top">{state(d)}</TableCell>
                <TableCell className="align-top whitespace-normal">{act(d, 'table')}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="flex flex-col divide-y divide-line md:hidden">
        {rows.map((d) => (
          <li key={d.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
            {type(d)}
            <span className="text-base text-ink md:text-sm">
              {t('documents.columns.dates')}: {dates(d)}
            </span>
            {state(d)}
            {act(d, 'list')}
          </li>
        ))}
      </ul>
    </div>
  )
}
