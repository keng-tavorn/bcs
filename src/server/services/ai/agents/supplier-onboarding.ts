import { bankCodeOfName, checkSupplierReading, shouldReadDocument, supplierFieldConfidence, type SupplierReading } from '@/core/ai-checks/supplier'
import { dateIn } from '@/core/supplier-docs'
import { normalizeTaxId } from '@/core/thai/taxid'
import { AI_FILE_MEDIA_TYPES, getAiClient, type AiFileMediaType } from '@/integrations/ai'
import { readObject } from '@/integrations/storage'
import { AI_LIMITS, modelForPurpose } from '@/lib/ai-config'
import { SupplierDocumentReading } from '@/lib/ai-schemas/supplier-document'
import { MS_PER_MINUTE } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { supplierSettingsOf } from '@/lib/org-settings'
import { systemCtx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { checkRegistry } from '../../suppliers'
import { completeAgentAction, requestAgentAction } from '../actions'
import { aiRuntime } from '../gate'

// The Supplier Onboarding Agent (S7-14 · FR-AI-304 · BR-AI-29 BR-AI-30 · ADR-189): once a document of an application is
// scanned clean (job supplier-document-ai), the system asks for a reading of it on behalf of the contact who uploaded it —
// only a type the AI may read for the application's payee (shouldReadDocument · GC-AI-95), only with supplier.aiAssist on,
// at most 10 calls a minute per application, and through every gate of BR-AI-11 (AI_ENABLED, module AI, the agent, the
// evaluation gate, credits). A refusal anywhere is a skip: the application goes on by hand (EG-1). The background run
// reads the file, checks the reading against the application and the registry (src/core/ai-checks/supplier.ts) and
// records a DRAFT whose proposed values a person takes in with supplierApplication.update + aiAssist (BR-AI-30). The AI
// never verifies a document, sends or approves an application, or makes a BankAccountChange (INV-AI-05 · BR-AI-01).

const PURPOSE = 'SUPPLIER_DOC_READ' as const
const JOB = 'supplier-document-ai'
const TIMEZONE = 'Asia/Bangkok'
/** BR-AI-29: calls a minute per application */
const CALLS_PER_MINUTE_PER_APPLICATION = 10
/** The application while its supplier still fills it in */
const OPEN = new Set(['INVITED', 'DRAFT', 'RETURNED'])

export type SupplierReadRequest = 'REQUESTED' | `SKIPPED_${string}`

/** Job supplier-document-ai: a reading of one document of an application, when every rule lets it */
export async function requestSupplierDocumentRead(organizationId: string, documentId: string, now: Date): Promise<SupplierReadRequest> {
  const db = forTenant(organizationId)
  const doc = await db.supplierDocument.findFirst({
    where: { id: documentId },
    select: {
      id: true,
      applicationId: true,
      status: true,
      uploadedByContactId: true,
      documentType: { select: { aiReadable: true, aiReadablePayeeTypes: true } },
      file: { select: { id: true, scanStatus: true, mimeType: true, sizeBytes: true, sha256: true } },
      application: { select: { id: true, status: true, payeeType: true } },
    },
  })
  if (!doc?.application || !doc.applicationId) return 'SKIPPED_NOT_APPLICATION'
  if (!OPEN.has(doc.application.status) || doc.status !== 'PENDING') return 'SKIPPED_CLOSED'
  if (doc.file.scanStatus !== 'CLEAN') return 'SKIPPED_NOT_SCANNED'
  const decision = shouldReadDocument(doc.documentType, doc.application.payeeType)
  if (!decision.read) return `SKIPPED_${decision.reason}`
  const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } })
  if (!supplierSettingsOf(org.settings).aiAssist) return 'SKIPPED_AI_ASSIST_OFF'
  if (!(AI_FILE_MEDIA_TYPES as readonly string[]).includes(doc.file.mimeType) || doc.file.sizeBytes > AI_LIMITS.maxFileBytes) return 'SKIPPED_FILE'
  const recent = await db.agentAction.count({ where: { purpose: PURPOSE, subjectType: 'SUPPLIER_APPLICATION', subjectId: doc.applicationId, createdAt: { gte: new Date(now.getTime() - MS_PER_MINUTE) } } })
  if (recent >= CALLS_PER_MINUTE_PER_APPLICATION) return 'SKIPPED_RATE_LIMITED'
  const started = await requestAgentAction(
    systemCtx(organizationId, now, JOB),
    {
      purpose: PURPOSE,
      subjectType: 'SUPPLIER_APPLICATION',
      subjectId: doc.applicationId,
      inputRefs: { fileId: doc.file.id, documentId: doc.id, ...(doc.file.sha256 ? { sha256: doc.file.sha256 } : {}) },
      ...(doc.uploadedByContactId ? { requestedByContactId: doc.uploadedByContactId } : {}),
    },
    { idempotencyKey: `${JOB}:request:${doc.id}` },
  )
  // a gate that refuses (AI off, the agent off or not evaluated, no credits) leaves the application to the person
  return started.ok ? 'REQUESTED' : `SKIPPED_${started.error.code}`
}

