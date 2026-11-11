import { getLocale, getTranslations } from 'next-intl/server'
import { Facts, Section } from '@/ui/request-view/facts'
import { supplierApplicationRows, type SupplierApplicationLine, type SupplierApplicationTaskView } from '@/ui/liff/tasks/subjects/supplier-application-rows'

// The body of an approval task on a supplier application on the web and BCS Go (S7-09 · FR-SUP-104 AC5): the same rows
// as the LIFF summary (supplierApplicationRows), in the workspace's flat sections — the supplier and its tax facts, the
// registries' answer, the duplicate warnings with procurement's reasons, the documents with their state and verifier,
// and who invited, filled in and sent it. Questions go back as a return (allowsRequestInfo false), said under the people.

function Lines({ lines, empty }: { lines: readonly SupplierApplicationLine[]; empty: string }) {
  if (lines.length === 0) return <p className="text-ink-muted">{empty}</p>
  return (
    <ul className="flex flex-col gap-3">
      {lines.map((l, i) => (
        <li key={`${l.title}-${i}`} className="flex min-w-0 flex-col">
          <span className={l.warn ? 'break-words font-medium text-warn-ink' : 'break-words font-medium text-ink'}>{l.title}</span>
          {l.detail.map((d) => (
            <span key={d} className="break-words text-base text-ink-muted md:text-sm">
              {d}
            </span>
          ))}
        </li>
      ))}
    </ul>
  )
}

export async function SupplierApplicationBody({ application }: { application: SupplierApplicationTaskView }) {
  const [t, locale] = await Promise.all([getTranslations('supplierApplicationTask'), getLocale()])
  const rows = supplierApplicationRows(t, locale, application)
  return (
    <div className="@container flex flex-col gap-6">
      <Facts items={rows.facts} columns={2} />
      <Section id="supplier-application-registry" title={t('registry')}>
        <Lines lines={rows.registry} empty="" />
      </Section>
      <Section id="supplier-application-duplicates" title={t('duplicates')}>
        <Lines lines={rows.duplicates} empty={t('noDuplicates')} />
      </Section>
      <Section id="supplier-application-documents" title={`${t('documents')} (${t('documentCount', { count: rows.documents.length })})`}>
        <Lines lines={rows.documents} empty={t('noDocuments')} />
      </Section>
      <Section id="supplier-application-people" title={t('people')}>
        <Facts items={rows.people} columns={2} />
        <p className="text-base text-ink-muted md:text-sm">{t('returnHint')}</p>
      </Section>
    </div>
  )
}
