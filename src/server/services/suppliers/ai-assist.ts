import type { TenantTx } from '@/server/db/tenant'
import { registerAssistSubject } from '../ai/assist-contract'

// The supplier's application as a subject of the AI-assist contract (S7-14 · FR-AI-304 AC3 · BR-AI-30 · ADR-189): what the
// Supplier Onboarding Agent read off a document (purpose SUPPLIER_DOC_READ) goes into the application only through
// supplierApplication.update with aiAssist, by a person — the supplier's contact on the portal (supplierActor) or
// procurement filling it in on its behalf. A draft keeps fields waiting until it is sent (final: false); the submit asks
// assertNoPendingAiReview. The values by path, as text, are the fields the agent may propose; never an account number.

export const SUPPLIER_ASSIST_PATHS = ['nameTh', 'nameEn', 'taxId', 'branchCode', 'address', 'isVatRegistered', 'bankCode', 'accountName'] as const

async function read(tx: TenantTx, id: string): Promise<Readonly<Record<string, string>> | null> {
  const app = await tx.supplierApplication.findUnique({ where: { id }, select: { nameTh: true, nameEn: true, taxId: true, branchCode: true, address: true, isVatRegistered: true, bankCode: true, accountName: true } })
  if (!app) return null
  const out: Record<string, string> = {}
  for (const path of SUPPLIER_ASSIST_PATHS) {
    const value = app[path]
    if (value !== null && value !== undefined && value !== '') out[path] = typeof value === 'boolean' ? String(value) : value
  }
  return out
}

export interface AiReadingField {
  /** The application's field (src/server/services/suppliers/ai-assist.ts SUPPLIER_ASSIST_PATHS) */
  readonly path: string
  readonly value: string
  readonly confidencePercent: number
  /** WARN or FAIL of the check on the field read (BR-AI-29), null when it passed or had none */
  readonly check: 'WARN' | 'FAIL' | null
  /** Confirmed one by one (critical, or below the floor · BR-AI-30) */
  readonly mustConfirm: boolean
  readonly confirmed: boolean
}

export interface AiReading {
  readonly agentActionId: string
  readonly documentTypeCode: string | null
  readonly fileName: string | null
  readonly createdAt: string
  readonly fields: readonly AiReadingField[]
}

/** The field of the application each field read fills, for the confidence and the checks (reverse of the agent's map) */
const READ_FIELD: Readonly<Record<string, string>> = { address: 'registeredAddress', bankCode: 'bankName' }
const CHECK_FIELD: Readonly<Record<string, string>> = { TAXID_CHECKSUM: 'taxId', TAXID_MISMATCH: 'taxId', REGISTRY_NAME_MISMATCH: 'nameTh', REGISTRY_ADDRESS_MISMATCH: 'registeredAddress', DOC_DATE_FUTURE: 'issuedOn', DOC_EXPIRED: 'issuedOn' }

/** A DRAFT reading of SUPPLIER_DOC_READ as the screens show it (the portal's panel, the application's page) */
export function aiReadingOf(
  a: { readonly id: string; readonly createdAt: Date; readonly review: unknown; readonly fieldConfidence: unknown; readonly verification: unknown; readonly inputRefs: unknown },
  docOf: ReadonlyMap<string, { readonly documentTypeCode: string; readonly file: { readonly fileName: string } }>,
): AiReading {
  const review = (a.review ?? {}) as { proposed?: Record<string, string>; requiredPaths?: string[]; confirmedPaths?: string[] }
  const confidence = (a.fieldConfidence ?? {}) as Record<string, number>
  const checks = ((a.verification as { checks?: { code: string; result: string }[] } | null)?.checks ?? []).filter((c) => c.result !== 'PASS')
  const worst = (field: string): 'WARN' | 'FAIL' | null => {
    const mine = checks.filter((c) => CHECK_FIELD[c.code] === field)
    return mine.some((c) => c.result === 'FAIL') ? 'FAIL' : mine.length ? 'WARN' : null
  }
  const doc = docOf.get((a.inputRefs as { documentId?: string } | null)?.documentId ?? '')
  const required = new Set(review.requiredPaths ?? [])
  const confirmed = new Set(review.confirmedPaths ?? [])
  return {
    agentActionId: a.id,
    documentTypeCode: doc?.documentTypeCode ?? null,
    fileName: doc?.file.fileName ?? null,
    createdAt: a.createdAt.toISOString(),
    fields: Object.entries(review.proposed ?? {}).map(([path, value]) => {
      const read = READ_FIELD[path] ?? path
      return { path, value, confidencePercent: Math.floor((confidence[read] ?? 0) / 100), check: worst(read), mustConfirm: required.has(path), confirmed: confirmed.has(path) }
    }),
  }
}

registerAssistSubject('SUPPLIER_APPLICATION', { purposes: ['SUPPLIER_DOC_READ'], final: false, read, supplierActor: true })
