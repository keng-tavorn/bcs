import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { BYTES_PER_KIB } from '@/lib/constants'
import type { AttachmentDto, PoBudgetDto, PoViewDto } from '@/server/queries/purchase-orders'
import type { RouteDto, RouteStepDto } from '@/server/queries/requests'
import { PoLines, type PoLineView } from '@/ui/purchase-order/po-lines'
import { AttachmentList, type AttachmentView } from '@/ui/request-view/attachments'
import { DoaRef } from '@/ui/request-view/doa-ref'
import { Amounts, Facts, Section, type AmountRow, type Fact } from '@/ui/request-view/facts'
import { StateLine, type StateKind } from '@/ui/request-view/status'
import { day, doaHref, doaRefText, expectedText, fileKind, memberName, money, roleText, routeSentence, when, type Locale } from '../../../_tracking/present'

// The body of a purchase order as both its own page and the decision page of its approval task show it (§9.9
// principle 5: everything to decide on one screen): the amounts before VAT, VAT and with VAT from the server
// (FR-P2P-003 AC3) next to the budget line it charges and what it reserves or holds there; the lines with their source
// requests and the prices paid before (AC1); the source requests with their attachments and quotations; the supplier,
// site and terms; and the route of the DOA rule of PURCHASE_ORDER with why it goes where it goes (FR-P2P-004 AC1).
// Flat sections separated by rules; no cards. A source request is a link, and its files are listed, only for a reader
// who may open that request (request.view); the supplier's e-mail only for a reader who sees the supplier register in
// full or sends POs (supplier.view without BASIC_FIELDS_ONLY, po.send).

type PoT = Awaited<ReturnType<typeof getTranslations<'purchaseOrder'>>>

export type OpenFile = (fileId: string) => Promise<string | null>

/** What the reader may see beside the PO itself; the page works it out with src/server/authz */
export interface PoReader {
  /** The prices of other approved POs (FR-P2P-003 AC1): procurement, org-wide readers, the PO's approvers */
  readonly prices: boolean
  /** The supplier's e-mail address and where the PO was sent */
  readonly supplierContact: boolean
  /** The source requests the reader may open (request.view): linked, with their files */
  readonly requests: ReadonlySet<string>
}

function stepState(step: RouteStepDto): { kind: StateKind; key: 'WAITING' | 'ACTIVE' | 'APPROVE' | 'RETURN' | 'REJECT' | 'CANCELLED' | 'DONE' } {
  if (step.decision === 'APPROVE') return { kind: 'done', key: 'APPROVE' }
  if (step.decision === 'RETURN') return { kind: 'returned', key: 'RETURN' }
  if (step.decision === 'REJECT') return { kind: 'rejected', key: 'REJECT' }
  if (step.status === 'ACTIVE') return { kind: 'waiting', key: 'ACTIVE' }
  if (step.status === 'WAITING') return { kind: 'due', key: 'WAITING' }
  if (step.status === 'CANCELLED') return { kind: 'closed', key: 'CANCELLED' }
  return { kind: 'done', key: 'DONE' }
}

/** The route a document took under the DOA, with its rule, why, and each step's approver and state */
export async function RouteSection({ id, route, locale, doaLinks, subject, empty }: { id: string; route: RouteDto | null; locale: Locale; doaLinks: boolean; subject: 'PURCHASE_ORDER' | 'VARIANCE'; empty: string }) {
  const [tv, tl] = await Promise.all([getTranslations('requestView'), getTranslations('timeline')])
  return (
    <Section id={id} title={tv('route.title')}>
      {route ? (
        <div className="flex flex-col gap-3">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-ink-muted">{tv('route.rule')}</span>
            <DoaRef label={doaRefText(tl, route.doa)} href={doaLinks ? doaHref(route.doa.versionId) : null} />
          </p>
          <div className="flex flex-col gap-1">
            <h3 className="font-medium text-ink">{tv('route.why')}</h3>
            <p className="break-words text-ink">{routeSentence(tv, tl, locale, route, subject)}</p>
          </div>
          {route.routeNo > 1 ? <p className="text-base text-ink-muted md:text-sm">{tv('route.round', { no: route.routeNo })}</p> : null}
          <ol className="flex flex-col divide-y divide-line border-t border-line">
            {route.steps.map((step) => {
              const state = stepState(step)
              const who = step.approver ? memberName(locale, step.approver) : expectedText(locale, step.expected)
              const role = roleText(tv, locale, step.role)
              return (
                <li key={step.stepNo} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <div className="min-w-0">
                    <p className="font-medium text-ink">
                      {tv('route.step', { no: step.stepNo })}
                      {who ? ` · ${who}` : ''}
                    </p>
                    {role ? <p className="text-ink-muted">{role}</p> : null}
                    {step.onBehalfOf ? <p className="text-ink-muted">{tv('actingFor', { name: memberName(locale, step.onBehalfOf) })}</p> : null}
                  </div>
                  <StateLine kind={state.kind} className="shrink-0">
                    {tv(`route.stepState.${state.key}`)}
                  </StateLine>
                </li>
              )
            })}
          </ol>
        </div>
      ) : (
        <p className="text-ink-muted">{empty}</p>
      )}
    </Section>
  )
}

