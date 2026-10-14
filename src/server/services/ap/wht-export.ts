import { createHash } from 'node:crypto'
import { z } from 'zod'
import { satangToAmount } from '@/core/money/dto'
import { putObject } from '@/integrations/storage'
import { csv, utf8WithBom } from '@/lib/encoding'
import { newId } from '@/lib/ids'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { recordSensitiveAccess } from '../audit/sensitive-access'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requireModule } from '../modules'
import { maskTaxId } from '../suppliers/access'
import { fail } from './common'
import './wht-files'

// The monthly summary of ภ.ง.ด.3 and ภ.ง.ด.53 (BR-WHT-08, FR-AP-104 AC4): one CSV per return and month of the date
// paid, an ExportJob of kind WHT_RETURN like the Express file — its rows, its total and its sha256 (BR-EXP-03). The
// layout is BCS's own until OQ-123 brings the Revenue Department's: the first line says so. One row per 50 ทวิ, income
// type and rate; the total row is the sum of the rows. An individual's national id is masked unless FINANCE asks for
// it whole with wht.revealTaxId, and then every certificate in the file is logged in SensitiveAccessLog (BR-WHT-09).

export const WHT_RETURN_NOTICE = 'ไฟล์สรุปจาก BCS ไม่ใช่รูปแบบยื่นของกรมสรรพากร · Not the Revenue Department filing format'
const HEADER = ['ลำดับ', 'เลขที่ 50 ทวิ', 'เลขประจำตัวผู้เสียภาษีอากร', 'สาขา', 'ชื่อผู้รับเงิน', 'วันที่จ่าย', 'ประเภทเงินได้', 'อัตรา (bp)', 'จำนวนเงินที่จ่าย', 'ภาษีที่หัก']

const ExportInput = z.strictObject({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  form: z.enum(['PND3', 'PND53']),
  /** The file holds individuals' national ids whole (wht.revealTaxId) */
  revealTaxId: z.boolean().default(false),
})

