import type { HelpFix } from '@/lib/exception-help'
import type { BadgeLook } from '../../document/badge-looks'

// What the page of one tier-2 invoice receives (S8-13): the read model of src/server/services/ap/view-invoice.ts as the
// screen uses it (the service's DTO fits it as it is), so the components here never reach the server. Money is BigInt
// satang on the server side of the page and formatted text in every client part.

export type InvoiceFieldSource = 'AI_READING' | 'ETAX_XML'

export interface ApInvoicePageData {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly version: number
  readonly supplierInvoiceNo: string | null
  readonly invoiceDate: string | null
  readonly priceIncludesVat: boolean
  readonly isFinal: boolean
  readonly discountSatang: bigint
  readonly netSatang: bigint
  readonly statedVatSatang: bigint
  readonly grossSatang: bigint
  readonly retentionSatang: bigint
  readonly payableSatang: bigint
  readonly expectedWhtSatang: bigint
  readonly dueDate: string | null
  readonly rejectReason: string | null
  readonly cancelReason: string | null
  readonly fieldSources: Readonly<Record<string, InvoiceFieldSource>>
  readonly po: { readonly id: string; readonly number: string | null }
  /** What the PO has left, amounts before VAT, with how much of the bar each part fills (basis points) */
  readonly poBalance: { readonly poNetSatang: bigint; readonly otherInvoicedSatang: bigint; readonly thisNetSatang: bigint; readonly thisCounts: boolean; readonly thisTakenSatang: bigint; readonly remainingSatang: bigint; readonly otherBp: number; readonly thisBp: number; readonly shortClosed: boolean }
  readonly supplier: { readonly id: string; readonly code: string; readonly nameTh: string; readonly nameEn: string | null }
  readonly file: { readonly id: string; readonly fileName: string; readonly inline: boolean } | null
  readonly channel: string
  readonly prefill: string
  readonly source: {
    readonly createdAt: Date
    readonly createdBy: { readonly th: string; readonly en: string | null } | null
    readonly email: { readonly from: string; readonly subject: string; readonly receivedAt: Date } | null
  }
  readonly lastMatchAt: Date | null
  readonly paymentFlags: readonly string[]
  readonly duplicateNumber: boolean
  readonly lines: ReadonlyArray<{
    readonly id: string
    readonly lineNo: number
    readonly poLineId: string
    readonly poLineNo: number
    readonly description: string
    readonly quantity: string
    readonly uom: string
    readonly unitPriceSatang: bigint
    readonly poUnitPriceSatang: bigint
    readonly netSatang: bigint
    readonly expectedNetSatang: bigint
    readonly overSatang: bigint
    readonly matchStatus: string
    readonly flags: readonly string[]
    readonly accountCode: string | null
    readonly costCenterId: string | null
    readonly costCenterReason: string | null
    readonly codingSource: string
    readonly codingConfirmed: boolean
    readonly whtIncomeTypeCode: string | null
    readonly budgetCostCenterId: string
    readonly suggestion: { readonly accountCode: string | null; readonly source: string; readonly count: number } | null
    readonly poLine: { readonly ordered: string; readonly received: string; readonly cancelled: string; readonly invoicedElsewhere: string }
  }>
  readonly exceptions: ReadonlyArray<{ readonly id: string; readonly type: string; readonly amountSatang: bigint; readonly lineNo: number | null; readonly assigneeRole: string; readonly status: string }>
  readonly options: {
    readonly accountCodes: ReadonlyArray<{ readonly code: string; readonly nameTh: string }>
    readonly costCenters: ReadonlyArray<{ readonly id: string; readonly code: string; readonly nameTh: string }>
    readonly incomeTypes: ReadonlyArray<{ readonly code: string; readonly nameTh: string; readonly nameEn: string | null; readonly rateBp: number; readonly confirmed: boolean }>
  }
  readonly events: ReadonlyArray<{ readonly id: string; readonly type: string; readonly occurredAt: Date; readonly actor: { readonly th: string; readonly en: string | null } | null; readonly system: boolean; readonly reason: string | null }>
  /** S13-20: AI readings of this draft still waiting for FINANCE (src/ui/ap/invoice/invoice-ai.tsx), and the draft's values by path */
  readonly aiReviews?: ReadonlyArray<{ readonly agentActionId: string; readonly fileId: string | null; readonly proposed: Readonly<Record<string, string>>; readonly requiredPaths: readonly string[]; readonly confirmedPaths: readonly string[] }>
  readonly aiCurrent?: Readonly<Record<string, string>>
  readonly may: {
    readonly edit: boolean
    readonly submit: boolean
    readonly cancel: boolean
    readonly recheck: boolean
    readonly variance: boolean
    readonly dismiss: boolean
    readonly reopen: boolean
    readonly reject: boolean
  }
}

