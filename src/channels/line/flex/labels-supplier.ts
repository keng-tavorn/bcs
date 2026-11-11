import type { CardLocale } from './types'

// The words of a supplier application's approval card (S7-09 · FR-SUP-104 AC5 · BR-NOTI ข้อ 10): the legal name of a
// juristic or foreign supplier, a sole proprietor as "ผู้ขายบุคคลธรรมดา · <เลขใบสมัคร>" — never the person's name, tax id
// or account — its category, the inviter (the requester of BR-NOTI-01), how many documents and duplicate warnings.

export interface SupplierApplicationCard {
  /** payeeType INDIVIDUAL: the name is never shown, whatever `name` holds */
  readonly individual: boolean
  /** The legal name; null for a sole proprietor */
  readonly name: string | null
  readonly number: string | null
  readonly category: string | null
  readonly documents: number
  readonly duplicates: number
}

type Text = { readonly th: string; readonly en: string }

const WORDS = {
  supplier: { th: 'ผู้ขาย', en: 'Supplier' },
  category: { th: 'หมวด', en: 'Category' },
  invitedBy: { th: 'ผู้เชิญ', en: 'Invited by' },
  documents: { th: 'เอกสาร', en: 'Documents' },
  duplicates: { th: 'เตือนซ้ำ', en: 'Duplicates' },
  none: { th: 'ไม่มี', en: 'None' },
  noCategory: { th: 'ไม่ระบุ', en: 'Not given' },
  individual: { th: 'ผู้ขายบุคคลธรรมดา', en: 'Individual supplier' },
} as const satisfies Record<string, Text>

export type SupplierCardLabel = keyof typeof WORDS

export const supplierCardLabel = (key: SupplierCardLabel, locale: CardLocale): string => WORDS[key][locale]

/** BR-NOTI ข้อ 10: the legal name, or "ผู้ขายบุคคลธรรมดา · SUP-2569-00001" for a sole proprietor */
export function supplierCardName(app: Pick<SupplierApplicationCard, 'individual' | 'name' | 'number'>, locale: CardLocale): string {
  if (!app.individual && app.name) return app.name
  return app.number ? `${WORDS.individual[locale]} · ${app.number}` : WORDS.individual[locale]
}

/** "3 ฉบับ" / "3 documents" */
export const documentCountText = (n: number, locale: CardLocale): string => (locale === 'th' ? `${n} ฉบับ` : n === 1 ? '1 document' : `${n} documents`)

/** "2 รายการ" / "2 warnings", or "ไม่มี" / "None" */
export const duplicateCountText = (n: number, locale: CardLocale): string => (n === 0 ? WORDS.none[locale] : locale === 'th' ? `${n} รายการ` : n === 1 ? '1 warning' : `${n} warnings`)
