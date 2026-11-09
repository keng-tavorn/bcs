import { AlarmClock } from 'lucide-react'
import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getSupplierApplicationForScreen, listApplicationAiReadings } from '@/server/services/suppliers/applications-view'
import { listSupplierDocuments } from '@/server/services/suppliers/documents'
import { formatDateTime } from '@/ui/format'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Facts, type Fact } from '@/ui/request-view/facts'
import { Badge } from '@/ui/shadcn/badge'
import { DocumentsPanel } from '@/ui/supplier-docs/documents-panel'
import { ApplicationActions } from '@/ui/supplier-applications/application-actions'
import { AiReadings } from '@/ui/supplier-applications/ai-readings'
import { formatTaxId } from '@/ui/suppliers/model'
import { getSession } from '../../../../_lib/session'
import { completeUploadAction, requestUploadAction } from '../../../../_lib/file-actions'
import { openDocumentAction, rejectDocumentAction, verifyDocumentAction } from '../../[id]/document-actions'
import { cancelApplicationAction, reinviteApplicationAction, returnApplicationAction, routeApplicationAction } from '../actions'

// /suppliers/applications/[id] (S7-09 · docs/sub-specs/S7.md): one application — what was filled in and by whom (the
// source of each field), what the registries said, the duplicate warnings with their reasons, what is still missing,
// its documents with verify and reject (S7-06's panel), its contacts, the people of it, and its timeline; with what
// PROCUREMENT can do now. The approver of its task reads it too (supplier.application.view ASSIGNED).

