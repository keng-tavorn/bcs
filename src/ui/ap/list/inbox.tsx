'use client'

import { CircleAlert } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useId, useMemo, useState } from 'react'
import { useSubmissionKey } from '../../form/submission-key'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../../shadcn/alert-dialog'
import { Button } from '../../shadcn/button'
import { Combobox } from '../../shadcn/combobox'
import { Label } from '../../shadcn/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../shadcn/table'
import { Textarea } from '../../shadcn/textarea'
import { InboxStatusBadge } from './badges'
import { apErrorKey } from './failure'
import { AP_NO_ANSWER, type ApDoneOutcome, type ApDraftOutcome, type ApPollOutcome } from './outcome'

// The invoice inbox (S8-13, FR-AP-101 AC2, BR-AP-02): every message the inbox kept — when it came, who sent it, its
// subject and the PO numbers found in it, the drafts made from its files (links), the files that wait for FINANCE to
// choose their PO (a Combobox of the POs that can take an invoice, the sender's first, searched by PO number or
// supplier), the files not taken with why, and its status badge with the reason. "ดึงอีเมลตอนนี้" reads the inbox at once
// (a POST); a message is skipped with a reason in an AlertDialog (it cannot be undone). One table: on a phone each row
// stacks its cells with their names, so nothing scrolls sideways (§9.9). Strings arrive translated; the server
// actions arrive as props. Results stay as a line next to the control (§9.9).

export interface InboxPoOption {
  readonly value: string
  readonly label: string
  readonly number: string | null
  readonly supplierId: string
}

export interface InboxRowView {
  readonly id: string
  readonly received: string
  readonly from: string
  readonly subject: string
  readonly poRefs: string | null
  readonly status: string
  readonly statusLabel: string
  readonly statusNotes: readonly string[]
  readonly drafts: ReadonlyArray<{ readonly id: string; readonly href: string; readonly label: string }>
  readonly waiting: ReadonlyArray<{ readonly fileId: string; readonly fileName: string }>
  readonly skipped: readonly string[]
  readonly refs: readonly string[]
  readonly senderSupplierId: string | null
  readonly canIgnore: boolean
}

type Poll = () => Promise<ApPollOutcome>
type Ignore = (input: { inboundEmailId: string; reason: string }, idempotencyKey: string) => Promise<ApDoneOutcome>
type FromInbox = (input: { inboundEmailId: string; fileId: string; poId: string }, idempotencyKey: string) => Promise<ApDraftOutcome>

const ERROR_LINE = 'flex items-start gap-1.5 text-danger'
const CELL_NAME = 'font-medium text-ink lg:hidden'

