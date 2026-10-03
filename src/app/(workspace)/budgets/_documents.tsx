import type { BudgetDocumentsDto, BudgetLineRefDto, BudgetMovementDto, BudgetPoDocDto } from '@/server/services/budget/documents'
import { moneyText } from '@/ui/budgets/format'
import { DocumentSection, MovementSection, type DocumentRowView } from '@/ui/budgets/line-detail'
import { formatDateTime } from '@/ui/format'
import { budgetHref, dayText, nameIn, type BudgetsT, type Locale } from './_present'

// The sections of a budget drill-down (spec §11.2, FR-BUD-005 AC2), the same on the page of a line, a department and
// everything shown: the imports behind the planned amount, the documents behind reserved, committed and actual, and the
// ledger's movements behind what is available — each section the anchor the matching amount links to. On the pages of
// several lines (`many`) each document and movement names the line it holds money on.

// The statuses and buckets the budgets namespace names (the services return them as text)
type RequestStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'RETURNED' | 'CANCELLED' | 'PARTIALLY_ORDERED' | 'ORDERED' | 'COMPLETED' | 'SUBMITTED' | 'DONE'
type PoStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'SENT' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CLOSED' | 'CANCELLED' | 'REJECTED'
type Bucket = 'OUTSIDE' | 'AVAILABLE' | 'RESERVED' | 'COMMITTED' | 'ACTUAL'

/** A document's lines are named one by one up to this many, then counted */
const LINES_NAMED = 3