export const exportWhtReturnCommand = defineCommand({
  name: 'wht.export',
  capability: 'wht.export',
  input: ExportInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ exportJobId: string; fileId: string; rowCount: number; total: string; checksum: string }>> {
    const allowed = await authorize(tx, ctx, 'wht.export')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (allowed.data.kind !== 'member' || ctx.actor.type !== 'USER') return fail('FORBIDDEN', 'only a member exports')
    const actor = allowed.data.memberId
    if (input.revealTaxId) {
      const reveal = await authorize(tx, ctx, 'wht.revealTaxId')
      if (!reveal.ok) return { ok: false, error: reveal.error }
    }
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return { ok: false, error: pay.error }

    const [year, month] = input.month.split('-').map(Number) as [number, number]
    const from = new Date(Date.UTC(year, month - 1, 1))
    const to = new Date(Date.UTC(year, month, 1))
    const taxes = await tx.withholdingTax.findMany({
      where: { form: input.form, paidOn: { gte: from, lt: to }, taxSatang: { gt: 0n }, certificateId: { not: null } },
      select: { certificateId: true, incomeTypeCode: true, rateBp: true, baseSatang: true, taxSatang: true, payeeType: true },
    })
    const certificates = await tx.whtCertificate.findMany({ where: { id: { in: [...new Set(taxes.map((t) => t.certificateId!))] } }, orderBy: { number: 'asc' }, select: { id: true, number: true, paidOn: true, payeeSnapshot: true } })
    const rows: Array<{ certificate: (typeof certificates)[number]; incomeType: string; rateBp: number; base: bigint; tax: bigint; individual: boolean }> = []
    for (const c of certificates) {
      const groups = new Map<string, (typeof rows)[number]>()
      for (const t of taxes.filter((x) => x.certificateId === c.id)) {
        const key = `${t.incomeTypeCode}|${t.rateBp}`
        const row = groups.get(key) ?? { certificate: c, incomeType: t.incomeTypeCode, rateBp: t.rateBp, base: 0n, tax: 0n, individual: t.payeeType === 'INDIVIDUAL' }
        row.base += t.baseSatang
        row.tax += t.taxSatang
        groups.set(key, row)
      }
      rows.push(...[...groups.values()].sort((a, b) => (a.incomeType < b.incomeType ? -1 : a.incomeType > b.incomeType ? 1 : a.rateBp - b.rateBp)))
    }
    const payee = (c: (typeof certificates)[number]) => c.payeeSnapshot as { name: string; taxId: string; branch: string }
    const body = rows.map((r, i) => [
      String(i + 1),
      r.certificate.number,
      r.individual && !input.revealTaxId ? maskTaxId(payee(r.certificate).taxId) : payee(r.certificate).taxId,
      payee(r.certificate).branch,
      payee(r.certificate).name,
      r.certificate.paidOn.toISOString().slice(0, 10),
      r.incomeType,
      String(r.rateBp),
      satangToAmount(r.base),
      satangToAmount(r.tax),
    ])
    const totalBase = rows.reduce((a, r) => a + r.base, 0n)
    const total = rows.reduce((a, r) => a + r.tax, 0n)
    const bytes = utf8WithBom(csv([[WHT_RETURN_NOTICE], HEADER, ...body, ['', '', '', '', '', '', '', 'รวม', satangToAmount(totalBase), satangToAmount(total)]]))
    const checksum = createHash('sha256').update(bytes).digest('hex')

    // BR-WHT-09: a file with national ids whole is a reveal of each certificate's payee in it
    if (input.revealTaxId) {
      for (const c of new Set(rows.filter((r) => r.individual).map((r) => r.certificate.id))) await recordSensitiveAccess(tx, ctx, { subjectType: 'WhtCertificate', subjectId: c, fields: ['payeeSnapshot.taxId'], purpose: 'wht.export' })
    }
    const exportJobId = newId()
    const fileId = newId()
    const key = `org/${ctx.organizationId}/exports/${exportJobId}.csv`
    await putObject(key, bytes, 'text/csv')
    const fileName = `${input.form.toLowerCase()}-${input.month}-${exportJobId.slice(-6)}.csv`
    await tx.fileObject.create({ data: { id: fileId, organizationId: ctx.organizationId, storageKey: key, fileName, mimeType: 'text/csv', sizeBytes: bytes.length, sha256: checksum, status: 'AVAILABLE', uploadedById: actor } })
    await tx.exportJob.create({
      data: { id: exportJobId, organizationId: ctx.organizationId, kind: 'WHT_RETURN', params: { month: input.month, form: input.form, revealTaxId: input.revealTaxId }, status: 'COMPLETED', fileId, rowCount: rows.length, totalSatang: total, checksum, requestedById: actor, completedAt: ctx.now },
    })
    await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId, subjectType: 'ExportJob', subjectId: exportJobId, kind: 'OTHER' } })
    return {
      ok: true,
      result: { exportJobId, fileId, rowCount: rows.length, total: satangToAmount(total), checksum },
      events: [{ type: 'export.generated', aggregateType: 'ExportJob', aggregateId: exportJobId, data: { kind: 'WHT_RETURN', rowCount: rows.length, totalSatang: total.toString(), checksum, fileId, invoiceIds: [], excludedInvoiceIds: [], again: false } }],
      notifications: [{ recipientMemberId: actor, templateKey: 'export.ready', data: { exportJobId, fileId, rowCount: rows.length, kind: 'WHT_RETURN' }, urgency: 'IMMEDIATE', dedupeKey: `export.ready:${exportJobId}`, subjectType: 'EXPORT_JOB', subjectId: exportJobId }],
    }
  },
})

export function exportWhtReturn(ctx: Ctx, input: z.input<typeof ExportInput>, options: RunOptions) {
  return runCommand(ctx, exportWhtReturnCommand, input, options)
}
