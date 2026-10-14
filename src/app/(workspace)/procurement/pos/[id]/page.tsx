import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { memberPrincipal } from '@/server/authz'
import { businessDaysTaken, getMyOpenTaskId, getRouteStepDetails, listPoInvoices, listPoReceipts } from '@/server/queries/document-page'
import { getPoAccess, getPurchaseOrderView, type PoViewDto } from '@/server/queries/purchase-orders'
import { getTaskAccess, getTaskView } from '@/server/queries/tasks'
import { previewPoSubmit, type PoSubmitPreviewDto } from '@/server/services/purchase-orders'
import { getPoS8View } from '@/server/services/purchase-orders/view-change'
import { PO_BADGES, StatusBadge, URGENCY_BADGES } from '@/ui/document/badges'
import { DecisionBar } from '@/ui/document/decision-bar'
import { DocBody, DocHeader } from '@/ui/document/doc-header'
import { DocMenu } from '@/ui/document/doc-header-parts'
import { DocTabs, type DocTab } from '@/ui/document/doc-tabs'
import { tabFrom } from '@/ui/document/tab-param'
import { HistoryTable } from '@/ui/document/history-table'
import { CommentList, SummaryList } from '@/ui/document/rail'
import { StepCards } from '@/ui/document/step-cards'
import { Notice } from '@/ui/form/notice'
import { DraftEditor } from '@/ui/purchase-order/draft-editor'
import { DraftPay } from '@/ui/po-change/draft-pay'
import { PoChangeRail, PoChangesTab, PoInvoicesTab } from '@/ui/po-change/po-tabs'
import { PoActions, type SubmitPreviewView } from '@/ui/purchase-order/po-actions'
import { RejectedNotice } from '@/ui/purchase-order/status'
import { DoaRef } from '@/ui/request-view/doa-ref'
import { Section } from '@/ui/request-view/facts'
import { StateLine } from '@/ui/request-view/status'
import { Toaster } from '@/ui/shadcn/sonner'
import { downloadUrlAction } from '../../../../_lib/file-actions'
import { getSession } from '../../../../_lib/session'
import { canOpenDoaVersion, taskRight } from '../../../_tracking/access'
import { commentViews, historyRows, poHistoryKinds, routeWhy, stepCards } from '../../../_tracking/document-present'
import { day, doaHref, doaRefText, localeOf, memberName, money, roleText, routeSentence, when, type Locale } from '../../../_tracking/present'
import { decideTaskAction } from '../../../tasks/actions'
import { canListPos, poReader, canViewPo, poRights } from '../_parts/access'
import { PoBody } from '../_parts/po-body'
import { docTimelineItems, waitingOf, type PoT } from '../_parts/present'
import { cancelPoAction, closePoAction, editDraftAction, sendPoAction, submitPoAction } from '../actions'
import { sendRevisionAction, setMilestonesAction, setRetentionAction } from './s8-actions'

