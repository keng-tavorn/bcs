import { getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listSupplierDocumentTypes } from '@/server/services/suppliers/documents'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Badge } from '@/ui/shadcn/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/shadcn/table'
import { CloseTypeButton, DocumentTypeForm } from '@/ui/supplier-docs/types-form'
import { getSession } from '../../../_lib/session'
import { closeDocumentTypeAction, saveDocumentTypeAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('supplierDocs.types')
  return { title: t('title') }
}

// /admin/supplier-document-types (S7-06 · BR-SDOC ข้อ 01 · §9.1 /admin/*): the organization's supplier document types —
// what each is for, how long it lasts, when it is reminded of, whether it is required or sensitive — and the form that
// adds or changes one. ORG_ADMIN only (admin.supplierDocumentTypes); a type is closed, never deleted.
export default async function SupplierDocumentTypesPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, tCommon] = await Promise.all([getTranslations('supplierDocs'), getTranslations('adminSettings')])
  if (!ctx) return null
  const view = await listSupplierDocumentTypes(ctx)
  if (!view.ok) return <NoAccess title={t('types.title')} message={tCommon('forbidden')} homeLabel={tCommon('homeLink')} />
  return (
    <Page>
      <PageHeader title={t('types.title')} intro={t('types.intro')} />
      <PageBody>
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-6">
          <Panel title={t('types.listTitle')} id="types">
            {view.data.length === 0 ? (
              <p className="text-ink-muted">{t('types.empty')}</p>
            ) : (
              <div className="-mx-4 overflow-x-auto sm:mx-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('types.columns.type')}</TableHead>
                      <TableHead>{t('types.columns.appliesTo')}</TableHead>
                      <TableHead>{t('types.columns.rule')}</TableHead>
                      <TableHead>{t('types.columns.flags')}</TableHead>
                      <TableHead>{t('types.columns.action')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {view.data.map((type) => (
                      <TableRow key={type.code}>
                        <TableCell>
                          <div className="font-medium">{type.nameTh}</div>
                          <div className="text-base text-ink-muted md:text-sm">{type.code}</div>
                        </TableCell>
                        <TableCell>{type.appliesTo.map((p) => t(`types.payee.${p}`)).join(', ')}</TableCell>
                        <TableCell className="tabular">
                          {type.validityDays ? t('types.days', { count: type.validityDays }) : t('types.noExpiry')} / {t('types.days', { count: type.reminderDaysBefore })}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {type.required ? <Badge variant="secondary">{t('types.flagRequired')}</Badge> : null}
                            {type.sensitive ? <Badge variant="secondary">{t('types.flagSensitive')}</Badge> : null}
                            {!type.singleInstance ? <Badge variant="secondary">{t('types.flagMany')}</Badge> : null}
                          </div>
                        </TableCell>
                        <TableCell>{type.active ? <CloseTypeButton code={type.code} close={closeDocumentTypeAction} /> : <span className="text-ink-muted">{t('types.closed')}</span>}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
          <Panel title={t('types.formTitle')} id="form">
            <DocumentTypeForm save={saveDocumentTypeAction} />
          </Panel>
        </div>
      </PageBody>
    </Page>
  )
}