export async function generateMetadata() {
  const t = await getTranslations('supplierApplications.list')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
type FieldWithSource = 'nameTh' | 'nameEn' | 'payeeType' | 'taxId' | 'branchCode' | 'isVatRegistered' | 'address' | 'phone' | 'email' | 'category' | 'bankCode'
const SOURCES = ['MANUAL', 'ON_BEHALF', 'AI', 'REGISTRY'] as const
const WARNINGS = ['SAME_TAXID_OTHER_BRANCH', 'DUPLICATE_NAME', 'DUPLICATE_EMAIL'] as const
const MISSING_FIELDS = ['nameTh', 'taxId', 'branchCode', 'address'] as const

export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const { id } = await params
  const [t, ta, locale] = await Promise.all([getTranslations('supplierApplications'), getTranslations('audit'), getLocale()])
  const result = await getSupplierApplicationForScreen(ctx, id)
  if (!result.ok) {
    return (
      <Page>
        <PageHeader title={result.error.code === 'NOT_FOUND' ? t('detail.notFound') : t('detail.forbidden')} />
        <Link href="/suppliers/applications" className={linkClass}>
          {t('detail.back')}
        </Link>
      </Page>
    )
  }
  const a = result.data
  const [docs, aiReadings] = await Promise.all([listSupplierDocuments(ctx, { applicationId: a.id }), listApplicationAiReadings(ctx, a.id)])
  const f = a.fields
  const notSet = <span className="text-ink-muted">{t('detail.field.notSet')}</span>
  const source = (key: FieldWithSource) => {
    const s = a.fieldSources[key]
    return s && (SOURCES as readonly string[]).includes(s) ? <span className="block text-base text-ink-muted md:text-sm">{t(`detail.source.${s as (typeof SOURCES)[number]}`)}</span> : null
  }
  const withSource = (key: FieldWithSource, value: string | null) => (
    <span className="flex flex-col">
      <span className="break-words">{value ?? notSet}</span>
      {source(key)}
    </span>
  )
  const facts: Fact[] = [
    { label: t('detail.field.nameTh'), value: withSource('nameTh', f.nameTh) },
    { label: t('detail.field.nameEn'), value: withSource('nameEn', f.nameEn) },
    { label: t('detail.field.payeeType'), value: withSource('payeeType', t(`detail.payee.${f.payeeType}`)) },
    ...(f.payeeType === 'FOREIGN' ? [] : [{ label: t('detail.field.taxId'), value: withSource('taxId', f.taxId ? formatTaxId(f.taxId) : null) }]),
    { label: t('detail.field.branchCode'), value: withSource('branchCode', f.branchCode) },
    { label: t('detail.field.vat'), value: withSource('isVatRegistered', f.isVatRegistered ? t('detail.field.yes') : t('detail.field.no')) },
    { label: t('detail.field.address'), value: withSource('address', f.address) },
    { label: t('detail.field.phone'), value: withSource('phone', f.phone) },
    { label: t('detail.field.email'), value: withSource('email', f.email) },
    { label: t('detail.field.category'), value: withSource('category', f.category) },
    { label: t('detail.field.bank'), value: withSource('bankCode', f.accountNoLast4 ? `${f.bankCode ?? ''} •••• ${f.accountNoLast4}${f.accountName ? ` · ${f.accountName}` : ''}` : null) },
  ]
  const people: Fact[] = [
    { label: t('detail.inviter'), value: a.people.inviter ?? '-' },
    ...(a.people.filledOnBehalf ? [{ label: t('detail.filler'), value: a.people.filledOnBehalf }] : []),
    ...(a.people.router ? [{ label: t('detail.router'), value: a.people.router }] : []),
    { label: t('detail.invitedAt'), value: formatDateTime(locale, a.dates.invitedAt) },
    { label: t('detail.lastActivityAt'), value: formatDateTime(locale, a.dates.lastActivityAt) },
    ...(['INVITED', 'DRAFT', 'RETURNED'].includes(a.status) ? [{ label: t('detail.expiresAt'), value: formatDateTime(locale, a.dates.expiresAt) }] : []),
    ...(a.dates.submittedAt ? [{ label: t('detail.submittedAt'), value: formatDateTime(locale, a.dates.submittedAt) }] : []),
    ...(a.dates.decidedAt ? [{ label: t('detail.decidedAt'), value: formatDateTime(locale, a.dates.decidedAt) }] : []),
  ]
  const typeName = (code: string) => {
    const type = a.documentTypeNames[code]
    return type ? (locale === 'en' ? type.nameEn : type.nameTh) : code
  }
  const missingWord = (m: string) =>
    m.startsWith('document:') ? t('detail.document', { type: typeName(m.slice('document:'.length)) }) : (MISSING_FIELDS as readonly string[]).includes(m) ? t(`detail.field.${m as (typeof MISSING_FIELDS)[number]}`) : m
  const eventWord = (type: string) => {
    const k = `events.${type}`
    return ta.has(k as never) ? ta(k as never) : type
  }
  const supplierId = a.approvedSupplierId ?? a.supplierId

  return (
    <Page>
      <PageHeader title={a.number ? `${a.number} · ${f.nameTh}` : f.nameTh}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={a.status === 'APPROVED' ? 'ok' : a.status === 'REJECTED' || a.status === 'CANCELLED' || a.status === 'EXPIRED' ? 'neutral' : 'info'}>{t(`status.${a.status}`)}</Badge>
          {a.overdue ? (
            <Badge variant="warn">
              <AlarmClock aria-hidden="true" />
              {t('overdue')}
            </Badge>
          ) : null}
          {supplierId ? (
            <Link href={`/suppliers/${supplierId}`} className={linkClass}>
              {t('detail.supplierLink')}
            </Link>
          ) : null}
        </div>
      </PageHeader>
      <PageBody>
        <Link href="/suppliers/applications" className={linkClass}>
          {t('detail.back')}
        </Link>
        {a.returnReason && a.status === 'RETURNED' ? <Notice tone="warning">{t('detail.returnReason', { reason: a.returnReason })}</Notice> : null}
        <ApplicationActions
          applicationId={a.id}
          version={a.version}
          status={a.status}
          kind={a.kind}
          can={a.can}
          actions={{ route: routeApplicationAction, returnIt: returnApplicationAction, cancel: cancelApplicationAction, reinvite: reinviteApplicationAction }}
          uploads={{ requestUpload: requestUploadAction, completeUpload: completeUploadAction }}
        />
        {a.missing.length && ['INVITED', 'DRAFT', 'RETURNED'].includes(a.status) ? (
          <Panel title={t('detail.missing')} id="missing">
            <ul className="list-disc pl-5">
              {a.missing.map((m) => (
                <li key={m}>{missingWord(m)}</li>
              ))}
            </ul>
          </Panel>
        ) : null}
        {a.warnings.length ? (
          <Panel title={t('detail.warnings')} id="warnings">
            <ul className="flex flex-col gap-3">
              {a.warnings.map((w) => (
                <li key={w.code} className="flex flex-col gap-0.5">
                  <span className="font-medium">{(WARNINGS as readonly string[]).includes(w.code) ? t(`detail.warning.${w.code as (typeof WARNINGS)[number]}`) : w.code}</span>
                  {w.matches.length ? <span className="text-ink-muted">{t('detail.matches', { refs: w.matches.join(', ') })}</span> : null}
                  <span>{w.reason ? t('detail.reason', { reason: w.reason }) : t('detail.noReason')}</span>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
        <Panel title={t('detail.facts')} id="facts">
          <Facts items={facts} columns={2} />
        </Panel>
        <Panel title={t('detail.registry')} id="registry">
          {a.registry ? (
            <Facts
              items={[
                { label: t('detail.registrySource'), value: registrySourceLabel(a.registry.source, t) },
                ...(a.registry.nameTh ? [{ label: t('detail.registryName'), value: a.registry.nameTh }] : []),
                ...(a.registry.juristicStatus ? [{ label: t('detail.registryStatus'), value: a.registry.juristicStatus }] : []),
              ]}
            />
          ) : (
            <p className="text-ink-muted">{t('detail.registryNone')}</p>
          )}
          {a.registry?.vatCancelled ? <Notice tone="warning">{t('detail.vatCancelled')}</Notice> : null}
          {a.registry?.manualProof ? <p>{t('detail.manualProof')}</p> : null}
        </Panel>
        {docs.ok ? (
          <Panel title={t('detail.documents')} id="documents">
            <DocumentsPanel rows={docs.data.rows} canVerify={docs.data.canVerify} actions={{ verify: verifyDocumentAction, reject: rejectDocumentAction, open: openDocumentAction }} />
          </Panel>
        ) : null}
        {/* S7-14 (FR-AI-304 AC2): what the AI read off the documents, beside them */}
        {aiReadings.length ? (
          <Panel title={t('detail.ai.title')} id="ai-readings">
            <AiReadings
              readings={aiReadings}
              labels={{
                byAi: t('detail.ai.byAi'),
                taken: t('detail.ai.taken'),
                mustConfirm: t('detail.ai.mustConfirm'),
                confidence: (percent) => t('detail.ai.confidence', { percent }),
                field: (path) => t(`detail.ai.field.${path as 'nameTh'}`),
                doc: (code) => (code === 'COMPANY_CERT' || code === 'VAT_CERT' || code === 'BANK_BOOK' ? t(`detail.ai.doc.${code}`) : t('detail.ai.doc.OTHER')),
                check: (result) => t(`detail.ai.check.${result}`),
                docCheck: (code) => t(`detail.ai.docCheck.${code}`),
                yesNo: (value) => (value ? t('detail.ai.yes') : t('detail.ai.no')),
              }}
            />
          </Panel>
        ) : null}
        <Panel title={t('detail.contacts')} id="contacts">
          <ul className="flex flex-col gap-2">
            {a.contacts.map((c) => (
              <li key={c.id} className="flex flex-col">
                <span className="font-medium">{c.nameTh}</span>
                <span className="break-all text-ink-muted">
                  {c.email}
                  {c.isPrimary ? ` · ${t('detail.primary')}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title={t('detail.people')} id="people">
          <Facts items={people} columns={2} />
        </Panel>
        <Panel title={t('detail.timeline')} id="timeline">
          {a.timeline.length ? (
            <ol className="flex flex-col gap-2">
              {a.timeline.map((e) => (
                <li key={e.id} className="flex flex-col">
                  <span>{eventWord(e.type)}</span>
                  <span className="text-ink-muted">
                    {formatDateTime(locale, e.occurredAt)}
                    {e.actor.name ? ` · ${t('detail.by', { name: e.actor.name })}` : ''}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-ink-muted">{t('detail.timelineEmpty')}</p>
          )}
        </Panel>
      </PageBody>
    </Page>
  )
}

const REGISTRY_SOURCES = ['RD', 'DBD', 'MANUAL', 'STUB'] as const

/** Where the registry check's answer came from, in words (S7-18: the screen showed the code MANUAL) */
function registrySourceLabel(source: string | null, t: (key: `detail.registrySources.${(typeof REGISTRY_SOURCES)[number]}`) => string): string {
  const known = REGISTRY_SOURCES.find((s) => s === source)
  return known ? t(`detail.registrySources.${known}`) : '-'
}
