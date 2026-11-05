import { z } from 'zod'
import { suggestCoding } from '@/core/invoice/ap'
import { taxDateOf } from '@/core/vat'
import { err, ok, type Result } from '@/core/result'
import { MS_PER_DAY } from '@/lib/constants'
import { authorize, isAllowed } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { CODING_HISTORY_STATUSES, CODING_WINDOW_DAYS } from '../ap/coding'
import { requireModule } from '../modules'
import { accountCodeControls, categoryKey, learningInUse, type LearningControl } from './learning'

// "สมุดของผู้ช่วย" at /admin/ai (NEW-125 · ADR-083): what the assistants learned from what people in the organization
// confirmed, with where it came from, for ORG_ADMIN and AUDITOR (admin.ai.view); ORG_ADMIN switches a learning off or
// on again, or makes the assistant forget it (admin.ai.manage). Phase 1 learns the account code of a supplier and a
// category (BR-AP-10, no AI): each entry is what the coding screen would offer for an invoice dated today, computed by
// the same core function from the same lines. Nothing here is sent to an AI model or used to train one (BR-AI-08).

/** At most this many entries are listed, the suppliers by name */
export const NOTEBOOK_LIMIT = 100
/** The names of who confirmed an entry shown with it; the rest are counted */
const CONFIRMERS_SHOWN = 3

type Name = { readonly th: string; readonly en: string | null }

export interface NotebookEntryDto {
  readonly kind: 'ACCOUNT_CODE'
  /** The supplier the entry is shown under (the first by code of those with the tax id) */
  readonly supplierId: string
  readonly supplier: Name
  readonly categoryCode: string | null
  /** The code the assistant offers (or would offer once switched on again) and its name in the organization's list */
  readonly accountCode: string
  readonly accountName: string | null
  /** How many confirmed lines in the window used that code */
  readonly uses: number
  /** Confirmed lines of the pair in the window, every code */
  readonly lines: number
  /** "YYYY-MM-DD" of the latest invoice that used the code */
  readonly lastUsedOn: string
  readonly confirmedBy: readonly Name[]
  readonly confirmedByCount: number
  readonly disabled: boolean
  /** The version of its AssistantLearning row the screen sends back; -1 when the admin never touched it */
  readonly version: number
}

export interface NotebookDto {
  /** false when the organization does not use tier-2 invoices (PAY): nothing is learned then */
  readonly payOn: boolean
  /** ORG_ADMIN: may switch entries off and on, and forget them */
  readonly canManage: boolean
  readonly windowDays: number
  readonly entries: readonly NotebookEntryDto[]
  /** Entries in all, when more than NOTEBOOK_LIMIT */
  readonly total: number
}

interface HistoryLine {
  readonly accountCode: string
  readonly categoryCode: string | null
  readonly invoiceDate: string
  readonly confirmedAt: Date
  readonly confirmer: { readonly id: string; readonly name: Name } | null
  readonly supplier: { readonly id: string; readonly code: string; readonly name: Name; readonly taxId: string }
}

/** Today in Thai time: what the coding screen offers an invoice dated today */
const today = (now: Date) => taxDateOf(now)

/** The confirmed lines of BR-AP-10 in the window before today, of one tax id or of every supplier */
async function historyLines(tx: TenantTx, now: Date, taxId?: string): Promise<HistoryLine[]> {
  const day = new Date(`${today(now)}T00:00:00Z`)
  const from = new Date(day.getTime() - CODING_WINDOW_DAYS * MS_PER_DAY)
  const rows = await tx.invoiceLine.findMany({
    where: {
      accountCode: { not: null },
      codingConfirmedAt: { not: null },
      invoice: { status: { in: [...CODING_HISTORY_STATUSES] }, invoiceDate: { gte: from, lte: day }, supplier: taxId ? { taxId } : { taxId: { not: null } } },
    },
    select: {
      accountCode: true,
      codingConfirmedAt: true,
      codingConfirmedBy: { select: { id: true, displayNameTh: true, displayNameEn: true } },
      poLine: { select: { categoryCode: true } },
      invoice: { select: { invoiceDate: true, supplier: { select: { id: true, code: true, nameTh: true, nameEn: true, taxId: true } } } },
    },
  })
  return rows.map((r) => ({
    accountCode: r.accountCode!,
    categoryCode: r.poLine.categoryCode,
    invoiceDate: r.invoice.invoiceDate!.toISOString().slice(0, 10),
    confirmedAt: r.codingConfirmedAt!,
    confirmer: r.codingConfirmedBy ? { id: r.codingConfirmedBy.id, name: { th: r.codingConfirmedBy.displayNameTh, en: r.codingConfirmedBy.displayNameEn } } : null,
    supplier: { id: r.invoice.supplier.id, code: r.invoice.supplier.code, name: { th: r.invoice.supplier.nameTh, en: r.invoice.supplier.nameEn }, taxId: r.invoice.supplier.taxId! },
  }))
}

