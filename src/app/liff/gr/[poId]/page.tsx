import { getLocale, getTranslations } from 'next-intl/server'
import { cache } from 'react'
import type { Ctx } from '@/server/context'
import { getReceivingView } from '@/server/services/receiving/view'
import { formatDateTime } from '@/ui/format'
import { LiffContent, LiffFrame } from '@/ui/liff/frame'
import { LiffGate } from '@/ui/liff/liff-gate'
import { LiffNotice } from '@/ui/liff/notice'
import { LiffPoLines } from '@/ui/liff/receiving/po-lines'
import { LiffReceipts } from '@/ui/liff/receiving/receipts'
import { LiffReceiveFlow } from '@/ui/liff/receiving/receive-flow'
import { LiffPoSummary, liffPoStatus } from '@/ui/liff/receiving/summary'
import { LiffRefusal } from '@/ui/liff/refusal'
import { lineViews, receiptViews, varianceView } from '../../../(workspace)/receiving/present'
import { liffPage } from '../../_lib/session'
import { completeLiffUploadAction, postLiffReceiptAction, previewLiffReceiptAction, receiptPhotoUrlAction, requestLiffUploadAction } from './actions'

/** One read of the receiving view per request, shared by the title and the page */
const viewOf = cache((ctx: Ctx, poId: string) => getReceivingView(ctx, poId))

export async function generateMetadata({ params }: { params: Promise<{ poId: string }> }) {
  const { poId } = await params
  const [t, page] = await Promise.all([getTranslations('receiving'), liffPage()])
  // The title names the PO only for a member who may open it
  const view = page.kind === 'member' ? await viewOf(page.ctx, poId) : null
  return { title: view?.ok && view.data.po.number ? t('detail.metaTitle', { number: view.data.po.number }) : t('list.metaTitle') }
}

/** PO statuses before it went to the supplier: nothing can be received yet */
const NOT_SENT = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED']

// /liff/gr/[poId] (§9.4 "ตรวจรับพร้อมกล้อง", S5-06, FR-LINE-003 AC3, FR-P2P-006, demo scene 8): receiving a PO on site
// in the LINE app — the receiving link of a PO (src/channels/line/links.ts: /receiving/<id> → /gr/<id>) opens here. The
// same service as the workspace's /receiving/[poId] decides who may see what (gr.post once the PO went to the supplier,
// po.view) and checks again on every action; the page shows its data only to a member (the gate signs in with LINE
// first, ADR-046), on channel LIFF. A member who may receive gets the receiving steps (src/ui/liff/receiving/
// receive-flow.tsx: quantities, the camera, the check, the confirmation in the bar at the bottom); separation of duties
// is said in plain words (FR-P2P-006 AC3); everyone who may open the PO sees its lines and the receipts so far with their
// photos, and the same notices as the workspace's page about closing it short. Closing a PO short stays a workspace task
// of PROCUREMENT (FR-P2P-010 AC2).
export default async function LiffReceivingPage({ params }: { params: Promise<{ poId: string }> }) {
  const { poId } = await params
  const [t, tLiff, locale, page] = await Promise.all([getTranslations('receiving'), getTranslations('liffReceiving'), getLocale(), liffPage()])
  if (page.kind !== 'member') {
    return (
      <LiffFrame title={tLiff('title')}>
        <LiffContent>
          <LiffGate mode="member" state={page.kind} />
        </LiffContent>
      </LiffFrame>
    )
  }

  const result = await viewOf(page.ctx, poId)
  if (!result.ok) {
    const missing = result.error.code === 'NOT_FOUND'
    return (
      <LiffFrame title={tLiff('title')}>
        <LiffContent>
          <LiffRefusal title={missing ? tLiff('notFound.title') : t('detail.notYours')}>{missing ? tLiff('notFound.body') : t('detail.notYoursHint')}</LiffRefusal>
        </LiffContent>
      </LiffFrame>
    )
  }

  const view = result.data
  const po = view.po
  const status = liffPoStatus(po.status)
  const lines = lineViews(po.lines)
  const title = t('detail.title', { number: po.number ?? t('list.noNumber') })
  const summary = (
    <LiffPoSummary
      locale={locale}
      po={{
        status,
        supplier: po.supplier,
        site: po.site,
        sentAt: po.sentAt ? formatDateTime(locale, po.sentAt) : null,
        requests: po.requests.map((r) => ({ id: r.id, number: r.number, requester: r.requester?.name ?? null, department: r.department?.name ?? null })),
      }}
    />
  )
  const receipts = <LiffReceipts receipts={receiptViews(po.receipts, locale)} closeShort={po.closeShort.map(varianceView)} locale={locale} open={receiptPhotoUrlAction.bind(null, po.id)} />
  const linesSection = <LiffPoLines lines={lines} headingId="liff-gr-lines" />

  // A close-short waiting for its approver, or one that cannot be asked for yet: the same notices as the workspace's page
  const waitsForDamaged = view.closeShortWaitsForDamaged ? <LiffNotice tone="info">{t('detail.closeShortWaitsForDamaged')}</LiffNotice> : null

  if (view.decision.kind !== 'RECEIVE') {
    // Separation of duties (GC-SOD-02, GC-SOD-05) or a member who only views the PO: why, then the PO as it stands
    const why = view.decision.kind === 'SOD' ? (view.decision.rule === 'BR-SOD-07' ? t('detail.sodRequester') : t('detail.sodApprover')) : t('detail.viewOnly')
    return (
      <LiffFrame title={title}>
        <LiffContent>
          {summary}
          <LiffNotice tone={view.decision.kind === 'SOD' ? 'warning' : 'info'}>{why}</LiffNotice>
          {view.closeShortPending ? <LiffNotice tone="warning">{t('detail.closeShortWaitingOther')}</LiffNotice> : null}
          {waitsForDamaged}
          {linesSection}
          {receipts}
        </LiffContent>
      </LiffFrame>
    )
  }

  const outstanding = lines.some((l) => l.outstanding !== '0')
  const closedState = status === 'RECEIVED' || status === 'CLOSED' || status === 'CANCELLED' ? status : 'RECEIVED'
  return (
    <LiffFrame title={title}>
      <LiffReceiveFlow
        poId={po.id}
        lines={lines}
        open={view.receivable}
        summary={summary}
        notices={
          view.closeShortPending || waitsForDamaged ? (
            <>
              {view.closeShortPending ? <LiffNotice tone="warning">{t('detail.closeShortWaiting')}</LiffNotice> : null}
              {waitsForDamaged}
            </>
          ) : null
        }
        closed={
          <>
            <LiffNotice tone="info">{NOT_SENT.includes(status) ? t('detail.notSent') : t(`detail.closedState.${closedState}`)}</LiffNotice>
            {linesSection}
          </>
        }
        history={
          <>
            {view.receivable && !view.canCloseShort && outstanding && !view.closeShortPending ? <p className="text-ink-muted">{t('detail.askProcurement')}</p> : null}
            {receipts}
          </>
        }
        actions={{ preview: previewLiffReceiptAction, post: postLiffReceiptAction, requestUpload: requestLiffUploadAction, completeUpload: completeLiffUploadAction }}
      />
    </LiffFrame>
  )
}
