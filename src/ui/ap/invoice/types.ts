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
  readonly supplier: { readonly id: string; readonly code: string; readonly nameTh: string; readonly nameEn: string | null }
  readonly file: { readonly id: string; readonly fileName: string } | null
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