interface Learned {
  readonly accountCode: string
  readonly uses: number
  readonly lines: number
  readonly lastUsedOn: string
  readonly confirmers: ReadonlyMap<string, Name>
}

/** What one pair teaches now (lines the admin made it forget left out), as the coding screen computes it; null = nothing */
function learnedOf(lines: readonly HistoryLine[], control: LearningControl | undefined, now: Date): Learned | null {
  const kept = lines.filter((l) => learningInUse(control, l.confirmedAt, { includeDisabled: true }))
  if (kept.length === 0) return null
  const s = suggestCoding({
    invoiceDate: today(now),
    taxId: kept[0]!.supplier.taxId,
    categoryCode: kept[0]!.categoryCode,
    budgetLine: { accountCode: null, costCenter: '' },
    history: kept.map((l) => ({ taxId: l.supplier.taxId, categoryCode: l.categoryCode, accountCode: l.accountCode, invoiceDate: l.invoiceDate })),
    windowDays: CODING_WINDOW_DAYS,
  })
  if (s.source !== 'HISTORY' || !s.accountCode) return null
  const using = kept.filter((l) => l.accountCode === s.accountCode)
  const confirmers = new Map<string, Name>()
  // the latest confirmation first
  for (const l of [...using].sort((a, b) => b.confirmedAt.getTime() - a.confirmedAt.getTime())) if (l.confirmer) confirmers.set(l.confirmer.id, l.confirmer.name)
  return { accountCode: s.accountCode, uses: s.count, lines: kept.length, lastUsedOn: using.map((l) => l.invoiceDate).sort().at(-1)!, confirmers }
}

const pairKey = (taxId: string, categoryCode: string | null) => `${taxId}\u0000${categoryKey(categoryCode)}`

/** The notebook for /admin/ai (admin.ai.view) */
export async function listNotebook(ctx: Ctx): Promise<Result<NotebookDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'admin.ai.view')
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const canManage = isAllowed(allowed.data, 'admin.ai.manage')
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return ok({ payOn: false, canManage, windowDays: CODING_WINDOW_DAYS, entries: [], total: 0 })
    const lines = await historyLines(tx, ctx.now)
    const controls = await tx.assistantLearning.findMany({ where: { kind: 'ACCOUNT_CODE' }, select: { id: true, supplierTaxId: true, categoryCode: true, disabled: true, forgottenAt: true, version: true } })
    const controlOf = new Map(controls.map((c) => [`${c.supplierTaxId}\u0000${c.categoryCode}`, c]))
    const byPair = new Map<string, HistoryLine[]>()
    for (const l of lines) {
      const k = pairKey(l.supplier.taxId, l.categoryCode)
      const pair = byPair.get(k)
      if (pair) pair.push(l)
      else byPair.set(k, [l])
    }
    const entries: Array<NotebookEntryDto & { readonly sortName: string; readonly supplierCode: string }> = []
    for (const [k, pair] of byPair) {
      const control = controlOf.get(k)
      const learned = learnedOf(pair, control, ctx.now)
      if (!learned) continue
      // every branch of the tax id learns together; the entry is shown under the first supplier by code
      const supplier = [...pair].sort((a, b) => a.supplier.code.localeCompare(b.supplier.code))[0]!.supplier
      entries.push({
        kind: 'ACCOUNT_CODE',
        supplierId: supplier.id,
        supplier: supplier.name,
        categoryCode: pair[0]!.categoryCode,
        accountCode: learned.accountCode,
        accountName: null,
        uses: learned.uses,
        lines: learned.lines,
        lastUsedOn: learned.lastUsedOn,
        confirmedBy: [...learned.confirmers.values()].slice(0, CONFIRMERS_SHOWN),
        confirmedByCount: learned.confirmers.size,
        disabled: control?.disabled ?? false,
        version: control?.version ?? -1,
        sortName: supplier.name.th,
        supplierCode: supplier.code,
      })
    }
    entries.sort((a, b) => a.sortName.localeCompare(b.sortName, 'th') || a.supplierCode.localeCompare(b.supplierCode) || categoryKey(a.categoryCode).localeCompare(categoryKey(b.categoryCode)))
    const shown = entries.slice(0, NOTEBOOK_LIMIT)
    const names = await tx.accountCode.findMany({ where: { code: { in: [...new Set(shown.map((e) => e.accountCode))] } }, select: { code: true, nameTh: true } })
    const nameOf = new Map(names.map((n) => [n.code, n.nameTh]))
    return ok({
      payOn: true,
      canManage,
      windowDays: CODING_WINDOW_DAYS,
      entries: shown.map(({ sortName: _sortName, supplierCode: _supplierCode, ...e }) => ({ ...e, accountName: nameOf.get(e.accountCode) ?? null })),
      total: entries.length,
    })
  })
}