/** One row of PROCUREMENT's list (/procurement/invoice-exceptions) */
export interface VarianceRowData {
  readonly invoiceId: string
  readonly number: string | null
  readonly supplierInvoiceNo: string | null
  readonly version: number
  readonly po: { readonly id: string; readonly number: string | null }
  readonly supplier: { readonly code: string; readonly nameTh: string; readonly nameEn: string | null }
  readonly overSatang: bigint
  readonly types: readonly string[]
  readonly canRequest: boolean
}

/** A tier-2 invoice's status as a badge (§9.10: a light colour, an icon and a word) */
export const INVOICE_BADGES: Readonly<Record<string, BadgeLook>> = {
  DRAFT: { tone: 'neutral', icon: 'FilePen' },
  EXCEPTION: { tone: 'danger', icon: 'CircleX' },
  PENDING_APPROVAL: { tone: 'warn', icon: 'Clock' },
  READY_FOR_PAYMENT: { tone: 'ok', icon: 'CircleCheck' },
  IN_PAYMENT_RUN: { tone: 'info', icon: 'Wallet' },
  PAID: { tone: 'ok', icon: 'CircleCheckBig' },
  REJECTED: { tone: 'danger', icon: 'Ban' },
  CANCELLED: { tone: 'neutral', icon: 'Ban' },
}

/** A line's match result as a badge */
export const MATCH_BADGES: Readonly<Record<string, BadgeLook>> = {
  PENDING: { tone: 'neutral', icon: 'CircleDot' },
  MATCHED: { tone: 'ok', icon: 'CircleCheck' },
  EXCEPTION: { tone: 'danger', icon: 'CircleX' },
}

/**
 * NEW-126: the helper of an invoice's open differences, as src/server/services/ap/exception-help.ts reads it (its DTO
 * fits as it is) — for each difference the reader may see, what code found, the ways the reader has, and who a
 * question may go to
 */
export interface ExceptionHelpData {
  readonly exceptionId: string
  readonly type: string
  readonly assigneeRole: 'PROCUREMENT' | 'RECEIVER' | 'FINANCE'
  readonly amountSatang: bigint
  readonly line: {
    readonly lineNo: number
    readonly poLineNo: number
    readonly description: string
    readonly uom: string
    readonly ordered: string
    readonly received: string
    readonly invoicedElsewhere: string
    readonly invoiced: string
    readonly poUnitPriceSatang: bigint
    readonly unitPriceSatang: bigint
  } | null
  readonly receipts: { readonly count: number; readonly lastOn: string | null } | null
  readonly agreement: { readonly kind: 'FOUND'; readonly unitPriceSatang: bigint; readonly validTo: string } | { readonly kind: 'NONE' | 'NO_ITEM' } | null
  readonly pastPrices: { readonly windowDays: number; readonly count: number; readonly recent: ReadonlyArray<{ readonly poNumber: string | null; readonly unitPriceSatang: bigint; readonly approvedOn: string; readonly priceIncludesVat: boolean }> } | null
  readonly fixes: ReadonlyArray<{ readonly key: HelpFix; readonly href: string }>
  readonly recipients: ReadonlyArray<{ readonly id: string; readonly th: string; readonly en: string | null; readonly relation: 'RECEIVER' | 'REQUESTER' }>
  readonly email: { readonly hasEmail: boolean } | null
}

export interface InvoiceHelpData {
  readonly number: string | null
  readonly supplierInvoiceNo: string | null
  readonly po: { readonly id: string; readonly number: string | null }
  readonly supplier: { readonly nameTh: string; readonly nameEn: string | null }
  readonly statedVatSatang: bigint
  readonly helps: readonly ExceptionHelpData[]
}
