import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { memberPrincipal } from '@/server/authz'
import { getPoAccess, getPurchaseOrderView, type PoViewDto } from '@/server/queries/purchase-orders'
import { previewPoSubmit, type PoSubmitPreviewDto } from '@/server/services/purchase-orders'
import { Notice } from '@/ui/form/notice'
import { DraftEditor } from '@/ui/purchase-order/draft-editor'
import { PoActions, type SubmitPreviewView } from '@/ui/purchase-order/po-actions'
import { PoStatus } from '@/ui/purchase-order/status'
import { StateLine } from '@/ui/request-view/status'
import { Timeline } from '@/ui/timeline/timeline'
import { downloadUrlAction } from '../../../../_lib/file-actions'
import { getSession } from '../../../../_lib/session'
import { canOpenDoaVersion } from '../../../_tracking/access'
import { doaRefText, localeOf, memberName, money, roleText, routeSentence, when, type Locale } from '../../../_tracking/present'
import { canListPos, poReader, canViewPo, poRights } from '../_parts/access'
import { PoBody } from '../_parts/po-body'
import { docTimelineItems, waitingOf, type PoT } from '../_parts/present'
import { cancelPoAction, closePoAction, editDraftAction, sendPoAction, submitPoAction } from '../actions'

export async function generateMetadata() {
  const t = await getTranslations('purchaseOrder')
  return { title: t('detail.metaTitle') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

type ViewT = Awaited<ReturnType<typeof getTranslations<'requestView'>>>
type TimelineT = Awaited<ReturnType<typeof getTranslations<'timeline'>>>

/** What the DOA engine expects before "ส่งขออนุมัติ" (§9.9 principle 3), in words */
function previewView(t: PoT, tv: ViewT, tl: TimelineT, locale: Locale, preview: PoSubmitPreviewDto): SubmitPreviewView {
  const route = preview.route
  const blocked = !preview.supplierActive
    ? t('actions.submit.supplierInactive')
    : route.kind === 'BLOCKED'
      ? route.code === 'DOA_NOT_CONFIGURED' || route.code === 'APPROVER_NOT_FOUND' || route.code === 'NO_HIGHER_AUTHORITY' || route.code === 'TAX_RATE_NOT_CONFIGURED' || route.code === 'NO_LINES'
        ? t(`actions.submit.blocked.${route.code}`)
        : t('actions.submit.blocked.other', { code: route.code })
      : null
  // Thai readers get the engine's own record; English ones the same sentence built from its parts (as on the route itself)
  const why =
    route.kind !== 'ROUTE'
      ? ''
      : locale === 'th'
        ? route.explanationTh
        : routeSentence(
            tv,
            tl,
            locale,
            {
              id: '',
              routeNo: 1,
              status: 'ACTIVE',
              doa: route.doa,
              escalatedFromRuleCode: route.escalatedFromRuleCode,
              amountBasis: route.amountBasis,
              basisSatang: route.basisSatang,
              explanationTh: route.explanationTh,
              band: route.band,
              createdAt: new Date(0),
              steps: route.steps.map((s) => ({ stepNo: s.stepNo, status: 'WAITING', approver: s.approver, onBehalfOf: s.onBehalfOf, role: s.role, expected: null, taskStatus: null, decision: null, decidedAt: null })),
            },
            'PURCHASE_ORDER',
          )
  return {
    route:
      route.kind === 'ROUTE'
        ? {
            doaRef: doaRefText(tl, route.doa),
            why,
            steps: route.steps.map((s) => {
              const who = s.onBehalfOf ? `${memberName(locale, s.approver)} (${tv('actingFor', { name: memberName(locale, s.onBehalfOf) })})` : memberName(locale, s.approver)
              const role = roleText(tv, locale, s.role)
              return t('actions.submit.step', { no: s.stepNo, name: role ? `${who} · ${role}` : who })
            }),
          }
        : null,
    blocked,
    budget: preview.extraReserveSatang > 0n ? t('actions.submit.extraReserve', { amount: money(preview.extraReserveSatang) }) : t('actions.submit.noExtra'),
  }
}

/** The PO's state in words above everything else: cancelled, closed, rejected, returned, or a bounced e-mail */
function StateNotices({ po, t, locale }: { po: PoViewDto; t: PoT; locale: Locale }) {
  const returned = po.status === 'DRAFT' && po.track.some((e) => e.what === 'RETURNED')
  return (
    <>
      {po.status === 'CANCELLED' ? (
        <Notice tone="info">
          <p>{t('detail.cancelledState', { time: po.cancelledAt ? when(locale, po.cancelledAt) : '-', disposition: po.cancelDisposition ? t(`detail.disposition.${po.cancelDisposition}`) : '-' })}</p>
          {po.cancelReason ? <p className="break-words whitespace-pre-line">{t('detail.cancelledReason', { reason: po.cancelReason })}</p> : null}
        </Notice>
      ) : null}
      {po.status === 'CLOSED' && po.closedAt ? <Notice tone="success">{t('detail.closedState', { time: when(locale, po.closedAt) })}</Notice> : null}
      {po.status === 'REJECTED' ? <Notice tone="warning">{t('detail.rejectedState')}</Notice> : null}
      {returned ? <Notice tone="warning">{t('detail.returnedNote')}</Notice> : null}
      {po.bounce && po.status === 'APPROVED' ? <Notice tone="warning">{t('actions.send.bounceState', { time: when(locale, po.bounce.at), code: po.bounce.code ?? '-' })}</Notice> : null}
    </>
  )
}

// One purchase order (spec §9.1 /procurement/pos/[id], FR-P2P-003 to FR-P2P-005, FR-P2P-010): the supplier, site and
// lines with their source requests, the totals from the server, the prices paid before, the DOA route and its approval,
// what procurement can do now — edit the draft, send it for approval, send it to the supplier (again with a reason),
// cancel or close it — the PDF, and the timeline as stamps. Whoever may see the PO opens it (po.view, checked before
// anything is read); only procurement gets the actions, and the services check again.
export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [t, tv, tl, locale] = await Promise.all([getTranslations('purchaseOrder'), getTranslations('requestView'), getTranslations('timeline'), getLocale().then(localeOf)])

  const access = await getPoAccess(ctx, id)
  if (!access) notFound()
  const principal = memberPrincipal(state.member.id, state.roles)
  if (!canViewPo(principal, access)) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('detail.notYours')}</h1>
        <Notice tone="warning">{t('detail.notYoursHint')}</Notice>
        <Link href="/" className={linkClass}>
          {t('detail.homeLink')}
        </Link>
      </div>
    )
  }
  const po = await getPurchaseOrderView(ctx, id)
  if (!po) notFound()
  const rights = poRights(principal)
  const procurement = rights.edit || rights.submit || rights.send || rights.cancel || rights.close
  const preview = po.next.submit && rights.submit ? await previewPoSubmit(ctx, po.id) : null
  const doaLinks = canOpenDoaVersion(principal)
  const reader = poReader(principal, access, po)
  const label = po.number ?? t('detail.draftLabel')
  const waiting = waitingOf(t, tv, locale, po.waiting)
  const items = docTimelineItems(t, tv, tl, locale, po.track, { doaLinks })

  return (
    <div className="flex flex-col gap-6">
      {canListPos(principal) ? (
        <Link href="/procurement/pos" className={linkClass}>
          {t('detail.back')}
        </Link>
      ) : null}

      <header className="flex max-w-4xl flex-col gap-3">
        <div className="flex flex-col gap-1">
          <p className="font-medium text-ink-muted">{po.number ? t('detail.numberLabel', { number: po.number }) : t('detail.draftLabel')}</p>
          <h1 className="text-2xl font-semibold break-words">{po.supplier.nameTh}</h1>
          <p className="text-ink-muted">
            {t('detail.headingMeta', { site: po.deliverySite?.nameTh ?? t('detail.noSite'), kind: t(`kind.${po.kind}`) })}
            {po.urgency === 'URGENT' ? ` · ${t('detail.urgent')}` : ''}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <PoStatus status={po.status} label={t(`status.${po.status}`)} />
          <StateLine kind={po.waiting.kind === 'APPROVER' ? 'person' : po.waiting.kind === 'NONE' ? 'closed' : 'team'}>{waiting.now}</StateLine>
          {waiting.states.map((s) => (
            <StateLine key={s.text} kind={s.kind}>
              {s.text}
            </StateLine>
          ))}
          {po.sentAt ? (
            <StateLine kind="done">
              {reader.supplierContact && po.sentToEmail ? t('actions.send.sentState', { email: po.sentToEmail, time: when(locale, po.sentAt) }) : t('actions.send.sentStateNoEmail', { time: when(locale, po.sentAt) })}
            </StateLine>
          ) : null}
        </div>
        <a href={`/procurement/pos/${po.id}/pdf`} className={linkClass}>
          {po.number ? t('detail.pdf', { label: po.number }) : t('detail.pdfDraft')}
        </a>
        <StateNotices po={po} t={t} locale={locale} />
      </header>

      <div className="flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:grid-rows-[auto_1fr] lg:items-start lg:gap-x-10">
        <div className="flex min-w-0 flex-col gap-6 lg:col-start-2 lg:row-start-1">
          {procurement ? (
            <PoActions
              poId={po.id}
              label={label}
              submit={preview?.ok ? previewView(t, tv, tl, locale, preview.data) : null}
              send={po.next.send && rights.send ? { email: po.supplier.email } : null}
              resend={po.next.resend && rights.send ? { email: po.supplier.email } : null}
              cancel={po.next.cancel && rights.cancel}
              close={po.next.close && rights.close}
              // Closing waits for goods still to come: said once some came, not while nothing has arrived yet
              closeWaits={po.next.closeNeedsShortfall && rights.close && po.status === 'PARTIALLY_RECEIVED' ? t('actions.close.needsShortfall') : null}
              {...(po.status === 'PENDING_APPROVAL' ? { nothing: t('actions.nothingWhileApproval') } : {})}
              actions={{ submit: submitPoAction, send: sendPoAction, cancel: cancelPoAction, close: closePoAction }}
            />
          ) : (
            <p className="text-ink-muted">{t('detail.viewOnly')}</p>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-6 lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <PoBody po={po} locale={locale} doaLinks={doaLinks} reader={reader} openFile={downloadUrlAction} />
          {po.next.edit && rights.edit ? (
            <DraftEditor
              poId={po.id}
              version={po.version}
              // The price as the lines above show it, with thousands separators (§9.9 principle 6); the editor takes them out
              lines={po.lines.map((l) => ({ id: l.id, no: l.lineNo, description: l.description, uom: l.uom, quantity: l.quantity, unitPrice: money(l.unitPriceSatang), maxQuantity: l.maxQuantity }))}
              paymentTermDays={po.paymentTermDays}
              notesToSupplier={po.notesToSupplier}
              save={editDraftAction}
            />
          ) : null}
        </div>

        <section aria-labelledby="po-timeline" className="flex min-w-0 flex-col gap-3 lg:col-start-2 lg:row-start-2">
          <h2 id="po-timeline" className="text-lg font-semibold text-ink">
            {t('track.title')}
          </h2>
          <Timeline items={items} label={t('track.label')} />
        </section>
      </div>
    </div>
  )
}