/** Files of a document as AttachmentList shows them: the name, then its kind and size in words */
export async function attachmentViews(locale: Locale, files: readonly AttachmentDto[]): Promise<AttachmentView[]> {
  const tv = await getTranslations('requestView')
  const kb = (bytes: number) => new Intl.NumberFormat(locale === 'en' ? 'en' : 'th').format(Math.max(1, Math.ceil(bytes / BYTES_PER_KIB)))
  return files.map((f) => ({ fileId: f.fileId, fileName: f.fileName, detail: `${tv(`files.kind.${fileKind(f.kind)}`)} · ${tv('files.size', { size: kb(f.sizeBytes) })}` }))
}

/** The lines of a PO for PoLines: sources as links to the requests the reader may open, prices paid before when they may see them */
export async function poLineViews(po: PoViewDto, locale: Locale, reader: PoReader): Promise<PoLineView[]> {
  const t = await getTranslations('purchaseOrder')
  const prices = new Map(po.prices.lines.map((p) => [p.poLineId, p]))
  const pct = new Intl.NumberFormat(locale === 'en' ? 'en' : 'th', { maximumFractionDigits: 2 }).format(po.prices.alertPct)
  return po.lines.map((l) => {
    const history = prices.get(l.id)
    const received = l.receivedQuantity !== '0' && (po.status === 'SENT' || po.status === 'PARTIALLY_RECEIVED' || po.status === 'RECEIVED' || po.status === 'CLOSED')
    return {
      key: l.id,
      title: `${l.lineNo}. ${l.description}`,
      sources: l.sources.map((s) => ({
        href: reader.requests.has(s.requestId) ? `/requests/${s.requestId}` : null,
        label: s.requestNumber
          ? t('lines.source', { number: s.requestNumber, line: s.requestLineNo, quantity: t('lines.qty', { quantity: s.quantity, uom: l.uom }) })
          : t('lines.sourceNoNumber', { title: s.requestTitle, line: s.requestLineNo, quantity: t('lines.qty', { quantity: s.quantity, uom: l.uom }) }),
      })),
      notes: [
        ...(l.vatable ? [] : [t('lines.noVat')]),
        ...(received ? [t('lines.received', { quantity: t('lines.qty', { quantity: l.receivedQuantity, uom: l.uom }) })] : []),
        ...(l.cancelledQuantity !== '0' ? [t('lines.cancelled', { quantity: t('lines.qty', { quantity: l.cancelledQuantity, uom: l.uom }) })] : []),
      ],
      quantity: t('lines.qty', { quantity: l.quantity, uom: l.uom }),
      unitPrice: money(l.unitPriceSatang),
      amount: money(l.netSatang),
      prices:
        reader.prices && history
          ? {
              title: t('lines.pricesTitle'),
              entries: history.previous.map((p) => t('lines.price', { number: p.poNumber, date: day(locale, p.approvedAt), price: money(p.unitPriceSatang) })),
              none: history.previous.length ? null : t('lines.pricesNone'),
              alert: history.alert ? t('lines.priceAlert', { pct }) : null,
              ok: !history.alert && history.previous.length ? t('lines.priceOk', { pct }) : null,
            }
          : null,
    }
  })
}

