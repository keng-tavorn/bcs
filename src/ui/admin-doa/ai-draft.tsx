'use client'

import { Sparkles } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { AiReadingStatus } from '../ai/ai-review'
import type { AiDoaDraftView, AiResultOutcome, AiStartOutcome } from '../ai/types'
import { useAiRead } from '../ai/use-ai-read'
import { FileUpload, type FileUploadProps } from '../files/file-upload'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { Badge } from '../shadcn/badge'
import { Checkbox } from '../shadcn/checkbox'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../shadcn/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table'

// /admin/doa/ai-draft (FR-AI-308 AC1–AC3, BR-AI-22, §12.5): the member holding admin.doa.draft uploads the regulation;
// the AI drafts its rules, each shown with its source sentence and its page (the PDF opens at that page beside it, drawn
// by the browser), what code found wrong with it and the lint of the draft. Every rule is confirmed one by one; only
// then "สร้างฉบับร่าง" creates the draft with the member's own doa.import_draft, which goes on to the DOA editor —
// nothing is published here.

export interface DoaDrafterActions {
  readonly start: (input: { fileId: string }, idempotencyKey: string) => Promise<AiStartOutcome>
  readonly result: (agentActionId: string) => Promise<AiResultOutcome>
  readonly fileUrl: (fileId: string) => Promise<string | null>
  readonly create: (input: { yaml: string; agentActionId: string; confirmedPaths: string[] }, idempotencyKey: string) => Promise<{ ok: true; versionId: string } | { ok: false; code: string }>
}

