import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { formatEnglishBeDateTime, formatThaiDateTime } from '@/core/thai'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { rfxDetail } from '@/server/services/sourcing/rfx-view'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { Page, PageBody, PageHeader } from '@/ui/page/page'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/shadcn/table'
import { PrintButton } from '@/ui/sourcing/print-button'
import { getSession } from '../../../../_lib/session'

export async function generateMetadata() {
  const t = await getTranslations('sourcing.detail')
  return { title: t('print.metaTitle') }
}

// /sourcing/[id]/print (rfx.print · S10-17 · BR-FORM-11 · FR-INT-201 AC2): the RFx as a document to print for its
// suppliers — not a money document (no prices, no PDF of record). An RFx in Thai and English (TH_EN) prints Thai and
// English side by side, its own English as procurement typed it (nothing translated · OQ-211); a Thai-only RFx prints
// Thai. The words of the document are in both languages whatever the reader's screen language. Who may read the RFx
// may print it (rfxReading of sourcing.view); prices are never on it.

const cellClass = 'align-top whitespace-pre-line break-words'

export default async function RfxPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, th, en, tCommon] = await Promise.all([
    getTranslations('sourcing.detail'),
    getTranslations({ locale: 'th', namespace: 'sourcing.detail.print' }),
    getTranslations({ locale: 'en', namespace: 'sourcing.detail.print' }),
    getTranslations('adminSettings'),
  ])
  const read = await rfxDetail(ctx, id)
  if (!read.ok) {
    if (read.error.code === 'NOT_FOUND') notFound()
    return <NoAccess title={t('print.metaTitle')} message={read.error.code === 'MODULE_DISABLED' ? t('errors.MODULE_DISABLED') : tCommon('forbidden')} homeLabel={tCommon('homeLink')} />
  }
  const { rfx: r, lines } = read.data
  const both = r.locale === 'TH_EN'
  const kind = r.kind === 'RFP' ? 'RFP' : r.kind === 'RFI' ? 'RFI' : 'RFQ'
  const number = r.number ?? th('draft')
  // a label in Thai, and in English beside it when the RFx is in both
  const label = (key: Parameters<typeof th>[0]) => (both ? `${th(key)} / ${en(key)}` : th(key))
  const closes = r.closesAt ? new Date(r.closesAt) : null

  return (
    <Page>
      <PageHeader title={`${number} ${r.title}`} intro={both && r.titleEn ? r.titleEn : undefined} />
      <PageBody>
        <div className="flex flex-wrap items-center gap-3 print:hidden">
          <PrintButton label={t('print.button')} />
          <Link href={`/sourcing/${id}`} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline lg:min-h-0">
            {t('print.back')}
          </Link>
        </div>
        <article aria-label={t('print.metaTitle')} className="flex max-w-4xl flex-col gap-6 text-ink">
          <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
            <div className="flex flex-col">
              <dt className="text-ink-muted">{label('kind')}</dt>
              <dd>{both ? `${th(`kindName.${kind}`)} / ${en(`kindName.${kind}`)}` : th(`kindName.${kind}`)}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-ink-muted">{label('number')}</dt>
              <dd className="tabular">{number}</dd>
            </div>
            {closes ? (
              <div className="flex flex-col">
                <dt className="text-ink-muted">{label('closesAt')}</dt>
                <dd className="tabular">{both ? `${formatThaiDateTime(closes)} / ${formatEnglishBeDateTime(closes)}` : formatThaiDateTime(closes)}</dd>
              </div>
            ) : null}
            <div className="flex flex-col">
              <dt className="text-ink-muted">{label('revision')}</dt>
              <dd className="tabular">{r.revisionNo}</dd>
            </div>
          </dl>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-40">{label('field')}</TableHead>
                <TableHead>{th('thai')}</TableHead>
                {both ? <TableHead>{en('english')}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className={cellClass}>{label('title')}</TableCell>
                <TableCell className={cellClass}>{r.title}</TableCell>
                {both ? <TableCell className={cellClass}>{r.titleEn ?? ''}</TableCell> : null}
              </TableRow>
              <TableRow>
                <TableCell className={cellClass}>{label('description')}</TableCell>
                <TableCell className={cellClass}>{r.description}</TableCell>
                {both ? <TableCell className={cellClass}>{r.descriptionEn ?? ''}</TableCell> : null}
              </TableRow>
            </TableBody>
          </Table>

          {lines.length ? (
            <section aria-labelledby="print-lines" className="flex flex-col gap-2">
              <h2 id="print-lines" className="text-lg font-semibold">
                {label('lines')}
              </h2>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">{label('lineNo')}</TableHead>
                    <TableHead>{th('item')}</TableHead>
                    {both ? <TableHead>{en('item')}</TableHead> : null}
                    <TableHead className="text-right">{label('quantity')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className={`${cellClass} tabular`}>{l.lineNo}</TableCell>
                      <TableCell className={cellClass}>{l.description}</TableCell>
                      {both ? <TableCell className={cellClass}>{l.descriptionEn ?? ''}</TableCell> : null}
                      <TableCell className={`${cellClass} tabular text-right`}>{both ? `${l.quantity} ${l.uom} / ${l.quantity} ${l.uomEn ?? l.uom}` : `${l.quantity} ${l.uom}`}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          ) : null}

          {/* NG-9: baht only, in both languages */}
          {r.kind === 'RFI' ? null : <p>{both ? `${th('baht')} / ${en('baht')}` : th('baht')}</p>}
        </article>
      </PageBody>
    </Page>
  )
}