/** Supplier, site, kind, who made it and who sent it, when, payment terms and the note to the supplier — one label each */
export async function PoFacts({ po, locale, reader }: { po: PoViewDto; locale: Locale; reader: PoReader }) {
  const t = await getTranslations('purchaseOrder')
  const supplier = `${po.supplier.code} · ${po.supplier.nameTh}`
  const items: Fact[] = [
    { label: t('facts.supplier'), value: po.supplier.active ? supplier : t('facts.supplierInactive', { name: supplier }) },
    ...(reader.supplierContact ? [{ label: t('facts.email'), value: po.supplier.email ?? t('facts.noEmail') }] : []),
    { label: t('facts.site'), value: po.deliverySite ? po.deliverySite.nameTh : t('detail.noSite') },
    { label: t('facts.kind'), value: t(`kind.${po.kind}`) },
    { label: t('facts.urgency'), value: po.urgency === 'URGENT' ? t('facts.urgent') : t('facts.normal') },
    { label: t('facts.createdBy'), value: po.createdBy ? memberName(locale, po.createdBy) : t('facts.createdByRound') },
    { label: t('facts.created'), value: when(locale, po.createdAt) },
    ...(po.submittedBy ? [{ label: t('facts.submittedBy'), value: memberName(locale, po.submittedBy) }] : []),
    ...(po.submittedAt ? [{ label: t('facts.submitted'), value: when(locale, po.submittedAt) }] : []),
    ...(po.approvedAt ? [{ label: t('facts.approved'), value: when(locale, po.approvedAt) }] : []),
    ...(po.sentAt
      ? [{ label: t('facts.sent'), value: reader.supplierContact && po.sentToEmail ? t('facts.sentValue', { time: when(locale, po.sentAt), email: po.sentToEmail }) : when(locale, po.sentAt) }]
      : []),
    {
      label: t('facts.paymentTerms'),
      value: po.paymentTermDays === null ? t('facts.notSet') : po.paymentTermDays === 0 ? t('facts.paymentCash') : t('facts.paymentDays', { days: po.paymentTermDays }),
    },
    { label: t('facts.note'), value: po.notesToSupplier ? <span className="whitespace-pre-line">{po.notesToSupplier}</span> : t('facts.notSet') },
  ]
  return <Facts items={items} className="lg:grid-cols-2" />
}

/** Where the PO stands on a budget line, in words with an icon (never colour alone) */
function budgetState(po: PoViewDto, b: PoBudgetDto): { kind: StateKind; key: 'HELD' | 'RESERVED' | 'DRAFT' | 'RELEASED' | 'CLOSED' } {
  if (po.status === 'CANCELLED' || po.status === 'REJECTED') return { kind: 'closed', key: 'RELEASED' }
  if (po.status === 'CLOSED') return { kind: 'closed', key: 'CLOSED' }
  if (b.committedSatang > 0n || b.actualSatang > 0n) return { kind: 'done', key: 'HELD' }
  if (po.status === 'PENDING_APPROVAL') return { kind: 'done', key: 'RESERVED' }
  return { kind: 'draft', key: 'DRAFT' }
}

/**
 * The budget of the PO (§9.9 principle 5: the state of the budget): each budget line it charges, and the PO's own
 * amounts there — what its lines cost, what the requests reserve for it until the approval, what it reserved above them,
 * what it holds and what was spent. Never the balance of the line (budget.view, §2.4).
 */
async function PoBudget({ po, t }: { po: PoViewDto; t: PoT }) {
  if (po.budget.length === 0) return <p className="text-ink-muted">{t('budget.none')}</p>
  return (
    <div className="flex flex-col divide-y divide-line">
      {po.budget.map((b) => {
        const state = budgetState(po, b)
        const rows: AmountRow[] = [
          { label: t('budget.need'), value: money(b.needSatang) },
          ...(b.requestReservedSatang > 0n ? [{ label: t('budget.requestReserved'), value: money(b.requestReservedSatang) }] : []),
          ...(b.reservedSatang > 0n ? [{ label: t('budget.reserved'), value: money(b.reservedSatang) }] : []),
          ...(b.committedSatang > 0n ? [{ label: t('budget.committed'), value: money(b.committedSatang) }] : []),
          ...(b.actualSatang > 0n ? [{ label: t('budget.actual'), value: money(b.actualSatang) }] : []),
        ]
        return (
          <div key={b.lineId} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
            <Facts
              className="sm:grid-cols-1"
              items={[
                { label: t('budget.line'), value: `${b.code} · ${b.name}` },
                {
                  label: t('budget.stateLabel'),
                  value: (
                    <span className="flex flex-col">
                      <StateLine kind={state.kind}>{t(`budget.state.${state.key}`)}</StateLine>
                      {b.status !== 'OPEN' ? <StateLine kind="closed">{t(`budget.lineStatus.${b.status}`)}</StateLine> : null}
                    </span>
                  ),
                },
              ]}
            />
            <Amounts heading={t('amounts.unit')} unit={t('amounts.unit')} rows={rows} />
          </div>
        )
      })}
      <p className="pt-3 text-base text-ink-muted md:text-sm">{t('budget.note')}</p>
    </div>
  )
}