export async function generateMetadata() {
  const t = await getTranslations('purchaseOrder')
  return { title: t('detail.metaTitle') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

/** A PO whose goods are received (or still to come) on its receiving page: it went to its supplier */
const RECEIVING_STATES: ReadonlySet<string> = new Set(['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED'])

type ViewT = Awaited<ReturnType<typeof getTranslations<'requestView'>>>
type TimelineT = Awaited<ReturnType<typeof getTranslations<'timeline'>>>

/**
 * Why the DOA engine (or the draft) stops "ส่งขออนุมัติ", as the key of its words under actions.submit.blocked: each
 * code in Thai and English with its fix (§9.9 rule 7), never the raw code. The engine refuses a VALIDATION_FAILED only
 * for the amount: a draft whose lines total 0.00, fixed by its prices in "แก้ไขร่าง".
 */
function blockedKey(code: string) {
  switch (code) {
    case 'DOA_NOT_CONFIGURED':
    case 'APPROVER_NOT_FOUND':
    case 'NO_HIGHER_AUTHORITY':
    case 'TAX_RATE_NOT_CONFIGURED':
    case 'NO_LINES':
    case 'SOD_VIOLATION':
    case 'DOA_AMBIGUOUS':
      return code
    case 'VALIDATION_FAILED':
      return 'ZERO_AMOUNT'
    default:
      return 'other'
  }
}

/** What the DOA engine expects before "ส่งขออนุมัติ" (§9.9 principle 3), in words */
function previewView(t: PoT, tv: ViewT, tl: TimelineT, locale: Locale, preview: PoSubmitPreviewDto): SubmitPreviewView {
  const route = preview.route
  const blocked = !preview.supplierActive ? t('actions.submit.supplierInactive') : route.kind === 'BLOCKED' ? t(`actions.submit.blocked.${blockedKey(route.code)}`) : null
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

/**
 * The PO's state in words above everything else: cancelled, closed, rejected, returned, or a bounced e-mail. A rejected
 * PO in --danger with a cross, as its status and its timeline say "ไม่อนุมัติ"; a PO returned for changes and a bounced
 * e-mail wait for procurement, in --warn
 */
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
      {po.status === 'REJECTED' ? <RejectedNotice>{t('detail.rejectedState')}</RejectedNotice> : null}
      {returned ? <Notice tone="warning">{t('detail.returnedNote')}</Notice> : null}
      {po.bounce && po.status === 'APPROVED' ? <Notice tone="warning">{t('actions.send.bounceState', { time: when(locale, po.bounce.at), code: po.bounce.code ?? '-' })}</Notice> : null}
    </>
  )
}

const CLOSED_PO: readonly string[] = ['CANCELLED', 'REJECTED', 'CLOSED']

// One purchase order as a tabbed document (spec §9.1 /procurement/pos/[id], FR-INT-012 AC6, FR-P2P-003 to FR-P2P-005,
// FR-P2P-010), in the frame of the request page: the header with its number, supplier, badges, menu and summary row;
// the tabs — overview (whom it waits for, the route as step cards that turn into stamps, its amounts and budget), items,
// receiving, invoices, documents (its source requests and their files) and history from its Events — and the right
// column: the decision bar for whoever holds its open approval task, procurement's actions, then its summary and its
// comments. Whoever may see the PO opens it (po.view, checked before anything is read); only procurement gets the
// actions, and the services check again.
export default async function PurchaseOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string | string[] }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [t, tv, tl, td, tc, locale] = await Promise.all([getTranslations('purchaseOrder'), getTranslations('requestView'), getTranslations('timeline'), getTranslations('document'), getTranslations('poChange'), getLocale().then(localeOf)])

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
  const [po, myTaskId, receipts, invoices, s8View] = await Promise.all([getPurchaseOrderView(ctx, id), getMyOpenTaskId(ctx, 'PURCHASE_ORDER', id), listPoReceipts(ctx, id), listPoInvoices(ctx, id), getPoS8View(ctx, id)])
  if (!po) notFound()
  const rights = poRights(principal)
  // S8-13: tier-2 invoices, milestones and retention (module PAY), and changes (DOA PO_CHANGE, BR-POC-05)
  const s8 = s8View.ok ? s8View.data : null
  const procurement = rights.edit || rights.submit || rights.send || rights.cancel || rights.close
  const lastDone = po.track.filter((e) => e.state === 'done').at(-1)?.at ?? null
  const [preview, details, daysTaken, task] = await Promise.all([
    po.next.submit && rights.submit ? previewPoSubmit(ctx, po.id) : Promise.resolve(null),
    po.route ? getRouteStepDetails(ctx, po.route.id) : Promise.resolve([]),
    businessDaysTaken(ctx, po.submittedAt, CLOSED_PO.includes(po.status) ? lastDone : null),
    myTaskId ? Promise.all([getTaskAccess(ctx, myTaskId), getTaskView(ctx, myTaskId)]) : Promise.resolve(null),
  ])
  // The decision bar: an open approval task of this PO that the reader may decide (approval.decide, BR-DLG-04)
  const decide = task && task[0] && task[1] && taskRight(principal, task[0]) === 'DECIDE' && task[1].status === 'OPEN' ? task[1] : null
  const doaLinks = canOpenDoaVersion(principal)
  // The approver decides on the prices too: the prices paid before for the same items (FR-P2P-003 AC1)
  const reader = poReader(principal, access, po, decide ? { prices: true } : {})
  const label = po.number ?? t('detail.draftLabel')
  const waiting = waitingOf(t, tv, locale, po.waiting)
  const items = docTimelineItems(t, tv, tl, locale, po.track, { doaLinks })
  const route = po.route
  const statusBadge = <StatusBadge look={PO_BADGES[po.status]} label={td(`badge.po.${po.status}`)} />
  const comments = commentViews(td, locale, po.track, t('track.system'))
  const receivingHref = RECEIVING_STATES.has(po.status) ? `/receiving/${po.id}` : null
  const digits = new Intl.NumberFormat(locale === 'en' ? 'en' : 'th')

  const overview = (
    <div className="flex flex-col gap-6">
      <div data-doc-now="" className="flex flex-col gap-1 border-l-4 border-line pl-3">
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
      <Section id="po-route" title={tv('route.title')}>
        {route ? (
          <div className="flex flex-col gap-3">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-ink-muted">{tv('route.rule')}</span>
              <DoaRef label={doaRefText(tl, route.doa)} href={doaLinks ? doaHref(route.doa.versionId) : null} />
            </p>
            <div className="flex flex-col gap-1">
              <h3 className="font-semibold text-ink">{tv('route.why')}</h3>
              <p className="break-words text-ink">{routeWhy(tv, tl, locale, route, 'PURCHASE_ORDER')}</p>
            </div>
            {route.routeNo > 1 ? <p className="text-ink-muted">{tv('route.round', { no: route.routeNo })}</p> : null}
            <StepCards
              steps={stepCards(td, tv, tl, locale, route, details, { doaLinks })}
              explanation={routeWhy(tv, tl, locale, route, 'PURCHASE_ORDER')}
              labels={{ list: td('steps.list'), open: td('steps.open'), panelHistory: td('steps.panelHistory'), panelWhy: td('steps.panelWhy'), panelNoHistory: td('steps.panelNoHistory') }}
            />
          </div>
        ) : (
          <p className="text-ink-muted">{t('detail.routeNotYet')}</p>
        )}
      </Section>
      <PoBody po={po} locale={locale} doaLinks={doaLinks} reader={reader} openFile={downloadUrlAction} parts={['money']} />
    </div>
  )

  const tabs: DocTab[] = [
    { value: 'overview', label: td('tabs.overview'), content: overview },
    { value: 'lines', label: td('tabs.lines'), content: <PoBody po={po} locale={locale} doaLinks={doaLinks} reader={reader} openFile={downloadUrlAction} parts={['money', 'lines', 'facts']} /> },
    {
      value: 'receiving',
      label: td('tabs.receiving'),
      content: (
        <div className="flex flex-col gap-3">
          {receipts.length ? (
            <ul aria-label={td('pos.receipts')} className="flex flex-col divide-y divide-line border-y border-line">
              {receipts.map((r) => (
                <li key={r.id} className="py-2.5 text-ink">
                  {`${td('pos.receipt', { number: r.number ?? '-', time: when(locale, r.receivedAt) })} · ${td(r.status === 'REVERSED' ? 'pos.receiptStatus.REVERSED' : 'pos.receiptStatus.POSTED')}`}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-muted">{td('pos.noReceipts')}</p>
          )}
          {receivingHref ? (
            <Link href={receivingHref} className={linkClass}>
              {td('pos.receiveHere')}
            </Link>
          ) : null}
        </div>
      ),
    },
    {
      value: 'invoices',
      label: td('tabs.invoices'),
      content: invoices.length ? (
        <ul aria-label={td('invoices.list')} className="flex flex-col divide-y divide-line border-y border-line">
          {invoices.map((inv) => (
            <li key={inv.id} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2.5">
              <span className="text-ink">
                {td('invoices.row', { number: inv.invoiceNo, date: day(locale, inv.invoiceDate) })}
                {inv.isFinal ? ` · ${td('invoices.final')}` : ''}
              </span>
              <span className="tabular text-ink">{td('invoices.gross', { amount: money(inv.grossSatang) })}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-muted">{td('invoices.none')}</p>
      ),
    },
    ...(s8?.invoices ? [{ value: 'ap-invoices', label: tc('tabs.invoices'), content: <PoInvoicesTab invoices={s8.invoices} /> }] : []),
    ...(s8?.changes ? [{ value: 'changes', label: tc('tabs.changes'), content: <PoChangesTab changes={s8.changes} locale={locale} canChange={s8.canChange} /> }] : []),
    { value: 'documents', label: td('tabs.documents'), content: <PoBody po={po} locale={locale} doaLinks={doaLinks} reader={reader} openFile={downloadUrlAction} parts={['requests']} /> },
    {
      value: 'history',
      label: td('tabs.history'),
      content: (
        <HistoryTable
          rows={historyRows(td, items, poHistoryKinds(po.track))}
          labels={{
            table: td('history.table'),
            filter: td('history.filter'),
            all: td('history.all'),
            kinds: { DECISION: td('history.kinds.DECISION'), DOCUMENT: td('history.kinds.DOCUMENT'), QUESTION: td('history.kinds.QUESTION'), GOODS: td('history.kinds.GOODS') },
            columns: { when: td('history.columns.when'), actor: td('history.columns.actor'), event: td('history.columns.event'), channel: td('history.columns.channel') },
            empty: td('history.empty'),
          }}
        />
      ),
    },
  ]

  const summary = (
    <SummaryList
      label={td('summary.list')}
      items={[
        { label: td('summary.net'), value: <span className="tabular">{td('summary.money', { amount: money(po.totals.netSatang) })}</span> },
        { label: td('summary.vat'), value: <span className="tabular">{td('summary.money', { amount: money(po.totals.vatSatang) })}</span> },
        { label: td('summary.gross'), value: <span className="tabular font-semibold">{td('summary.money', { amount: money(po.totals.grossSatang) })}</span> },
        { label: td('summary.kind'), value: t(`kind.${po.kind}`) },
        { label: td('header.supplier'), value: po.supplier.nameTh },
        { label: td('summary.site'), value: po.deliverySite ? `${po.deliverySite.code} · ${po.deliverySite.nameTh}` : t('detail.noSite') },
        { label: td('summary.createdBy'), value: po.createdBy ? memberName(locale, po.createdBy) : t('facts.createdByRound') },
        { label: td('summary.payment'), value: po.paymentTermDays !== null ? td('summary.paymentDays', { days: po.paymentTermDays }) : td('summary.none') },
        { label: td('summary.doa'), value: route ? doaRefText(tl, route.doa) : td('summary.none') },
      ]}
    />
  )

  return (
    <div className={decide ? 'flex flex-col gap-6 pb-[calc(var(--task-bar-space,14rem)_+_1rem)] xl:pb-0' : 'flex flex-col gap-6'}>
      <DocHeader
        back={canListPos(principal) ? { href: '/procurement/pos', label: t('detail.back') } : null}
        number={po.number ? t('detail.numberLabel', { number: po.number }) : t('detail.draftLabel')}
        title={po.supplier.nameTh}
        badges={
          <>
            {statusBadge}
            <StatusBadge look={URGENCY_BADGES[po.urgency]} label={td(`badge.urgency.${po.urgency}`)} />
          </>
        }
        actions={<DocMenu pdfHref={`/procurement/pos/${po.id}/pdf`} cancel={false} labels={{ menu: td('header.menu'), pdf: td('header.pdf'), copy: td('header.copy'), copied: td('header.copied'), cancel: td('header.cancelPo') }} />}
        summary={[
          { label: td('header.total'), value: td('header.totalValue', { amount: money(po.totals.grossSatang) }) },
          { label: td('header.supplier'), value: po.supplier.nameTh },
          { label: td('header.submitted'), value: po.submittedAt ? when(locale, po.submittedAt) : td('header.notSent') },
          { label: td('header.taken'), value: daysTaken !== null ? td('header.takenDays', { days: digits.format(daysTaken) }) : td('header.takenUnknown') },
        ]}
        compactBadge={statusBadge}
        notices={<StateNotices po={po} t={t} locale={locale} />}
      />

      <DocBody
        main={
          <>
            <DocTabs tabs={tabs} initial={tabFrom(query.tab, tabs.map((tab) => tab.value))} label={td('tabs.label')} param="tab" />
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
            {s8?.draft ? (
              <DraftPay poId={po.id} version={s8.version} retentionBp={s8.draft.retentionBp} retentionHoldDays={s8.draft.retentionHoldDays} lines={s8.draft.splittable} actions={{ milestones: setMilestonesAction, retention: setRetentionAction }} />
            ) : null}
          </>
        }
        rail={
          <>
            {decide ? (
              <DecisionBar
                taskId={decide.id}
                kind="PURCHASE_ORDER"
                label={label}
                amount={money(po.totals.grossSatang)}
                locale={locale}
                stepUp={decide.stepUp}
                facts={{
                  amount: route?.basisSatang != null ? td('bar.amountValue', { amount: money(route.basisSatang), basis: tv(`route.explain.basis.${route.amountBasis}`) }) : '-',
                  ...(route ? { doaRef: doaRefText(tl, route.doa) } : {}),
                }}
                actions={{ decide: decideTaskAction }}
              />
            ) : null}
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
                // Where what will not come is closed short (the receiving page, not in procurement's menu): once it went out
                receivingHref={receivingHref}
                {...(po.status === 'PENDING_APPROVAL' ? { nothing: t('actions.nothingWhileApproval') } : {})}
                actions={{ submit: submitPoAction, send: sendPoAction, cancel: cancelPoAction, close: closePoAction }}
              />
            ) : decide ? null : (
              <p className="text-ink-muted">{t('detail.viewOnly')}</p>
            )}
            {s8 ? <PoChangeRail poId={po.id} changeHref={s8.canChange ? `/procurement/pos/${po.id}/change` : null} revisionToSend={s8.revisionToSend} send={sendRevisionAction} /> : null}
            <DocTabs
              label={td('rail.label')}
              initial="summary"
              tabs={[
                { value: 'summary', label: td('rail.summary'), content: summary },
                { value: 'comments', label: td('rail.comments', { count: comments.length }), content: <CommentList comments={comments} label={td('comments.list')} empty={td('comments.empty')} /> },
              ]}
            />
          </>
        }
      />
      {/* The outcome of a decision or a copied link (§9.10 ข้อความแจ้งผล); above the decision bar on phones */}
      <Toaster position="top-center" />
    </div>
  )
}
