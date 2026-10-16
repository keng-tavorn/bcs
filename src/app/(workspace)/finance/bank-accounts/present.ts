import type { getTranslations } from 'next-intl/server'
import type { BankChoiceDto, BankPersonDto, BankTargetDto } from '@/server/services/bank-accounts/view'
import type { Locale } from '../../_tracking/present'

// The words of the bank-account screens (S9-09) built from the views: whose account, a member's name, the file template,
// a bank and an account as a choice. Every number here is the masked one the view gives (BR-AUTH-04).

export type BankT = Awaited<ReturnType<typeof getTranslations<'bankAccount'>>>

/** The template of the demo (ADR-129) says it is not a bank's format (FR-PAY-102 AC1); another is named by its code */
export const NEUTRAL_TEMPLATE = 'BCS-NEUTRAL-1'

export function templateText(t: BankT, code: string | null): string {
  if (!code) return t('payers.noTemplate')
  return code === NEUTRAL_TEMPLATE ? t('payers.neutralTemplate', { code }) : code
}

export const personName = (locale: Locale, person: BankPersonDto | null | undefined): string => (person ? (locale === 'en' && person.nameEn ? person.nameEn : person.nameTh) : '-')

const supplierName = (locale: Locale, s: { nameTh: string; nameEn: string | null }) => (locale === 'en' && s.nameEn ? s.nameEn : s.nameTh)

/** "SP0056 · ชื่อผู้ขาย", or the organization's own account */
export function changeOwnerText(t: BankT, locale: Locale, change: { ownerKind: 'SUPPLIER' | 'ORGANIZATION'; supplier: { code: string; nameTh: string; nameEn?: string | null } | null }): string {
  if (change.ownerKind === 'ORGANIZATION' || !change.supplier) return t('owner.company')
  return t('owner.supplier', { code: change.supplier.code, name: supplierName(locale, { nameTh: change.supplier.nameTh, nameEn: change.supplier.nameEn ?? null }) })
}

/** "ธนาคารกสิกรไทย (KBANK)" */
export const bankChoiceText = (b: BankChoiceDto): string => `${b.nameTh} (${b.shortName})`

/** "CB-01 · ธนาคารกสิกรไทย ••••••0016 · ชื่อบัญชี" */
export function accountText(a: Pick<BankTargetDto, 'code' | 'bankName' | 'bankCode' | 'accountNoMasked' | 'accountName'>): string {
  return [a.code, `${a.bankName ?? a.bankCode} ${a.accountNoMasked}`, a.accountName].filter(Boolean).join(' · ')
}