/** The document type whose bank and account name the AI may read, when the customer lets it (BR-AI-29 · OQ-186 (ข)) */
const BANK_BOOK = 'BANK_BOOK'
const BRANCH = /^\d{5}$/

/** What the registries answered, as the routing kept it on the application (registryData = { mode, rd, dbd }) */
function keptRegistry(data: unknown): { name: string | null; address: string | null } | null {
  type Answer = { readonly status?: string; readonly record?: { readonly nameTh?: string | null; readonly address?: string | null } }
  const d = (data && typeof data === 'object' ? data : {}) as { readonly rd?: Answer; readonly dbd?: Answer }
  const record = [d.dbd, d.rd].find((a) => a?.status === 'FOUND' && a.record)?.record
  return record ? { name: record.nameTh ?? null, address: record.address ?? null } : null
}

/** The value the application's form takes for a field read, by its path (src/server/services/suppliers/ai-assist.ts) */
const FORM_PATH: Readonly<Partial<Record<keyof SupplierReading, string>>> = {
  nameTh: 'nameTh',
  nameEn: 'nameEn',
  taxId: 'taxId',
  branchCode: 'branchCode',
  registeredAddress: 'address',
  isVatRegistered: 'isVatRegistered',
  accountName: 'accountName',
}

/**
 * Reads the file of one PENDING SUPPLIER_DOC_READ action and records the answer: a DRAFT with the reading, its checks,
 * the confidence of each field and the values proposed for the application, or FAILED with the reason. An action no
 * longer PENDING is left as it is (a retry of the job repeats nothing).
 */
