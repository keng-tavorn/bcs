import { getLocale, getTranslations } from 'next-intl/server'
import { LiffSection } from '../../content'
import { supplierApplicationRows, type SupplierApplicationLine, type SupplierApplicationRow, type SupplierApplicationTaskView } from './supplier-application-rows'

export type { SupplierApplicationTaskView } from './supplier-application-rows'

// The LIFF summary of an approval task on a supplier application (S7-09 · FR-SUP-104 AC5 · BR-NOTI ข้อ 10 · ADR-052):
// who the supplier is — the legal name, or a sole proprietor's full name on this signed-in page only — its kind and
// category, the tax id (a sole proprietor's with its last four digits only) and branch, what the registries said, the
// duplicate warnings with procurement's reason for each, the documents with their state and verifier, and who invited,
// filled in and sent it. No workspace component: plain lists in the LIFF type sizes. The web task page renders the same
// rows (supplierApplicationRows) in its own sections. Questions go back as a return (allowsRequestInfo false).

function RowList({ rows }: { rows: readonly SupplierApplicationRow[] }) {
  return (
    <dl className="flex flex-col gap-3">
      {rows.map((r) => (
        <div key={r.label} className="flex flex-col">
          <dt className="text-ink-muted">{r.label}</dt>
          <dd className="tabular break-words text-ink">{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function LineList({ lines, empty }: { lines: readonly SupplierApplicationLine[]; empty: string }) {
  if (lines.length === 0) return <p className="text-ink-muted">{empty}</p>
  return (
    <ul className="flex flex-col gap-3">
      {lines.map((l, i) => (
        <li key={`${l.title}-${i}`} className="flex flex-col">
          <span className={l.warn ? 'break-words font-medium text-warn-ink' : 'break-words font-medium text-ink'}>{l.title}</span>
          {l.detail.map((d) => (
            <span key={d} className="break-words text-ink-muted">
              {d}
            </span>
          ))}
        </li>
      ))}
    </ul>
  )
}

export async function LiffSupplierApplicationSummary({ application }: { application: SupplierApplicationTaskView | null }) {
  if (!application) return null
  const [t, locale] = await Promise.all([getTranslations('supplierApplicationTask'), getLocale()])
  const rows = supplierApplicationRows(t, locale, application)
  return (
    <>
      <LiffSection id="supplier-application-summary" title={t('heading')}>
        <RowList rows={rows.facts} />
      </LiffSection>
      <LiffSection id="supplier-application-registry" title={t('registry')}>
        <LineList lines={rows.registry} empty="" />
      </LiffSection>
      <LiffSection id="supplier-application-duplicates" title={t('duplicates')}>
        <LineList lines={rows.duplicates} empty={t('noDuplicates')} />
      </LiffSection>
      <LiffSection id="supplier-application-documents" title={`${t('documents')} (${t('documentCount', { count: rows.documents.length })})`}>
        <LineList lines={rows.documents} empty={t('noDocuments')} />
      </LiffSection>
      <LiffSection id="supplier-application-people" title={t('people')}>
        <RowList rows={rows.people} />
        <p className="text-ink-muted">{t('returnHint')}</p>
      </LiffSection>
    </>
  )
}
