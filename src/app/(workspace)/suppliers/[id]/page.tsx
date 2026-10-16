import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { BYTES_PER_KIB } from '@/lib/constants'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getSupplierBankCard } from '@/server/services/bank-accounts/view'
import { getSupplierForScreen, type SupplierDetailDto } from '@/server/services/suppliers/view'
import { SupplierBankCard } from '@/ui/bank-accounts/supplier-bank-card'
import { formatDateTime } from '@/ui/format'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Facts, type Fact } from '@/ui/request-view/facts'
import { formatTaxId, HEAD_OFFICE } from '@/ui/suppliers/model'
import { SupplierManage } from '@/ui/suppliers/manage'
import { ProofList } from '@/ui/suppliers/proof-list'
import { Flag, SupplierStatusLabel } from '@/ui/suppliers/status'
import { getSession } from '../../../_lib/session'
import { revealAccountAction } from '../../finance/bank-accounts/actions'
import { supplierProofUrlAction, updateSupplierAction } from '../actions'

export async function generateMetadata() {
  const t = await getTranslations('suppliers.list')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

type T = Awaited<ReturnType<typeof getTranslations<'suppliers'>>>
type Full = NonNullable<SupplierDetailDto['full']>

/** The supplier's own facts; the ones PROCUREMENT edits below are left to the forms there */
function factsOf(t: T, v: SupplierDetailDto, locale: 'th' | 'en'): Fact[] {
  const s = v.supplier
  const f = v.full
  const editing = v.canManage
  const notSet = <span className="text-ink-muted">{t('detail.notSet')}</span>
  const kind = s.isForeign ? t('detail.kindForeign') : f ? (f.individual ? t('detail.kindIndividual') : t('detail.kindJuristic')) : null
  const items: Fact[] = []
  if (kind) items.push({ label: t('detail.kind'), value: kind })
  if (f && !s.isForeign) {
    items.push({
      label: t('detail.taxId'),
      value: (
        <span className="flex flex-col">
          <span className="tabular">{f.taxId ? formatTaxId(f.taxId) : t('detail.notSet')}</span>
          {f.taxIdMasked ? <span className="text-base text-ink-muted md:text-sm">{t('detail.taxIdMaskedNote')}</span> : null}
        </span>
      ),
    })
  }
  items.push({ label: t('detail.branch'), value: s.branchCode === HEAD_OFFICE ? t('branch.head') : t('branch.number', { code: s.branchCode }) })
  if (!editing) {
    // The other language's name: the heading shows the reader's own
    const other = locale === 'en' ? (s.nameEn ? s.nameTh : null) : s.nameEn
    if (other) items.push({ label: locale === 'en' ? t('detail.nameTh') : t('detail.nameEn'), value: other })
    items.push({ label: t('detail.vat'), value: s.isVatRegistered ? t('vat.yes') : t('vat.no') })
    items.push({ label: t('detail.category'), value: s.category ?? notSet })
    if (f) {
      items.push({ label: t('detail.address'), value: f.address ? <span className="whitespace-pre-line">{f.address}</span> : notSet })
      items.push({ label: t('detail.email'), value: f.email ? <span className="break-all">{f.email}</span> : notSet })
      items.push({ label: t('detail.phone'), value: f.phone ?? notSet })
      items.push({
        label: t('detail.express'),
        value: f.expressVendorCode ? f.expressVendorCode : <Flag kind="warn">{t('detail.expressMissingOther')}</Flag>,
      })
    }
  }
  return items
}

/** How the identity was checked and what the registries said (BR-SUP-01 to BR-SUP-03) */
function registryFacts(t: T, f: Full, s: SupplierDetailDto['supplier'], locale: 'th' | 'en'): Fact[] {
  const r = f.registry
  const rec = r.recorded
  const method = s.isForeign ? t('check.FOREIGN') : t(`check.${r.source ?? 'NONE'}`)
  const items: Fact[] = [{ label: t('detail.method'), value: <Flag kind={r.source || s.isForeign ? 'checked' : 'warn'}>{method}</Flag> }]
  if (r.checkedAt) items.push({ label: t('detail.checkedAt'), value: formatDateTime(locale, r.checkedAt) })
  if (!s.isForeign) items.push({ label: t('detail.juristicStatus'), value: r.juristicStatus ?? (f.individual ? t('detail.juristicIndividual') : t('detail.noData')) })
  if (rec) {
    items.push({ label: t('detail.registryVat'), value: rec.vatRegistered === null ? t('detail.noData') : rec.vatRegistered ? t('vat.yes') : t('vat.no') })
    if (rec.nameTh && rec.nameTh !== s.nameTh) items.push({ label: t('detail.registryName'), value: rec.nameTh })
    if (rec.address && rec.address !== f.address) items.push({ label: t('detail.registryAddress'), value: rec.address })
    items.push({ label: t('detail.answers'), value: `${t('detail.answerRd', { status: t(`detail.answer.${rec.rd}`) })} · ${t('detail.answerDbd', { status: t(`detail.answer.${rec.dbd}`) })}` })
  }
  return items
}

// One supplier (spec §9.1 /suppliers/[id], S4-02, FR-SUP-001): every member sees its name and basic details; PROCUREMENT,
// FINANCE and AUDITOR also its tax id (masked for an individual when read only as AUDITOR, BR-AUTH-04), contacts,
// Express vendor code and how its identity was checked, with the proof when a person confirmed it. PROCUREMENT edits it
// and deactivates it here (supplier.manage, checked again by the service). The page's frame (S16-10): the name, code and
// status on the page's white, then one white card per part — the details, the identity check, and each of the editing forms.
export default async function SupplierPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params
  const created = one((await searchParams).created) === '1'
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('suppliers'), getLocale().then((l) => (l === 'en' ? 'en' : 'th') as 'th' | 'en')])
  // S9-09: the card of the account the supplier is paid into (null without module PAY or bankAccount.view)
  const [result, bankCard] = await Promise.all([getSupplierForScreen(ctx, id), getSupplierBankCard(ctx, { supplierId: id })])
  if (!result.ok && result.error.code === 'NOT_FOUND') notFound()
  if (!result.ok) {
    return (
      <Page>
        <PageHeader title={t('list.forbiddenTitle')} />
        <Notice tone="warning">{t('list.forbidden')}</Notice>
        <Link href="/" className={linkClass}>
          {t('list.home')}
        </Link>
      </Page>
    )
  }
  const v = result.data
  const s = v.supplier
  const f = v.full
  const name = (locale === 'en' ? s.nameEn : null) ?? s.nameTh
  const kb = (bytes: number) => new Intl.NumberFormat(locale).format(Math.max(1, Math.ceil(bytes / BYTES_PER_KIB)))
  const stub = f?.registry.source === 'STUB' || f?.registry.recorded?.mode === 'stub'

  return (
    <Page>
      <div className="flex flex-col gap-3">
        <Link href="/suppliers" className={linkClass}>
          {t('detail.back')}
        </Link>
        <PageHeader title={name} intro={t('row.code', { code: s.code })}>
          <SupplierStatusLabel status={s.status} label={t(`status.${s.status}`)} className="self-start" />
        </PageHeader>
      </div>
      {created ? <Notice tone="success">{t('detail.created')}</Notice> : null}

      <PageBody>
        <Panel id="supplier-info" title={t('detail.infoTitle')}>
          <Facts items={factsOf(t, v, locale)} />
          {!f ? <p className="text-base text-ink-muted md:text-sm">{t('detail.basicNote')}</p> : null}
        </Panel>

        {f ? (
          <Panel id="supplier-registry" title={t('detail.registryTitle')}>
            <Facts items={registryFacts(t, f, s, locale)} />
            {stub ? <p className="text-base text-ink-muted md:text-sm">{t('detail.stubNote')}</p> : null}
            {f.proofs.length ? (
              <div className="flex flex-col gap-2">
                <h3 className="font-medium text-ink">{t('detail.proofs')}</h3>
                <ProofList proofs={f.proofs.map((p) => ({ fileId: p.fileId, fileName: p.fileName, detail: t('detail.size', { size: kb(p.sizeBytes) }) }))} open={supplierProofUrlAction} />
              </div>
            ) : f.taxIdMasked && f.registry.source === 'MANUAL' ? (
              <p className="text-ink-muted">{t('detail.proofHidden')}</p>
            ) : null}
          </Panel>
        ) : null}

        {bankCard.ok && bankCard.data ? <SupplierBankCard supplierId={s.id} card={bankCard.data} reveal={revealAccountAction} /> : null}

        {v.canManage && f ? (
          <>
            {!f.expressVendorCode ? (
              <Notice tone="warning">
                <p>{t('detail.expressMissingManage')}</p>
              </Notice>
            ) : null}
            <SupplierManage
              supplier={{
                id: s.id,
                nameTh: s.nameTh,
                nameEn: s.nameEn,
                address: f.address,
                isVatRegistered: s.isVatRegistered,
                category: s.category,
                expressVendorCode: f.expressVendorCode,
                email: f.email,
                phone: f.phone,
                status: s.status,
                version: s.version,
              }}
              actions={{ update: updateSupplierAction }}
            />
          </>
        ) : null}
      </PageBody>
    </Page>
  )
}
