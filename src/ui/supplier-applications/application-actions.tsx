'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { UploadButton, type UploadActions } from '../request-form/upload-button'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '../shadcn/alert-dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../shadcn/dialog'
import { Textarea } from '../shadcn/textarea'

// What PROCUREMENT does with an application on /suppliers/applications/[id] (S7-09 · ADR-181 · BR-SUP ข้อ 10 ข้อ 11): send
// a submitted one for approval — the registries are asked on the server; when they cannot confirm it, a proof is
// attached and it is sent again — return it to the supplier with a reason (Dialog), cancel it (AlertDialog: it cannot
// be undone), invite again, or fill it in for the supplier. Each button is there only when the state and the reader's
// rights allow it; the server checks both again.

export type ActionResult = { readonly ok: true; readonly applicationId: string } | { readonly ok: false; readonly code: string; readonly reason: string | null; readonly details: Readonly<Record<string, unknown>> }

export interface ApplicationActionsProps {
  readonly applicationId: string
  readonly version: number
  readonly status: string
  readonly can: { readonly route: boolean; readonly invite: boolean; readonly fillOnBehalf: boolean }
  readonly kind: 'NEW' | 'EXISTING'
  readonly actions: {
    readonly route: (id: string, version: number, proofFileId: string | null, key: string) => Promise<ActionResult>
    readonly returnIt: (id: string, version: number, reason: string, key: string) => Promise<ActionResult>
    readonly cancel: (id: string, version: number, reason: string, key: string) => Promise<ActionResult>
    readonly reinvite: (id: string, version: number, key: string) => Promise<ActionResult>
  }
  readonly uploads: UploadActions
}

const KNOWN = ['FORBIDDEN', 'CONFLICT_VERSION', 'INVALID_STATE_TRANSITION', 'SUPPLIER_DOCUMENT_UNVERIFIED', 'SOD_VIOLATION', 'APPROVER_NOT_FOUND', 'VALIDATION_FAILED'] as const
const MIN_REASON = 3

export function ApplicationActions({ applicationId, version, status, can, kind, actions, uploads }: ApplicationActionsProps) {
  const t = useTranslations('supplierApplications.actions')
  const router = useRouter()
  const { key, next } = useSubmissionKey()
  const [error, setError] = useState<{ code: string; reason: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [proofNeeded, setProofNeeded] = useState(false)
  const [proof, setProof] = useState<{ fileId: string; fileName: string } | null>(null)
  const [reason, setReason] = useState('')
  const [open, setOpen] = useState<'return' | 'cancel' | null>(null)

  async function run(fn: () => Promise<ActionResult>) {
    setBusy(true)
    setError(null)
    const r = await fn()
    setBusy(false)
    next()
    if (!r.ok) {
      if (r.reason === 'REGISTRY_PROOF_REQUIRED') setProofNeeded(true)
      setError({ code: r.code, reason: r.reason })
      return
    }
    setOpen(null)
    setReason('')
    router.refresh()
  }

  const errorText = !error
    ? null
    : error.reason === 'REGISTRY_CEASED' || error.reason === 'REGISTRY_PROOF_REQUIRED'
      ? t(`errors.${error.reason}`)
      : (KNOWN as readonly string[]).includes(error.code)
        ? t(`errors.${error.code as (typeof KNOWN)[number]}`)
        : t('errors.FAILED')
  const editable = ['INVITED', 'DRAFT', 'RETURNED'].includes(status) && kind === 'NEW'
  const routable = status === 'SUBMITTED' && can.route
  const cancellable = ['INVITED', 'DRAFT', 'RETURNED', 'SUBMITTED'].includes(status) && can.invite
  const reinvitable = ['INVITED', 'EXPIRED'].includes(status) && can.invite
  if (!editable && !routable && !cancellable && !reinvitable) return null
  const reasonOk = reason.trim().length >= MIN_REASON

  return (
    <section aria-label={t('label')} className="flex flex-col gap-3">
      {errorText && !proofNeeded ? <Notice tone="danger">{errorText}</Notice> : null}
      {proofNeeded ? (
        <div className="flex flex-col gap-2">
          <Notice tone="warning">{t('proofNeeded')}</Notice>
          <UploadButton label={t('proofUpload')} actions={uploads} onUploaded={(f) => setProof(f)} />
          {proof ? <p>{t('proofAttached', { name: proof.fileName })}</p> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {routable ? (
          <Button variant="primary" disabled={busy || (proofNeeded && !proof)} onClick={() => run(() => actions.route(applicationId, version, proof?.fileId ?? null, key))}>
            {t('route')}
          </Button>
        ) : null}
        {editable && can.fillOnBehalf ? (
          <Link href={`/suppliers/applications/${applicationId}/edit`} className="inline-flex min-h-11 items-center rounded-md border border-input bg-bg px-4 font-medium text-ink hover:bg-surface lg:min-h-10">
            {t('fill')}
          </Link>
        ) : null}
        {reinvitable ? (
          <Button variant="secondary" disabled={busy} onClick={() => run(() => actions.reinvite(applicationId, version, key))}>
            {t('reinvite')}
          </Button>
        ) : null}
        {routable ? (
          <Dialog open={open === 'return'} onOpenChange={(o) => setOpen(o ? 'return' : null)}>
            <DialogTrigger asChild>
              <Button variant="secondary">{t('return')}</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('returnTitle')}</DialogTitle>
                <DialogDescription>{t('returnHint')}</DialogDescription>
              </DialogHeader>
              <label htmlFor="return-reason" className="font-medium">
                {t('reason')}
              </label>
              <Textarea id="return-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
              {errorText ? <Notice tone="danger">{errorText}</Notice> : null}
              <DialogFooter>
                <Button variant="secondary" onClick={() => setOpen(null)}>
                  {t('close')}
                </Button>
                <Button variant="primary" disabled={busy || !reasonOk} onClick={() => run(() => actions.returnIt(applicationId, version, reason.trim(), key))}>
                  {t('returnConfirm')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}
        {cancellable ? (
          <AlertDialog open={open === 'cancel'} onOpenChange={(o) => setOpen(o ? 'cancel' : null)}>
            <AlertDialogTrigger asChild>
              <Button variant="danger">{t('cancel')}</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('cancelTitle')}</AlertDialogTitle>
                <AlertDialogDescription>{t('cancelHint')}</AlertDialogDescription>
              </AlertDialogHeader>
              <label htmlFor="cancel-reason" className="font-medium">
                {t('reason')}
              </label>
              <Textarea id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
              {errorText ? <Notice tone="danger">{errorText}</Notice> : null}
              <AlertDialogFooter>
                <AlertDialogCancel>{t('keep')}</AlertDialogCancel>
                <AlertDialogAction
                  disabled={busy || !reasonOk}
                  onClick={(e) => {
                    e.preventDefault()
                    void run(() => actions.cancel(applicationId, version, reason.trim(), key))
                  }}
                >
                  {t('cancelConfirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>
    </section>
  )
}
