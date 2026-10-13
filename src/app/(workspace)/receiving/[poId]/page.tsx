import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getReceivingView } from '@/server/services/receiving/view'
import { PO_BADGES, StatusBadge } from '@/ui/document/badges'
import { formatDateTime } from '@/ui/format'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { CloseShort } from '@/ui/receiving/close-short'
import { PoLines } from '@/ui/receiving/po-lines'
import { ReceiptHistory } from '@/ui/receiving/receipt-history'
import { ReceiveForm } from '@/ui/receiving/receive-form'
import { nameIn } from '@/ui/receiving/types'
import { documentAiFor } from '../../../_lib/ai-read'
import { completeUploadAction, downloadUrlAction, requestUploadAction } from '../../../_lib/file-actions'
import { getSession } from '../../../_lib/session'
import { closeShortAction, postReceiptAction, previewReceiptAction } from '../actions'
import { closeShortPlanView, lineViews, poStatusKey, receiptViews, varianceView } from '../present'

export async function generateMetadata({ params }: { params: Promise<{ poId: string }> }) {
  const { poId } = await params
  const t = await getTranslations('receiving')
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  // The title names the PO only for those who may open it
  const view = ctx ? await getReceivingView(ctx, poId) : null
  return { title: view?.ok && view.data.po.number ? t('detail.metaTitle', { number: view.data.po.number }) : t('list.metaTitle') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
const NOT_SENT = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED']

// Receiving one PO (spec §9.1 /receiving/[poId], FR-P2P-006, FR-P2P-007, FR-P2P-010 AC2, demo scene 8), mobile first:
// which PO, whether this member may receive it and if not why in plain words (separation of duties, AC3), the lines with
// what is still to come, the two-step receiving form, the receipts so far with their photos, and — for PROCUREMENT — the
// request to close the PO short. The service decides who may see and do what (gr.post once the PO went to the supplier,
// po.view, po.close) and checks again on every action (BR-AUTH-05). The page's frame (S16-10): the PO, its status as the
// badge of §9.10 and who asked on the page's white; what the member may do in white cards on --surface.
export default async function ReceivingPoPage({ params }: { params: Promise<{ poId: string }> }) {
  const { poId } = await params
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [t, td, locale] = await Promise.all([getTranslations('receiving'), getTranslations('document.badge'), getLocale()])

  const result = await getReceivingView(ctx, poId)
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND') notFound()
    return (
      <Page>
        <PageHeader title={t('detail.notYours')} />
        <div className="flex max-w-2xl flex-col gap-3">
          <Notice tone="warning">{t('detail.notYoursHint')}</Notice>
          <Link href="/receiving" className={linkClass}>
            {t('detail.back')}
          </Link>
        </div>
      </Page>
    )
  }

  const view = result.data
  const po = view.po
  const number = po.number ?? t('list.noNumber')
  const status = poStatusKey(po.status)
  const lines = lineViews(po.lines)
  const receives = view.decision.kind === 'RECEIVE'
  const outstanding = lines.some((l) => l.outstanding !== '0')
  // "อ่านใบส่งของ" for a receiver who may post this PO now, when the Document Agent is available (FR-AI-303 AC4 AC8)
  const ai = receives && view.receivable ? await documentAiFor(ctx) : undefined

  // Whether and why this member may receive, and what waits on the PO: plain words above the work
  const notices = [
    view.decision.kind === 'SOD' ? <Notice key="sod" tone="warning">{view.decision.rule === 'BR-SOD-07' ? t('detail.sodRequester') : t('detail.sodApprover')}</Notice> : null,
    view.decision.kind === 'NONE' ? <Notice key="view" tone="info">{t('detail.viewOnly')}</Notice> : null,
    receives && !view.receivable ? (
      <Notice key="state" tone="info">
        {NOT_SENT.includes(status) ? t('detail.notSent') : t(`detail.closedState.${status === 'RECEIVED' || status === 'CLOSED' || status === 'CANCELLED' ? status : 'RECEIVED'}`)}
      </Notice>
    ) : null,
    view.closeShortPending ? <Notice key="pending" tone="warning">{receives ? t('detail.closeShortWaiting') : t('detail.closeShortWaitingOther')}</Notice> : null,
    view.closeShortWaitsForDamaged ? <Notice key="damaged" tone="info">{t('detail.closeShortWaitsForDamaged')}</Notice> : null,
  ].filter((n) => n !== null)

  return (
    <Page>
      <Link href="/receiving" className={linkClass}>
        {t('detail.back')}
      </Link>

      <PageHeader title={t('detail.title', { number })}>
        <div>
          <StatusBadge look={PO_BADGES[status]} label={td(`po.${status}` as 'po.DRAFT')} className="text-base md:text-sm" />
        </div>
        <div className="flex flex-col text-ink-muted">
          <span className="break-words">{t('detail.supplier', { name: nameIn(locale, po.supplier) })}</span>
          <span className="break-words">{po.site ? t('detail.site', { name: nameIn(locale, po.site) }) : t('list.noSite')}</span>
          {po.sentAt ? <span>{t('list.sentOn', { time: formatDateTime(locale, po.sentAt) })}</span> : null}
          {po.requests.map((r) => (
            <span key={r.id} className="break-words">
              {r.department
                ? t('list.requestedBy', { number: r.number ?? '-', name: nameIn(locale, r.requester?.name), department: nameIn(locale, r.department.name) })
                : t('list.requestedByNoDept', { number: r.number ?? '-', name: nameIn(locale, r.requester?.name) })}
            </span>
          ))}
        </div>
      </PageHeader>

      <PageBody>
        {notices.length ? <div className="flex max-w-4xl flex-col gap-3">{notices}</div> : null}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-6">
          <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
            {/* Kept in the same place whatever the PO's state, so its confirmation stays after the page refreshes */}
            {receives ? (
              <Panel>
                <ReceiveForm
                  poId={po.id}
                  lines={lines}
                  open={view.receivable}
                  listHref="/receiving"
                  actions={{ preview: previewReceiptAction, post: postReceiptAction, requestUpload: requestUploadAction, completeUpload: completeUploadAction, ...(ai ? { ai } : {}) }}
                />
              </Panel>
            ) : null}
            {!view.receivable ? (
              <Panel title={t('detail.linesTitle')} id="po-lines">
                <PoLines lines={lines} />
              </Panel>
            ) : null}
            {view.receivable && !view.canCloseShort && outstanding && !view.closeShortPending ? <p className="text-ink-muted">{t('detail.askProcurement')}</p> : null}
          </div>

          <aside className="flex min-w-0 flex-col gap-4 lg:gap-6">
            <Panel>
              <ReceiptHistory receipts={receiptViews(po.receipts, locale)} closeShort={po.closeShort.map(varianceView)} locale={locale} open={downloadUrlAction} />
            </Panel>
            {/* For PROCUREMENT always in the same place, so its confirmation stays after the page refreshes */}
            {view.closesPo ? (
              <Panel>
                <CloseShort poId={po.id} plan={view.canCloseShort && view.closeShortPlan ? closeShortPlanView(view.closeShortPlan) : null} close={closeShortAction} />
              </Panel>
            ) : null}
          </aside>
        </div>
      </PageBody>
    </Page>
  )
}