export function BudgetDocumentSections({ t, locale, docs, many }: { t: BudgetsT; locale: Locale; docs: BudgetDocumentsDto; many: boolean }) {
  const when = (at: string) => formatDateTime(locale, at)
  const scope = many ? 'many' : 'one'
  const unit = t('unit')
  const docLabels = { document: t('line.movementColumns.document'), status: t('export.columns.status'), amount: t(`detail.amountOn.${scope}`), unit }
  const linesMeta = (lines: readonly BudgetLineRefDto[]): string[] =>
    !many || lines.length === 0 ? [] : [lines.length <= LINES_NAMED ? t('detail.onLines', { codes: lines.map((l) => l.code).join(', ') }) : t('detail.onManyLines', { count: lines.length })]
  const more = (shown: number, count: number) => (count > shown ? t('detail.more', { shown, count }) : null)
  const total = (amount: { amount: string }) => t('line.sectionTotal', { amount: moneyText(amount) })

  const poRow = (po: BudgetPoDocDto, note: string | null): DocumentRowView => ({
    key: po.id,
    title: t('line.purchaseOrder', { number: po.number ?? t('line.noNumber') }),
    href: po.canOpen ? `/procurement/pos/${po.id}` : null,
    detail: po.supplier ? t('line.supplier', { name: nameIn(locale, po.supplier) }) : null,
    meta: linesMeta(po.lines),
    status: { kind: po.status, label: t(`poStatus.${po.status as PoStatus}`) },
    note,
    amount: moneyText(po.amount),
    invoices: null,
  })

  const plannedRows: DocumentRowView[] = docs.planned.imports.map((i) => ({
    key: i.id,
    title: i.fileName ? t('line.importFile', { name: i.fileName }) : t('line.initialBudget'),
    href: null,
    detail: null,
    meta: linesMeta(i.lines),
    status: null,
    note: t('detail.importedAt', { time: when(i.at) }),
    amount: moneyText(i.amount),
    invoices: null,
  }))
  const reservedRows: DocumentRowView[] = [
    ...docs.reserved.requests.map((r) => ({
      key: r.id,
      title: t('line.request', { number: r.number ?? t('line.noNumber') }),
      href: r.canOpen ? `/requests/${r.id}` : null,
      detail: r.title,
      meta: [
        ...linesMeta(r.lines),
        ...(r.submittedAt ? [t('line.submittedAt', { time: when(r.submittedAt) })] : []),
        ...(r.requester ? [t('line.requester', { name: nameIn(locale, r.requester) })] : []),
      ],
      status: { kind: r.status, label: t(`requestStatus.${r.status as RequestStatus}`) },
      note: null,
      amount: moneyText(r.amount),
      invoices: null,
    })),
    ...docs.reserved.purchaseOrders.map((po) => poRow(po, t('line.poExtra'))),
  ]
  const committedRows = docs.committed.purchaseOrders.map((po) => poRow(po, null))
  const actualRows = docs.actual.purchaseOrders.map((po) => ({
    ...poRow(po, null),
    invoices: {
      label: t('line.invoicesLabel', { po: po.number ?? t('line.noNumber') }),
      rows: po.invoices.map((i) => ({ key: i.id, text: t('line.invoice', { number: i.invoiceNo, date: dayText(locale, i.invoiceDate) }), amount: moneyText(i.amount) })),
    },
  }))

  const movementWhat = (m: BudgetMovementDto) =>
    m.kind ? t(`line.kinds.${m.kind}`) : t('line.kinds.OTHER', { from: t(`line.buckets.${m.from as Bucket}`), to: t(`line.buckets.${m.to as Bucket}`) })
  const movementDocument = (m: BudgetMovementDto): { text: string; href: string | null } => {
    const d = m.document
    if (d.type === 'IMPORT') return { text: d.label ? t('line.importFile', { name: d.label }) : t('line.initialBudget'), href: null }
    if (d.type === 'REQUEST') return { text: t('line.request', { number: d.label ?? t('line.noNumber') }), href: d.canOpen ? `/requests/${d.id}` : null }
    return { text: t('line.purchaseOrder', { number: d.label ?? t('line.noNumber') }), href: d.canOpen ? `/procurement/pos/${d.id}` : null }
  }
  const movements = docs.movements

  return (
    <>
      <DocumentSection
        id="planned"
        title={t('detail.plannedTitle')}
        intro={t('detail.plannedIntro')}
        rows={plannedRows}
        empty={t('detail.plannedEmpty')}
        total={total(docs.planned.total)}
        more={more(docs.planned.imports.length, docs.planned.count)}
        labels={{ document: t('line.movementColumns.document'), status: t('detail.importedColumn'), amount: t('detail.importedAmount'), unit }}
      />
      <DocumentSection
        id="reserved"
        title={t('line.reservedTitle')}
        intro={t('line.reservedIntro')}
        rows={reservedRows}
        empty={t(`detail.reservedEmpty.${scope}`)}
        total={total(docs.reserved.total)}
        more={more(docs.reserved.requests.length + docs.reserved.purchaseOrders.length, docs.reserved.requestCount + docs.reserved.purchaseOrderCount)}
        labels={docLabels}
      />
      <DocumentSection
        id="committed"
        title={t('line.committedTitle')}
        intro={t('line.committedIntro')}
        rows={committedRows}
        empty={t(`detail.committedEmpty.${scope}`)}
        total={total(docs.committed.total)}
        more={more(docs.committed.purchaseOrders.length, docs.committed.count)}
        labels={docLabels}
      />
      <DocumentSection
        id="actual"
        title={t('line.actualTitle')}
        intro={t('line.actualIntro')}
        rows={actualRows}
        empty={t(`detail.actualEmpty.${scope}`)}
        total={total(docs.actual.total)}
        more={more(docs.actual.purchaseOrders.length, docs.actual.count)}
        labels={docLabels}
      />
      <MovementSection
        title={t('line.movementsTitle')}
        intro={t('line.movementsIntro')}
        count={movements.rows.length < movements.total ? t('line.movementsCount', { shown: movements.rows.length, total: movements.total }) : t('line.movementsAll', { total: movements.total })}
        rows={movements.rows.map((m) => ({
          key: `${m.line.id}-${m.seq}`,
          when: when(m.at),
          what: movementWhat(m),
          document: movementDocument(m),
          line: many ? { text: t('detail.line', { code: m.line.code }), href: budgetHref.line(m.line.id) } : null,
          amount: moneyText(m.amount),
        }))}
        empty={t(`detail.movementsEmpty.${scope}`)}
        labels={{ when: t('line.movementColumns.when'), what: t('line.movementColumns.what'), document: t('line.movementColumns.document'), amount: t('line.movementColumns.amount'), unit }}
      />
    </>
  )
}
