import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { E2E_DB } from '../../../support/e2e-env'

// Run by the S9 scene of phase 1 (tests/e2e/p1demo/11-…, through support.ts script()) against the run's p1demo database
// only: what the payment run scene reads back from the database, and the two things the e2e app has no background job
// for — the bank's pay day and the sending of the run's payment advices. The organization is the one of sheet Org of the
// phase-1 workbook; invoices are found by their supplier's code and number, never by an id typed in a test. Prints JSON
// on its last line; amounts are satang as strings, days YYYY-MM-DD.
//   seq                         the newest event's seq
//   docs <supplier:no>…         each supplier invoice: id, number, status, due date, payable, expected tax withheld
//   run <runId>                 the run: number, status, pay date, payer, totals, flags; its items with their documents,
//                               tax lines, result and 50 ทวิ; its approval route and how its task was decided (channel,
//                               decision, step-up); the types of the events about the run, its items, its documents, its
//                               file, its tax and certificates and its suppliers' notices, in order
//   payday <runId>              the bank pays today: the run's pay date set to today in Thai time when it is later, so
//                               the results can be recorded on any day the scene runs (the run was approved for the next
//                               run day, which is in the future on most days)
//   advices <runId>             what the job supplier-notice-send does for this run only: each PENDING payment advice of
//                               the run's items sent by id (never the sweep, which would send the history's old notices)
// Loads the app's modules only when tsx runs it.