/** "ดึงอีเมลตอนนี้": reads the inbox now and says what came */
export function PollButton({ poll }: { poll: Poll }) {
  const t = useTranslations('apList.inbox.poll')
  const te = useTranslations('apList.errors')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<ApPollOutcome | null>(null)
  async function run() {
    setBusy(true)
    setOutcome(null)
    let result: ApPollOutcome
    try {
      result = await poll()
    } catch {
      result = AP_NO_ANSWER
    }
    setBusy(false)
    setOutcome(result)
    if (result.ok) router.refresh()
  }
  return (
    <div className="flex flex-col items-start gap-1.5 md:items-end">
      <Button type="button" disabled={busy} className="min-h-11 px-4 text-base md:text-base lg:min-h-10" onClick={() => void run()}>
        {busy ? t('busy') : t('button')}
      </Button>
      <div aria-live="polite" className="max-w-md md:text-right">
        {outcome?.ok ? <p className="text-ink">{outcome.configured ? t('done', { received: outcome.received, drafts: outcome.drafts, failed: outcome.failed }) : t('notConfigured')}</p> : null}
        {outcome && !outcome.ok ? (
          <p className={ERROR_LINE}>
            <CircleAlert className="mt-1 size-4 shrink-0" aria-hidden="true" />
            <span>{te(apErrorKey(outcome))}</span>
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** A file that waits for its PO: FINANCE chooses the PO and gets the draft */
function FilePoPicker({ row, file, pos, createFromInbox }: { row: InboxRowView; file: { fileId: string; fileName: string }; pos: readonly InboxPoOption[]; createFromInbox: FromInbox }) {
  const t = useTranslations('apList.inbox')
  const te = useTranslations('apList.errors')
  const router = useRouter()
  const submission = useSubmissionKey()
  const pickerId = useId()
  const options = useMemo(() => (row.senderSupplierId ? [...pos.filter((p) => p.supplierId === row.senderSupplierId), ...pos.filter((p) => p.supplierId !== row.senderSupplierId)] : pos), [pos, row.senderSupplierId])
  const [po, setPo] = useState<string | null>(() => pos.find((p) => p.number !== null && row.refs.includes(p.number))?.value ?? null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function create() {
    if (!po) return
    setBusy(true)
    setProblem(null)
    let outcome: ApDraftOutcome
    try {
      outcome = await createFromInbox({ inboundEmailId: row.id, fileId: file.fileId, poId: po }, submission.key)
      submission.next()
    } catch {
      outcome = AP_NO_ANSWER
    }
    if (outcome.ok) return router.push(`/finance/invoices/${outcome.invoiceId}`)
    setBusy(false)
    setProblem(te(apErrorKey(outcome)))
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={pickerId} className="text-base text-ink md:text-sm">
        {t('pickLabel', { name: file.fileName })}
      </Label>
      <Combobox
        id={pickerId}
        options={options.map((p) => ({ value: p.value, label: p.label }))}
        value={po}
        onValueChange={(value) => {
          setPo(value)
          setProblem(null)
        }}
        placeholder={t('pick')}
        searchPlaceholder={t('search')}
        emptyText={t('noPo')}
        className="min-h-11 text-base md:text-sm"
      />
      <Button type="button" variant="outline" disabled={!po || busy} className="min-h-11 self-start px-3 text-base whitespace-normal md:text-sm" onClick={() => void create()}>
        {busy ? t('creating') : t('create', { name: file.fileName })}
      </Button>
      {problem ? (
        <p role="alert" className={ERROR_LINE}>
          <CircleAlert className="mt-1 size-4 shrink-0" aria-hidden="true" />
          <span>{problem}</span>
        </p>
      ) : null}
    </div>
  )
}

/** Skips a message with a reason, after asking (it cannot be undone) */
function IgnoreEmail({ row, ignore }: { row: InboxRowView; ignore: Ignore }) {
  const t = useTranslations('apList.inbox.ignore')
  const te = useTranslations('apList.errors')
  const router = useRouter()
  const submission = useSubmissionKey()
  const reasonId = useId()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function confirm() {
    if (!reason.trim()) return setProblem(te('REASON_REQUIRED'))
    setBusy(true)
    setProblem(null)
    let outcome: ApDoneOutcome
    try {
      outcome = await ignore({ inboundEmailId: row.id, reason }, submission.key)
      submission.next()
    } catch {
      outcome = AP_NO_ANSWER
    }
    setBusy(false)
    if (!outcome.ok) return setProblem(te(apErrorKey(outcome)))
    setOpen(false)
    router.refresh()
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setProblem(null)
      }}
    >
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" aria-label={t('buttonLabel', { subject: row.subject })} className="min-h-11 self-start px-3 text-base md:text-sm">
          {t('button')}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('body', { subject: row.subject })}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={reasonId} className="text-base text-ink">
            {t('reasonLabel')}
          </Label>
          <Textarea
            id={reasonId}
            value={reason}
            maxLength={500}
            aria-describedby={`${reasonId}-hint`}
            aria-invalid={problem ? true : undefined}
            onChange={(event) => setReason(event.currentTarget.value)}
            className="text-base"
          />
          <p id={`${reasonId}-hint`} className="text-ink-muted">
            {t('reasonHint')}
          </p>
          {problem ? (
            <p role="alert" className={ERROR_LINE}>
              <CircleAlert className="mt-1 size-4 shrink-0" aria-hidden="true" />
              <span>{problem}</span>
            </p>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11 text-base">{t('cancel')}</AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={busy} className="min-h-11 text-base" onClick={() => void confirm()}>
            {busy ? t('busy') : t('confirm')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function InboxTable({
  rows,
  pos,
  canRecord,
  ignore,
  createFromInbox,
}: {
  rows: readonly InboxRowView[]
  pos: readonly InboxPoOption[]
  canRecord: boolean
  ignore: Ignore
  createFromInbox: FromInbox
}) {
  const t = useTranslations('apList.inbox')
  const c = (key: 'received' | 'from' | 'subject' | 'files' | 'status') => t(`columns.${key}`)
  return (
    <Table aria-label={t('table')} className="text-base md:text-sm max-lg:block max-lg:[&_tbody]:block">
      <TableHeader className="max-lg:sr-only">
        <TableRow>
          <TableHead>{c('received')}</TableHead>
          <TableHead>{c('from')}</TableHead>
          <TableHead>{c('subject')}</TableHead>
          <TableHead>{c('files')}</TableHead>
          <TableHead>{c('status')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id} className="hover:bg-transparent max-lg:flex max-lg:flex-col max-lg:gap-2 max-lg:py-3">
            <TableCell className="align-top max-lg:block max-lg:p-0">
              <span className={CELL_NAME}>{c('received')} </span>
              {row.received}
            </TableCell>
            <TableCell className="align-top break-all whitespace-normal max-lg:block max-lg:p-0">
              <span className={CELL_NAME}>{c('from')} </span>
              {row.from}
            </TableCell>
            <TableCell className="align-top break-words whitespace-normal max-lg:block max-lg:p-0">
              <span className={CELL_NAME}>{c('subject')} </span>
              {row.subject}
              {row.poRefs ? <span className="block text-ink-muted">{row.poRefs}</span> : null}
            </TableCell>
            <TableCell className="align-top whitespace-normal max-lg:block max-lg:p-0 lg:min-w-72">
              <span className={CELL_NAME}>{c('files')}</span>
              <div className="flex flex-col gap-2">
                {row.drafts.map((d) => (
                  <Link key={d.id} href={d.href} className="inline-flex min-h-11 items-center self-start font-medium break-words text-primary underline underline-offset-4 hover:no-underline lg:min-h-0">
                    {d.label}
                  </Link>
                ))}
                {row.waiting.map((f) =>
                  canRecord ? (
                    <FilePoPicker key={f.fileId} row={row} file={f} pos={pos} createFromInbox={createFromInbox} />
                  ) : (
                    <span key={f.fileId} className="text-ink">
                      {t('waiting', { name: f.fileName })}
                    </span>
                  ),
                )}
                {row.waiting.length > 0 && !canRecord ? <span className="text-ink-muted">{t('noRecord')}</span> : null}
                {row.skipped.map((s) => (
                  <span key={s} className="text-ink-muted">
                    {s}
                  </span>
                ))}
              </div>
            </TableCell>
            <TableCell className="align-top whitespace-normal max-lg:block max-lg:p-0">
              <span className={CELL_NAME}>{c('status')}</span>
              <div className="flex flex-col items-start gap-1.5">
                <InboxStatusBadge status={row.status} label={row.statusLabel} />
                {row.statusNotes.map((n) => (
                  <span key={n} className="break-words text-ink-muted">
                    {n}
                  </span>
                ))}
                {row.canIgnore ? <IgnoreEmail row={row} ignore={ignore} /> : null}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
