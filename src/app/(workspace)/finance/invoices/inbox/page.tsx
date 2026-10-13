import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { canIgnoreEmail, getInvoiceInboxView, type InboxEmailDto } from '@/server/services/ap/view-list'
import { InboxTable, PollButton, type InboxPoOption, type InboxRowView } from '@/ui/ap/list/inbox'
import { Notice } from '@/ui/form/notice'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { getSession } from '../../../../_lib/session'
import { localeOf, when, type Locale } from '../../../_tracking/present'
import { createFromInboxAction, ignoreEmailAction, pollInboxAction } from '../ap-list-actions'

export async function generateMetadata() {
  const t = await getTranslations('apList.inbox')
  return { title: t('metaTitle') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
const SKIP_REASONS = ['TYPE_NOT_ALLOWED', 'TOO_LARGE', 'EMPTY', 'OVER_LIMIT'] as const

// /finance/invoices/inbox (S8-13, FR-AP-101 AC2, BR-AP-02, ADR-123): the messages the invoice inbox kept, the newest
// first, with the drafts made from them, the files waiting for their PO, the files not taken and why; "ดึงอีเมลตอนนี้"
// and skipping a message with a reason. FINANCE's page: the view checks invoice.inbox.manage and module PAY before
// anything is read; making a draft from a file needs invoice.record too. The commands check again.
export default async function InvoiceInboxPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('apList'), getLocale().then(localeOf)])
  const result = await getInvoiceInboxView(ctx)
  if (!result.ok) {
    return (
      <Page>
        <PageHeader title={t('forbiddenTitle')} />
        <div className="flex max-w-2xl flex-col gap-4">
          <Notice tone="warning">{result.error.code === 'MODULE_DISABLED' ? t('errors.MODULE_DISABLED') : t('inbox.forbiddenHint')}</Notice>
          <Link href="/" className={linkClass}>
            {t('home')}
          </Link>
        </div>
      </Page>
    )
  }
  const inbox = result.data
  const pos: InboxPoOption[] = inbox.pos.map((po) => ({
    value: po.id,
    number: po.number,
    supplierId: po.supplier.id,
    label: t('new.poOption', { number: po.number ?? '-', supplier: `${locale === 'en' && po.supplier.nameEn ? po.supplier.nameEn : po.supplier.nameTh} (${po.supplier.code})` }),
  }))
  const rows = inbox.emails.map((email) => rowView(t, locale, email))

  return (
    <Page>
      <PageHeader title={t('inbox.title')} intro={t('inbox.intro')} actions={<PollButton poll={pollInboxAction} />}>
        <p className="text-ink">{inbox.address ? t('inbox.address', { address: inbox.address }) : t('inbox.noAddress')}</p>
        <Link href="/finance/invoices" className={linkClass}>
          {t('toList')}
        </Link>
      </PageHeader>
      <PageBody>
        <Panel title={t('inbox.table')} id="ap-inbox">
          {rows.length ? (
            <>
              <InboxTable rows={rows} pos={pos} canRecord={inbox.canRecord} ignore={ignoreEmailAction} createFromInbox={createFromInboxAction} />
              {inbox.limited ? <p className="text-ink-muted">{t('inbox.limited', { shown: rows.length })}</p> : null}
            </>
          ) : (
            <ListEmpty
              title={t('inbox.empty')}
              hint={t('inbox.emptyHint')}
              actions={
                <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                  <Link href="/finance/invoices/new">{t('actions.new')}</Link>
                </Button>
              }
            />
          )}
        </Panel>
      </PageBody>
    </Page>
  )
}

type ApListT = Awaited<ReturnType<typeof getTranslations<'apList'>>>

function rowView(t: ApListT, locale: Locale, email: InboxEmailDto): InboxRowView {
  const notes: string[] = []
  if (email.status === 'IGNORED' && email.ignoreReason) notes.push(email.ignoreReason === 'NO_INVOICE_FILE' ? t('inbox.noInvoiceFile') : t('inbox.ignoredBecause', { reason: email.ignoreReason }))
  if (email.status === 'FAILED') notes.push(t('inbox.failedDetail', { code: email.failedCode ?? '-', attempts: email.attempts }))
  return {
    id: email.id,
    received: when(locale, email.receivedAt),
    from: email.fromAddress,
    subject: email.subject,
    poRefs: email.poRefsFound.length ? t('inbox.poRefs', { refs: email.poRefsFound.join(', ') }) : null,
    status: email.status,
    statusLabel: t(`inbox.status.${email.status}`),
    statusNotes: notes,
    drafts: email.invoices.map((inv) => ({
      id: inv.id,
      href: `/finance/invoices/${inv.id}`,
      label: `${t('inbox.draftLink', { label: inv.number ?? inv.supplierInvoiceNo ?? t('inbox.invoiceLabel', { po: inv.poNumber ?? '-' }) })} · ${t(`status.${inv.status}` as 'status.DRAFT')}`,
    })),
    waiting: email.status === 'IGNORED' ? [] : email.files.filter((f) => f.invoice === null).map((f) => ({ fileId: f.fileId, fileName: f.fileName })),
    skipped: email.skipped.map((s) =>
      t('inbox.skipped', { name: s.fileName, reason: t(`inbox.skippedReason.${(SKIP_REASONS as readonly string[]).includes(s.reason) ? (s.reason as (typeof SKIP_REASONS)[number]) : 'OTHER'}`) }),
    ),
    refs: email.poRefsFound,
    senderSupplierId: email.senderSupplierId,
    canIgnore: canIgnoreEmail(email),
  }
}