// ---------- assistant_learning.set ----------

const SetLearningInput = z.strictObject({
  kind: z.literal('ACCOUNT_CODE'),
  supplierId: z.uuid(),
  categoryCode: z.string().trim().min(1).max(100).nullable(),
  /** DISABLE: not used until ENABLE · FORGET: the lines confirmed so far are never used again, and the entry is on */
  action: z.enum(['DISABLE', 'ENABLE', 'FORGET']),
  /** The version the screen showed; -1 for an entry the admin never touched (CONFLICT_VERSION when it changed) */
  expectedVersion: z.number().int().min(-1),
})

const noChange = (reason: string): CommandOutcome<never> => ({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'nothing to change', details: { field: 'action', reason } } })

export const setLearningCommand = defineCommand({
  name: 'assistant_learning.set',
  capability: 'admin.ai.manage',
  input: SetLearningInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ id: string; disabled: boolean; forgottenAt: string | null; version: number }>> {
    const allowed = await authorize(tx, ctx, 'admin.ai.manage')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (allowed.data.kind !== 'member') return { ok: false, error: { code: 'FORBIDDEN', message: 'members only' } }
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return { ok: false, error: pay.error }
    const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId }, select: { taxId: true } })
    if (!supplier) return { ok: false, error: { code: 'NOT_FOUND', message: 'supplier not found' } }
    if (!supplier.taxId) return noChange('NOT_LEARNED')
    const category = categoryKey(input.categoryCode)
    const control = (await accountCodeControls(tx, supplier.taxId)).get(category)
    if ((control?.version ?? -1) !== input.expectedVersion) return { ok: false, error: { code: 'CONFLICT_VERSION', message: 'the entry changed in between' } }
    const lines = (await historyLines(tx, ctx.now, supplier.taxId)).filter((l) => categoryKey(l.categoryCode) === category)
    const learned = learnedOf(lines, control, ctx.now)
    // Only what the notebook shows can be changed: an entry with nothing learned has nothing to switch or forget
    if (!learned) return noChange('NOT_LEARNED')
    if (input.action === 'DISABLE' && control?.disabled) return noChange('NO_CHANGE')
    if (input.action === 'ENABLE' && !control?.disabled) return noChange('NO_CHANGE')

    const memberId = allowed.data.memberId
    const next = input.action === 'FORGET' ? { disabled: false, forgottenAt: ctx.now } : { disabled: input.action === 'DISABLE' }
    // Written only at the version read: a change that commits in between makes this one CONFLICT_VERSION (the UPDATE
    // waits for the other's row lock and then finds another version; the INSERT finds the row and does nothing)
    const written = control
      ? await tx.assistantLearning.updateMany({ where: { id: control.id, version: control.version }, data: { ...next, updatedById: memberId, version: { increment: 1 } } })
      : await tx.assistantLearning.createMany({ data: [{ organizationId: ctx.organizationId, kind: 'ACCOUNT_CODE', supplierTaxId: supplier.taxId, categoryCode: category, ...next, updatedById: memberId }], skipDuplicates: true })
    if (written.count !== 1) return { ok: false, error: { code: 'CONFLICT_VERSION', message: 'the entry changed in between' } }
    const row = await tx.assistantLearning.findFirstOrThrow({
      where: { kind: 'ACCOUNT_CODE', supplierTaxId: supplier.taxId, categoryCode: category },
      select: { id: true, disabled: true, forgottenAt: true, version: true },
    })
    const data = { kind: 'ACCOUNT_CODE' as const, supplierId: input.supplierId, categoryCode: input.categoryCode, accountCode: learned.accountCode, uses: learned.uses }
    const event: EventDraft =
      input.action === 'FORGET'
        ? { type: 'assistant_learning.forgotten', aggregateType: 'AssistantLearning', aggregateId: row.id, data: { ...data, forgottenAt: ctx.now.toISOString() } }
        : { type: input.action === 'DISABLE' ? 'assistant_learning.disabled' : 'assistant_learning.enabled', aggregateType: 'AssistantLearning', aggregateId: row.id, data }
    return { ok: true, result: { id: row.id, disabled: row.disabled, forgottenAt: row.forgottenAt?.toISOString() ?? null, version: row.version }, events: [event] }
  },
})

export function setAssistantLearning(ctx: Ctx, input: z.input<typeof SetLearningInput>, options: RunOptions) {
  return runCommand(ctx, setLearningCommand, input, options)
}