/** The requests the PO orders, each with who asked and its attachments and quotations (FR-PLT-004 AC2) */
async function PoRequests({ po, locale, reader, openFile, t }: { po: PoViewDto; locale: Locale; reader: PoReader; openFile: OpenFile; t: PoT }) {
  const views = new Map(await Promise.all(po.requests.map(async (r) => [r.id, await attachmentViews(locale, r.attachments)] as const)))
  return (
    <ul aria-label={t('requests.label')} className="flex flex-col divide-y divide-line border-t border-line">
      {po.requests.map((r) => {
        const open = reader.requests.has(r.id)
        const label = r.number ? t('requests.title', { number: r.number, title: r.title }) : r.title
        const files = views.get(r.id) ?? []
        return (
          <li key={r.id} className="flex flex-col gap-2 py-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              {open ? (
                <Link href={`/requests/${r.id}`} className="self-start font-medium break-words text-primary underline underline-offset-4 hover:no-underline">
                  {label}
                </Link>
              ) : (
                <p className="font-medium break-words text-ink">{label}</p>
              )}
              {r.requester ? <p className="text-base text-ink-muted md:text-sm">{t('requests.requester', { name: memberName(locale, r.requester) })}</p> : null}
            </div>
            {!open ? (
              <p className="text-base text-ink-muted md:text-sm">{t('requests.closed')}</p>
            ) : files.length ? (
              <AttachmentList open={openFile} files={files} />
            ) : (
              <p className="text-base text-ink-muted md:text-sm">{t('requests.noFiles')}</p>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export async function PoBody({ po, locale, doaLinks, reader, openFile }: { po: PoViewDto; locale: Locale; doaLinks: boolean; reader: PoReader; openFile: OpenFile }) {
  const t = await getTranslations('purchaseOrder')
  const draft = po.status === 'DRAFT'
  const note = !draft ? t('amounts.fixedNote') : po.totals.basis === 'TODAY' ? t('amounts.draftNote') : t('amounts.draftNoteStored')
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 md:grid-cols-2">
        <Section id="po-amounts" title={t('amounts.title')}>
          <Amounts
            heading={t('amounts.unit')}
            unit={t('amounts.unit')}
            rows={[
              { label: t('amounts.net'), value: money(po.totals.netSatang) },
              { label: po.totals.vatRateBp !== null ? t('amounts.vat', { rate: po.totals.vatRateBp / 100 }) : t('amounts.vatPlain'), value: money(po.totals.vatSatang) },
              { label: t('amounts.gross'), value: money(po.totals.grossSatang), total: true },
            ]}
          />
          <p className="text-base text-ink-muted md:text-sm">{note}</p>
        </Section>

        <Section id="po-budget" title={t('budget.title')}>
          <PoBudget po={po} t={t} />
        </Section>
      </div>

      <Section id="po-lines" title={t('lines.title')}>
        <PoLines
          lines={await poLineViews(po, locale, reader)}
          labels={{ list: t('lines.label'), description: t('lines.description'), quantity: t('lines.quantity'), unitPrice: t('lines.unitPrice'), amount: t('lines.amount') }}
        />
      </Section>

      <Section id="po-requests" title={t('requests.heading')}>
        <PoRequests po={po} locale={locale} reader={reader} openFile={openFile} t={t} />
      </Section>

      <Section id="po-facts" title={t('facts.title')}>
        <PoFacts po={po} locale={locale} reader={reader} />
      </Section>

      <RouteSection id="po-route" route={po.route} locale={locale} doaLinks={doaLinks} subject="PURCHASE_ORDER" empty={t('detail.routeNotYet')} />
    </div>
  )
}