export async function runSupplierDocumentRead(organizationId: string, agentActionId: string, now: Date): Promise<'DRAFT' | 'FAILED' | 'SKIPPED'> {
  const db = forTenant(organizationId)
  const action = await db.agentAction.findFirst({ where: { id: agentActionId }, select: { id: true, status: true, agent: true, purpose: true, promptVersion: true, subjectId: true, inputRefs: true } })
  if (!action || action.status !== 'PENDING' || action.purpose !== PURPOSE || !action.subjectId) return 'SKIPPED'
  const model = modelForPurpose(PURPOSE, aiRuntime().modelEnv)
  const noTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const finish = async (input: Omit<Parameters<typeof completeAgentAction>[3], 'agentActionId' | 'requestedModel'>) => {
    const r = await completeAgentAction(organizationId, now, action.promptVersion, { agentActionId: action.id, requestedModel: model, ...input })
    return r.ok ? (r.data.status === 'DRAFT' ? ('DRAFT' as const) : ('FAILED' as const)) : ('SKIPPED' as const)
  }
  const refs = (action.inputRefs ?? {}) as { fileId?: string; documentId?: string }
  const [file, doc, app] = await Promise.all([
    refs.fileId ? db.fileObject.findFirst({ where: { id: refs.fileId, status: 'AVAILABLE', scanStatus: 'CLEAN' }, select: { storageKey: true, mimeType: true } }) : null,
    refs.documentId ? db.supplierDocument.findFirst({ where: { id: refs.documentId }, select: { status: true, documentTypeCode: true, documentType: { select: { validityDays: true } } } }) : null,
    db.supplierApplication.findFirst({ where: { id: action.subjectId }, select: { status: true, taxId: true, branchCode: true, payeeType: true, nameTh: true, address: true, registryData: true } }),
  ])
  if (!file || !doc || !app) return finish({ outcome: 'FAILED', model: null, errorCode: 'FILE_GONE', usage: noTokens, latencyMs: null })
  // sent, cancelled or expired since it was asked for, or the document replaced or decided: nobody would take the reading,
  // so the AI is not called (no credits)
  if (!OPEN.has(app.status) || doc.status !== 'PENDING') return finish({ outcome: 'FAILED', model: null, errorCode: 'SUBJECT_CLOSED', usage: noTokens, latencyMs: null })

  const bytes = await readObject(file.storageKey)
  const answer = await getAiClient(getEnv()).extract({ purpose: PURPOSE, model, schema: SupplierDocumentReading, files: [{ bytes, mediaType: file.mimeType as AiFileMediaType }] })
  if (!answer.ok) return finish({ outcome: 'FAILED', model: answer.model ?? null, errorCode: answer.errorCode, usage: answer.usage, latencyMs: answer.latencyMs })

  const { confidence: given, docType, ...rest } = answer.output
  const read = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v === '' ? null : v])) as SupplierReading
  // BR-AI-29 · OQ-186: the bank and the account name only off a document of the type BANK_BOOK (a bank book sent as another
  // type is not read for them), and never a number off a bank book (its "document number" is the account's · BR-AI-18)
  const bankBook = doc.documentTypeCode === BANK_BOOK
  const reading: SupplierReading = {
    ...read,
    ...(bankBook ? {} : { bankName: null, accountName: null }),
    ...(bankBook || docType === BANK_BOOK ? { documentNumber: null } : {}),
  }
  // what the registries say (BR-SUP ข้อ 11): kept on the application once it was routed, else asked now by its tax id
  const kept = keptRegistry(app.registryData)
  const asked = !kept && app.taxId && app.payeeType !== 'FOREIGN' ? (await checkRegistry(app.taxId, app.branchCode)).proposal : null
  const registry = kept ?? (asked?.outcome === 'FOUND' ? { name: asked.nameTh, address: asked.address } : null)
  const checks = checkSupplierReading(reading, {
    application: { taxId: app.taxId, branchCode: app.branchCode, payeeType: app.payeeType, nameTh: app.nameTh, address: app.address },
    registry,
    validityDays: doc.documentType.validityDays,
    today: dateIn(now, TIMEZONE),
  })
  const setting = await db.aiAgentSetting.findFirst({ where: { agent: action.agent }, select: { minConfidenceBp: true } })
  const confidence = supplierFieldConfidence(reading, Object.fromEntries(given.map((c) => [c.field, c.value])), checks, setting?.minConfidenceBp ?? 0)

  // the values proposed for the application, by its paths, as its form takes them (a tax id as its 13 digits, a branch of
  // 5 digits or none); a field that waits one by one is required (BR-AI-16 BR-AI-30)
  const proposed: Record<string, string> = {}
  const requiredPaths: string[] = []
  for (const [field, path] of Object.entries(FORM_PATH) as Array<[keyof SupplierReading, string]>) {
    const value = reading[field]
    if (value === null || value === undefined || value === '') continue
    const formValue = field === 'taxId' ? normalizeTaxId(String(value)) : String(value).trim()
    if (formValue === '' || (field === 'branchCode' && !BRANCH.test(formValue))) continue
    proposed[path] = formValue
    if (confidence[field]?.mustConfirm ?? true) requiredPaths.push(path)
  }
  // a bank read off a bank book: its code by the list, or nothing (BANK_UNKNOWN WARN)
  const bankCode = reading.bankName ? bankCodeOfName(reading.bankName) : null
  if (bankCode) {
    proposed.bankCode = bankCode
    requiredPaths.push('bankCode')
  }
  return finish({
    outcome: 'DRAFT',
    model: answer.model,
    output: { fileId: refs.fileId, documentId: refs.documentId, reading },
    verification: { checks },
    fieldConfidence: Object.fromEntries(Object.entries(confidence).map(([field, c]) => [field, c.confidenceBp])),
    review: { requiredPaths: [...new Set(requiredPaths)].sort(), confirmedPaths: [], proposed },
    usage: answer.usage,
    latencyMs: answer.latencyMs,
  })
}
