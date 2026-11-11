import type { getTranslations } from 'next-intl/server'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai'

// The rows of a supplier application's approval task in the reader's language (S7-09 · FR-SUP-104 AC5): the LIFF summary
// (./supplier-application.tsx) and the web task page (src/ui/tasks/subjects/supplier-application.tsx) show the same.
// Pure, so it is tested without a page.

/** The view the pages read (getSupplierApplicationTaskView of src/server/services/suppliers/application-view.ts) */
export interface SupplierApplicationTaskView {
  readonly number: string | null
  readonly kind: 'NEW' | 'EXISTING'
  readonly payeeType: 'JURISTIC' | 'INDIVIDUAL' | 'FOREIGN'
  readonly nameTh: string
  readonly nameEn: string | null
  readonly category: string | null
  readonly taxId: string | null
  readonly taxIdMasked: boolean
  readonly branchCode: string
  readonly isVatRegistered: boolean
  readonly registry: { readonly source: 'RD' | 'DBD' | 'MANUAL' | 'STUB' | null; readonly juristicStatus: string | null; readonly vatCancelled: boolean }
  readonly duplicates: ReadonlyArray<{ readonly code: string; readonly matches: readonly string[]; readonly reason: string | null }>
  readonly documents: ReadonlyArray<{
    readonly id: string
    readonly typeCode: string
    readonly typeName: { readonly th: string; readonly en: string | null }
    readonly status: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED' | 'SUPERSEDED'
    readonly expiresOn: string
    readonly verifiedBy: { readonly th: string; readonly en: string | null } | null
  }>
  readonly invitedBy: { readonly th: string; readonly en: string | null } | null
  readonly filledOnBehalfBy: { readonly th: string; readonly en: string | null } | null
  readonly routedBy: { readonly th: string; readonly en: string | null } | null
}

export type SupplierApplicationTaskT = Awaited<ReturnType<typeof getTranslations<'supplierApplicationTask'>>>

export interface SupplierApplicationRow {
  readonly label: string
  readonly value: string
}

export interface SupplierApplicationLine {
  readonly title: string
  readonly detail: readonly string[]
  /** Said in --warn as well as in words */
  readonly warn: boolean
}

export interface SupplierApplicationRows {
  readonly facts: readonly SupplierApplicationRow[]
  readonly registry: readonly SupplierApplicationLine[]
  readonly duplicates: readonly SupplierApplicationLine[]
  readonly documents: readonly SupplierApplicationLine[]
  readonly people: readonly SupplierApplicationRow[]
}

const DUPLICATE_CODES = ['SAME_TAXID_OTHER_BRANCH', 'DUPLICATE_NAME', 'DUPLICATE_EMAIL'] as const
const isDuplicateCode = (code: string): code is (typeof DUPLICATE_CODES)[number] => (DUPLICATE_CODES as readonly string[]).includes(code)

/** The rows of the application in the reader's language: the LIFF summary and the web task page show the same */
export function supplierApplicationRows(t: SupplierApplicationTaskT, locale: string, view: SupplierApplicationTaskView): SupplierApplicationRows {
  const en = locale === 'en'
  const name = (n: { readonly th: string; readonly en: string | null } | null) => (n ? (en && n.en ? n.en : n.th) : t('nobody'))
  // "YYYY-MM-DD" as the reader's language writes a day: "29 มี.ค. 2570" · "29 Mar 2570" (BR-DATE-01)
  const date = (d: string) => (en ? formatEnglishBeDate : formatThaiDate)(`${d}T00:00:00+07:00`)
  const facts: SupplierApplicationRow[] = [
    { label: t('number'), value: view.number ?? '-' },
    { label: t('supplier'), value: en && view.nameEn ? view.nameEn : view.nameTh },
    { label: t('payeeType'), value: t(`payeeTypeValue.${view.payeeType}`) },
    { label: t('kind'), value: t(`kindValue.${view.kind}`) },
    { label: t('category'), value: view.category ?? t('noCategory') },
    { label: t('taxId'), value: view.taxId === null ? t('noTaxId') : view.taxIdMasked ? t('taxIdMasked', { taxId: view.taxId }) : view.taxId },
    ...(view.payeeType === 'FOREIGN' ? [] : [{ label: t('branch'), value: view.branchCode === '00000' ? t('branchHead', { code: view.branchCode }) : t('branchValue', { code: view.branchCode }) }]),
    ...(view.payeeType === 'FOREIGN' ? [] : [{ label: t('vat'), value: view.isVatRegistered ? t('vatYes') : t('vatNo') }]),
  ]
  const registry: SupplierApplicationLine[] = [
    {
      title: t(`registrySource.${view.registry.source ?? 'NONE'}`),
      detail: view.registry.juristicStatus ? [t('juristicStatus', { status: view.registry.juristicStatus })] : [],
      warn: view.registry.source === 'MANUAL' || view.registry.source === null,
    },
    ...(view.registry.vatCancelled ? [{ title: t('vatCancelled'), detail: [], warn: true }] : []),
  ]
  const duplicates: SupplierApplicationLine[] = view.duplicates.map((d) => ({
    title: isDuplicateCode(d.code) ? t(`duplicateCode.${d.code}`) : d.code,
    detail: [...(d.matches.length ? [t('duplicateMatches', { refs: d.matches.join(', ') })] : []), d.reason ? t('duplicateReason', { reason: d.reason }) : t('noReason')],
    warn: true,
  }))
  const documents: SupplierApplicationLine[] = view.documents.map((d) => ({
    title: en && d.typeName.en ? d.typeName.en : d.typeName.th,
    detail: [t('documentLine', { status: t(`documentStatus.${d.status}`), date: date(d.expiresOn) }), ...(d.verifiedBy ? [t('verifiedBy', { name: name(d.verifiedBy) })] : [])],
    warn: d.status !== 'VERIFIED',
  }))
  const people: SupplierApplicationRow[] = [
    { label: t('invitedBy'), value: name(view.invitedBy) },
    ...(view.filledOnBehalfBy ? [{ label: t('filledBy'), value: name(view.filledOnBehalfBy) }] : []),
    { label: t('routedBy'), value: name(view.routedBy) },
  ]
  return { facts, registry, duplicates, documents, people }
}