async function main(command: string | undefined, args: readonly string[]): Promise<unknown> {
  if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the S9 scene script runs in the e2e database only')
  const [{ prisma }, { INPUT_WORKBOOKS, loadInputWorkbook }, { taxDateOf }] = await Promise.all([import('@/server/db/client'), import('@/server/seed/workbook'), import('@/core/vat')])
  const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
  const orgCode = workbook.keyValues('Org').get('code')?.value
  if (!orgCode) throw new Error('the Org sheet names no organization code')
  const org = await prisma.organization.findUniqueOrThrow({ where: { code: orgCode }, select: { id: true } })
  const organizationId = org.id

  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)
  const satang = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString())

  async function docs(pairs: readonly string[]) {
    const out = []
    for (const pair of pairs) {
      const at = pair.indexOf(':')
      const supplierCode = pair.slice(0, at)
      const invoiceNo = pair.slice(at + 1)
      if (at < 1 || !invoiceNo) throw new Error(`docs takes <supplier>:<invoiceNo>, not ${pair}`)
      const invoice = await prisma.invoice.findFirst({
        where: { organizationId, kind: 'INVOICE', supplier: { code: supplierCode }, supplierInvoiceNo: invoiceNo, status: { notIn: ['CANCELLED', 'REJECTED'] } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, number: true, status: true, dueDate: true, invoiceDate: true, payableSatang: true, expectedWhtSatang: true },
      })
      out.push({
        supplier: supplierCode,
        invoiceNo,
        found: invoice !== null,
        id: invoice?.id ?? null,
        number: invoice?.number ?? null,
        status: invoice?.status ?? null,
        invoiceDate: day(invoice?.invoiceDate ?? null),
        dueDate: day(invoice?.dueDate ?? null),
        payableSatang: satang(invoice?.payableSatang),
        expectedWhtSatang: satang(invoice?.expectedWhtSatang),
      })
    }
    return out
  }

  async function run(runId: string) {
    const r = await prisma.paymentRun.findFirst({
      where: { organizationId, id: runId },
      select: {
        id: true,
        number: true,
        status: true,
        payDate: true,
        fileTemplateCode: true,
        totalPayableSatang: true,
        totalWhtSatang: true,
        totalTransferSatang: true,
        itemCount: true,
        documentCount: true,
        flagsKey: true,
        payer: { select: { code: true } },
        preparedBy: { select: { employeeCode: true } },
        files: { orderBy: { version: 'asc' }, select: { fileId: true, fileName: true, status: true, itemCount: true, totalSatang: true } },
        items: {
          orderBy: { seq: 'asc' },
          select: {
            id: true,
            seq: true,
            supplier: { select: { code: true } },
            payableSatang: true,
            whtSatang: true,
            transferSatang: true,
            flags: true,
            status: true,
            paidOn: true,
            failureReason: true,
            whtLines: { select: { incomeType: true, rateBp: true, baseSatang: true, whtSatang: true } },
            documents: { select: { invoiceId: true, status: true, invoice: { select: { supplierInvoiceNo: true, number: true, status: true } } } },
            whtCertificate: { select: { id: true, number: true, form: true, totalBaseSatang: true, totalTaxSatang: true, fileId: true } },
          },
        },
      },
    })
    if (!r) throw new Error(`${orgCode} has no payment run ${runId}`)
    const routes = await prisma.approvalRoute.findMany({
      where: { organizationId, subjectType: 'PAYMENT_RUN', subjectId: r.id },
      orderBy: { routeNo: 'asc' },
      select: { ruleCode: true, amountSatang: true, status: true, steps: { orderBy: { stepNo: 'asc' }, select: { tasks: { orderBy: { createdAt: 'asc' }, select: { id: true, assigneeMemberId: true, status: true, decision: true, channel: true } } } } },
    })
    const tasks = routes.flatMap((x) => x.steps.flatMap((s) => s.tasks))
    const members = await prisma.member.findMany({ where: { organizationId, id: { in: tasks.map((t) => t.assigneeMemberId) } }, select: { id: true, employeeCode: true } })
    const decided = await prisma.event.findFirst({ where: { organizationId, type: 'approval_task.decided', data: { path: ['subjectId'], equals: r.id } }, orderBy: { seq: 'desc' }, select: { channel: true, data: true } })
    const decidedData = (decided?.data ?? {}) as { channel?: string; stepUpGrantId?: string | null; decision?: string }
    const itemIds = r.items.map((i) => i.id)
    const invoiceIds = r.items.flatMap((i) => i.documents.map((d) => d.invoiceId)).filter((id): id is string => id !== null)
    const taxes = await prisma.withholdingTax.findMany({ where: { organizationId, paymentRunItemId: { in: itemIds } }, select: { id: true } })
    const notices = await prisma.supplierNotice.findMany({ where: { organizationId, subjectType: 'PAYMENT_RUN_ITEM', subjectId: { in: itemIds } }, select: { id: true, templateKey: true, status: true, subjectId: true } })
    const certificates = r.items.flatMap((i) => (i.whtCertificate ? [i.whtCertificate.id] : []))
    const aggregates = [r.id, ...itemIds, ...invoiceIds, ...tasks.map((t) => t.id), ...r.files.map((f) => f.fileId), ...taxes.map((t) => t.id), ...certificates, ...notices.map((n) => n.id)]
    // Only what happened to these documents while they were in this run: from the run's first event on
    const first = await prisma.event.findFirst({ where: { organizationId, aggregateId: r.id }, orderBy: { seq: 'asc' }, select: { seq: true } })
    const events = await prisma.event.findMany({ where: { organizationId, aggregateId: { in: aggregates }, ...(first ? { seq: { gte: first.seq } } : {}) }, orderBy: { seq: 'asc' }, select: { type: true } })
    return {
      id: r.id,
      number: r.number,
      status: r.status,
      payDate: day(r.payDate),
      payer: r.payer.code,
      preparedBy: r.preparedBy.employeeCode,
      fileTemplateCode: r.fileTemplateCode,
      totalPayableSatang: satang(r.totalPayableSatang),
      totalWhtSatang: satang(r.totalWhtSatang),
      totalTransferSatang: satang(r.totalTransferSatang),
      itemCount: r.itemCount,
      documentCount: r.documentCount,
      flagsKey: r.flagsKey,
      files: r.files.map((f) => ({ fileName: f.fileName, status: f.status, itemCount: f.itemCount, totalSatang: satang(f.totalSatang) })),
      items: r.items.map((i) => ({
        seq: i.seq,
        supplier: i.supplier.code,
        payableSatang: satang(i.payableSatang),
        whtSatang: satang(i.whtSatang),
        transferSatang: satang(i.transferSatang),
        flags: i.flags,
        status: i.status,
        paidOn: day(i.paidOn),
        failureReason: i.failureReason,
        whtLines: i.whtLines.map((l) => ({ incomeType: l.incomeType, rateBp: l.rateBp, baseSatang: satang(l.baseSatang), whtSatang: satang(l.whtSatang) })),
        documents: i.documents.map((d) => ({ supplierInvoiceNo: d.invoice?.supplierInvoiceNo ?? null, number: d.invoice?.number ?? null, status: d.status, invoiceStatus: d.invoice?.status ?? null })),
        certificate: i.whtCertificate
          ? { number: i.whtCertificate.number, form: i.whtCertificate.form, totalBaseSatang: satang(i.whtCertificate.totalBaseSatang), totalTaxSatang: satang(i.whtCertificate.totalTaxSatang), hasFile: i.whtCertificate.fileId !== null }
          : null,
        advices: notices.filter((n) => n.subjectId === i.id).map((n) => ({ templateKey: n.templateKey, status: n.status })),
      })),
      routes: routes.map((x) => ({
        ruleCode: x.ruleCode,
        amountSatang: satang(x.amountSatang),
        status: x.status,
        tasks: x.steps.flatMap((s) => s.tasks.map((t) => ({ id: t.id, assignee: members.find((m) => m.id === t.assigneeMemberId)?.employeeCode ?? null, status: t.status, decision: t.decision, channel: t.channel }))),
      })),
      decided: decided ? { channel: decidedData.channel ?? decided.channel, decision: decidedData.decision ?? null, stepUp: Boolean(decidedData.stepUpGrantId) } : null,
      events: events.map((e) => e.type),
    }
  }

  async function payday(runId: string) {
    const r = await prisma.paymentRun.findFirst({ where: { organizationId, id: runId }, select: { id: true, payDate: true } })
    if (!r) throw new Error(`${orgCode} has no payment run ${runId}`)
    const today = taxDateOf(new Date())
    const was = day(r.payDate)!
    if (was > today) await prisma.paymentRun.update({ where: { id: r.id }, data: { payDate: new Date(`${today}T00:00:00Z`) } })
    return { was, payDate: was > today ? today : was }
  }

  async function advices(runId: string) {
    const [{ sendSupplierNotice }, { PAY_SUPPLIER_TEMPLATES }] = await Promise.all([import('@/server/notifications/supplier-notices'), import('@/server/notifications/supplier-templates-pay')])
    const items = await prisma.paymentRunItem.findMany({ where: { organizationId, paymentRunId: runId }, select: { id: true, supplier: { select: { code: true } } } })
    const pending = await prisma.supplierNotice.findMany({
      where: { organizationId, templateKey: PAY_SUPPLIER_TEMPLATES.paymentAdvice, status: 'PENDING', subjectType: 'PAYMENT_RUN_ITEM', subjectId: { in: items.map((i) => i.id) } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, subjectId: true },
    })
    const sent = []
    for (const n of pending) sent.push({ supplier: items.find((i) => i.id === n.subjectId)?.supplier.code ?? null, outcome: await sendSupplierNotice(organizationId, n.id, new Date()) })
    return sent
  }

  try {
    switch (command) {
      case 'seq': {
        const last = await prisma.event.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true } })
        return { seq: (last?.seq ?? 0n).toString() }
      }
      case 'docs':
        if (args.length === 0) throw new Error('docs <supplier:invoiceNo>…')
        return await docs(args)
      case 'run':
        if (!args[0]) throw new Error('run <runId>')
        return await run(args[0])
      case 'payday':
        if (!args[0]) throw new Error('payday <runId>')
        return await payday(args[0])
      case 'advices':
        if (!args[0]) throw new Error('advices <runId>')
        return await advices(args[0])
      default:
        throw new Error(`unknown S9 scene command ${command ?? '(none)'}`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

const ranByTsx = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (ranByTsx) {
  const [command, ...args] = process.argv.slice(2)
  console.log(JSON.stringify(await main(command, args)))
}