export function DoaAiDraft({ actions, uploads }: { actions: DoaDrafterActions; uploads: Pick<FileUploadProps, 'requestUpload' | 'completeUpload'> }) {
  const t = useTranslations('aiAssist.doa')
  const router = useRouter()
  const { state, read } = useAiRead(actions)
  const [fileId, setFileId] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ id: string; doa: AiDoaDraftView } | null>(null)
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set())
  const [page, setPage] = useState<{ url: string | null; page: number } | null>(null)
  const [creating, setCreating] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  async function start(id: string) {
    setFileId(id)
    setDraft(null)
    setConfirmed(new Set())
    const result = await read({ fileId: id }, uuidv4())
    if (result?.doa) setDraft({ id: result.id, doa: result.doa })
  }

  async function openPage(n: number) {
    if (!fileId) return
    setPage({ url: await actions.fileUrl(fileId), page: n })
  }

  const inDraft = draft ? draft.doa.rules.filter((r) => r.problems.length === 0) : []
  const allConfirmed = inDraft.length > 0 && inDraft.every((r) => confirmed.has(r.code))

  async function create() {
    if (!draft || !allConfirmed) return
    setCreating(true)
    setFailed(null)
    const r = await actions.create({ yaml: draft.doa.yaml, agentActionId: draft.id, confirmedPaths: inDraft.map((x) => `rules.${x.code}`) }, uuidv4())
    setCreating(false)
    if (r.ok) router.push(`/admin/doa/${r.versionId}`)
    else setFailed(t('failed', { code: r.code }))
  }

  const grouped = (baht: string) => baht.replace(/\B(?=(\d{3})+(?!\d))(?=[^.]*(?:\.|$))/g, ',')
  const range = (gt: string | null, lte: string | null) => (gt === null && lte === null ? t('any') : [gt !== null ? t('from', { gt: grouped(gt) }) : null, lte !== null ? t('to', { lte: grouped(lte) }) : t('noEnd')].filter(Boolean).join(' · '))
  const lintText = (e: AiDoaDraftView['lint']['errors'][number]) =>
    e.code === 'DOA_LINT_GAP' ? t('lintGap', { documentType: e.documentType ?? '', gt: e.gt ?? '', lte: e.lte ?? t('noEnd') }) : t('lintOther', { code: e.code, target: e.rule ?? e.documentType ?? '' })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="font-medium">{t('upload')}</p>
        <FileUpload rule={t('upload')} requestUpload={uploads.requestUpload} completeUpload={uploads.completeUpload} onUploaded={(f) => void start(f.fileId)} disabled={state.kind === 'reading' || creating} />
        {state.kind === 'reading' ? (
          <p role="status" className="text-ink-muted">
            {t('reading')}
          </p>
        ) : (
          <AiReadingStatus state={state} />
        )}
      </div>

      {draft ? (
        <section aria-labelledby="doa-ai-rules" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="doa-ai-rules" className="text-lg font-semibold">
              {t('rulesTitle')} · {t('version', { code: draft.doa.versionCode, versionNo: draft.doa.versionNo })}
            </h2>
            <Badge variant="info" className="text-base md:text-sm">
              <Sparkles aria-hidden="true" />
              {t('title')}
            </Badge>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('rule')}</TableHead>
                  <TableHead>{t('range')}</TableHead>
                  <TableHead>{t('approver')}</TableHead>
                  <TableHead>{t('source')}</TableHead>
                  <TableHead>{t('page')}</TableHead>
                  <TableHead className="sr-only">{t('confirm', { code: '' })}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {draft.doa.rules.map((r) => (
                  <TableRow key={r.code}>
                    <TableCell className="font-medium">
                      {r.code}
                      <span className="block text-ink-muted">{r.documentType}</span>
                    </TableCell>
                    <TableCell className="tabular">{range(r.gt, r.lte)}</TableCell>
                    <TableCell>{r.approverPosition ?? r.approverKind}</TableCell>
                    <TableCell className="max-w-80 whitespace-normal break-words">{r.sourceText}</TableCell>
                    <TableCell>
                      <Button variant="link" className="min-h-11" onClick={() => void openPage(r.page)}>
                        {t('openPage', { page: r.page })}
                      </Button>
                    </TableCell>
                    <TableCell>
                      {r.problems.length ? (
                        <span className="text-danger">
                          {t('notInDraft')}: {r.problems.map((p) => (t.has(`problems.${p}` as 'problems.GT_NOT_BAHT') ? t(`problems.${p}` as 'problems.GT_NOT_BAHT') : p)).join(' · ')}
                        </span>
                      ) : (
                        <label className="flex min-h-11 items-center gap-2">
                          <Checkbox
                            checked={confirmed.has(r.code)}
                            onCheckedChange={(v) =>
                              setConfirmed((c) => {
                                const next = new Set(c)
                                if (v === true) next.add(r.code)
                                else next.delete(r.code)
                                return next
                              })
                            }
                            aria-label={t('confirm', { code: r.code })}
                          />
                          <span className="sr-only">{t('confirm', { code: r.code })}</span>
                        </label>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <section aria-labelledby="doa-ai-lint" className="flex flex-col gap-2">
            <h3 id="doa-ai-lint" className="font-semibold">
              {t('lintTitle')}
            </h3>
            {draft.doa.lint.errors.length === 0 && draft.doa.lint.warnings.length === 0 ? <p className="text-ink-muted">{t('lintNone')}</p> : null}
            {draft.doa.lint.errors.map((e, i) => (
              <Notice key={`e${i}`} tone="danger" role="status">
                {lintText(e)}
              </Notice>
            ))}
            {draft.doa.lint.warnings.map((w, i) => (
              <Notice key={`w${i}`} tone="warning" role="status">
                {t('lintOther', { code: w.code, target: w.rule ?? '' })}
              </Notice>
            ))}
          </section>
          <p className="text-ink-muted">{t('createHint')}</p>
          {failed ? <Notice tone="danger">{failed}</Notice> : null}
          <Button className="self-start" disabled={!allConfirmed || creating} onClick={() => void create()}>
            {t('create')}
          </Button>
        </section>
      ) : null}

      <Sheet open={page !== null} onOpenChange={(o) => (o ? null : setPage(null))}>
        <SheetContent className="w-full sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>
              {t('fileTitle')} · {t('openPage', { page: page?.page ?? 1 })}
            </SheetTitle>
            <SheetDescription>{t('fileHint')}</SheetDescription>
          </SheetHeader>
          {page?.url ? <iframe title={t('fileTitle')} src={`${page.url}#page=${page.page}`} className="h-[75vh] w-full rounded-md border border-line" /> : null}
        </SheetContent>
      </Sheet>
    </div>
  )
}
