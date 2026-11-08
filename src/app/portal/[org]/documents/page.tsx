import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { listPortalDocumentTypes } from '@/server/portal/queries'
import { listSupplierDocuments } from '@/server/services/suppliers/documents'
import { PortalButton, PortalFrame, PortalNotice, portalInputClass } from '@/ui/portal/frame'
import { one, pageOrg, pageSession, Unavailable, type SearchParams } from '../_lib/page'

// /portal/[org]/documents (S7-06 · BR-SDOC ข้อ 02 ข้อ 07 · FR-SUP-102 AC4): the contact's own documents with their state,
// and the form that sends a new one (type, file, dates, scope). S7-08 builds the rest of the portal around it.

const STATUSES = ['PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED', 'SUPERSEDED'] as const
const ERRORS = ['FORBIDDEN', 'VALIDATION_FAILED', 'RATE_LIMITED', 'PRIVACY_NOTICE_OUTDATED'] as const

export default async function PortalDocumentsPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const org = await pageOrg((await params).org)
  if (!org) return <Unavailable />
  const session = await pageSession(org)
  if (!session) redirect(`/portal/${org.code}/login`)
  const { contact, ctx } = session.state
  const [t, locale, q, docs, types] = await Promise.all([
    getTranslations('supplierDocs'),
    getLocale(),
    searchParams,
    listSupplierDocuments(ctx, { supplierId: contact.supplierId, applicationId: contact.supplierId ? null : contact.applicationId }),
    listPortalDocumentTypes(ctx),
  ])
  const error = one(q.error)
  const known = error && (ERRORS as readonly string[]).includes(error) ? (error as (typeof ERRORS)[number]) : null
  return (
    <PortalFrame organization={org.nameTh} title={t('documents.title')}>
      {one(q.sent) ? <PortalNotice tone="success">{t('documents.uploaded')}</PortalNotice> : null}
      {error ? <PortalNotice tone="danger">{known ? t(`errors.${known}`) : t('errors.FAILED')}</PortalNotice> : null}
      {docs.ok && docs.data.rows.length ? (
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {docs.data.rows.map((d) => (
            <li key={d.id} className="flex flex-col gap-1 py-3">
              <span className="font-medium">{locale === 'en' ? d.typeNameEn : d.typeNameTh}</span>
              {d.scope ? <span className="text-ink-muted">{d.scope}</span> : null}
              <span className="tabular text-ink-muted">
                {d.issuedOn} – {d.expiresOn}
              </span>
              <span>{(STATUSES as readonly string[]).includes(d.status) ? t(`documents.status.${d.status}`) : d.status}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-muted">{t('documents.empty')}</p>
      )}
      <section aria-labelledby="upload" className="flex flex-col gap-3 border-t border-line pt-5">
        <h2 id="upload" className="text-lg font-semibold">
          {t('documents.uploadTitle')}
        </h2>
        <p className="text-ink-muted">{t('documents.idCardHint')}</p>
        <form method="post" action={`/portal/${org.code}/api/documents`} encType="multipart/form-data" className="flex flex-col gap-3">
          <input type="hidden" name="csrf" value={session.csrf} />
          <input type="hidden" name="key" value={randomUUID()} />
          <label htmlFor="documentTypeCode" className="font-medium">
            {t('documents.documentType')}
          </label>
          <select id="documentTypeCode" name="documentTypeCode" required className={portalInputClass}>
            {types.map((type) => (
              <option key={type.code} value={type.code}>
                {locale === 'en' ? type.nameEn : type.nameTh}
              </option>
            ))}
          </select>
          <label htmlFor="file" className="font-medium">
            {t('documents.file')}
          </label>
          <input id="file" name="file" type="file" required accept="application/pdf,image/jpeg,image/png,image/webp" className="text-base" />
          <label htmlFor="issuedOn" className="font-medium">
            {t('documents.issuedOn')}
          </label>
          <input id="issuedOn" name="issuedOn" type="date" required className={portalInputClass} />
          <label htmlFor="expiresOn" className="font-medium">
            {t('documents.expiresOn')}
          </label>
          <input id="expiresOn" name="expiresOn" type="date" className={portalInputClass} />
          <label htmlFor="scope" className="font-medium">
            {t('documents.scope')}
          </label>
          <input id="scope" name="scope" className={portalInputClass} />
          <PortalButton type="submit">{t('documents.upload')}</PortalButton>
        </form>
      </section>
      <a href={`/portal/${org.code}`} className="text-primary underline underline-offset-4">
        {t('documents.back')}
      </a>
    </PortalFrame>
  )
}
