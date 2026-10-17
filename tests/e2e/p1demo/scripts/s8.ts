import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { E2E_DB } from '../../../support/e2e-env'

// Run by the S8 scenes of phase 1 (tests/e2e/p1demo/08-…, 09-…, 10-…, through support.ts script()) against the run's
// p1demo database only: what happens outside the screens before an invoice scene — the supplier's e-mail — and what a
// scene reads back from the database. The organization is the one of sheet Org of the phase-1 workbook; every object is
// found by the values of the sheet (a Request_History row's draft event, a supplier code and its invoice number), never
// by an id typed in a test. Prints JSON on its last line; amounts are satang as strings, days YYYY-MM-DD.
//   seq                          the newest event's seq: a scene reads the events written after it
//   po <ref>                     the PO the history made for a row of sheet Request_History (the row's draft event carries
//                                its key, demo-history:<ref>:draft): number, status, supplier, lines with their budget
//                                line (code, account, cost center) and what is received, each budget line's balance
//   mail <scene>                 the supplier's e-mail of a Demo_Script_P1 row with channel EMAIL: first the messages to
//                                the organization's inbox address are deleted from Mailpit (only those: Mailpit is shared
//                                by every run of this machine), then the e-Tax XML of the row's invoice (its number,
//                                today's date in Thai time, the seller's tax id and branch from the database, the row's
//                                amounts) is sent from the supplier's address with the subject of the row's expectJson
//   invoice <supplier> <no> <seq> the supplier's invoice of that number: header, amounts, dates, lines and their coding,
//                                differences, its approval routes with their tasks, the balance of its lines' budget
//                                lines, and the types of the events written after <seq> about it (the invoice, its inbound
//                                e-mail, its tasks, and the budget movements of its PO)
// Loads the app's modules only when tsx runs it.

const MAILPIT_API = 'http://localhost:8025/api/v1'

async function main(command: string | undefined, args: readonly string[]): Promise<unknown> {
  if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the S8 scene script runs in the e2e database only')
  const [{ prisma }, { INPUT_WORKBOOKS, loadInputWorkbook }, { etaxSampleXml }] = await Promise.all([
    import('@/server/db/client'),
    import('@/server/seed/workbook'),
    import('@/server/seed/etax-sample'),
  ])
  const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
  const orgCode = workbook.keyValues('Org').get('code')?.value
  if (!orgCode) throw new Error('the Org sheet names no organization code')
  const org = await prisma.organization.findUniqueOrThrow({ where: { code: orgCode }, select: { id: true, settings: true } })
  const organizationId = org.id

  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)
  const satang = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString())
  /** Baht as the sheet writes it ("94000", "6451.2") in satang */
  const satangOfSheet = (value: string | null | undefined): bigint => {
    const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(value ?? '')
    if (!m) throw new Error(`not an amount in baht: ${value ?? '(empty)'}`)
    return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'))
  }
  const bahtText = (s: bigint) => `${s / 100n}.${String(s % 100n).padStart(2, '0')}`

  async function balances(budgetLineIds: readonly string[]) {
    const rows = await prisma.budgetLineBalance.findMany({ where: { organizationId, budgetLineId: { in: [...budgetLineIds] } } })
    return Object.fromEntries(
      rows.map((b) => [b.budgetLineId, { available: satang(b.availableSatang), reserved: satang(b.reservedSatang), committed: satang(b.committedSatang), actual: satang(b.actualSatang) }]),
    )
  }

  async function poOf(ref: string) {
    if (!/^H\d{2,3}$/.test(ref)) throw new Error(`po takes a ref of sheet Request_History, not ${ref}`)
    // Every event of a step of the history carries the step's key as its requestId (src/server/services/demo-history)
    const drafted = await prisma.event.findFirst({ where: { organizationId, aggregateType: 'Request', requestId: `demo-history:${ref}:draft` }, select: { aggregateId: true } })
    if (!drafted) throw new Error(`the history made no request for ${ref}`)
    const pos = await prisma.purchaseOrder.findMany({
      where: { organizationId, lines: { some: { sources: { some: { requestLine: { requestId: drafted.aggregateId } } } } } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        number: true,
        status: true,
        kind: true,
        paymentTermDays: true,
        supplier: { select: { code: true } },
        lines: {
          orderBy: { lineNo: 'asc' },
          select: {
            id: true,
            lineNo: true,
            quantity: true,
            receivedQuantity: true,
            unitPriceSatang: true,
            netSatang: true,
            budgetLine: { select: { id: true, code: true, accountCode: true, costCenter: { select: { code: true } }, department: { select: { code: true } } } },
          },
        },
      },
    })
    const po = pos[0]
    if (!po) throw new Error(`no PO orders the request of ${ref}`)
    const invoices = await prisma.invoice.count({ where: { organizationId, poId: po.id, status: { notIn: ['CANCELLED', 'REJECTED'] } } })
    return {
      ref,
      requestId: drafted.aggregateId,
      poCount: pos.length,
      poId: po.id,
      poNumber: po.number,
      status: po.status,
      kind: po.kind,
      paymentTermDays: po.paymentTermDays,
      supplier: po.supplier.code,
      invoices,
      lines: po.lines.map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        quantity: l.quantity.toString(),
        received: l.receivedQuantity.toString(),
        unitPriceSatang: satang(l.unitPriceSatang),
        netSatang: satang(l.netSatang),
        budgetLineId: l.budgetLine.id,
        budgetLineCode: l.budgetLine.code,
        accountCode: l.budgetLine.accountCode,
        costCenter: l.budgetLine.costCenter.code,
        department: l.budgetLine.department.code,
      })),
      balances: await balances([...new Set(po.lines.map((l) => l.budgetLine.id))]),
    }
  }

  /** Deletes the messages to exactly this address from Mailpit, page by page; an empty list is never sent (it would delete all) */
  async function clearMailTo(address: string): Promise<number> {
    let deleted = 0
    for (let round = 0; round < 50; round++) {
      const found = await fetch(`${MAILPIT_API}/search?query=${encodeURIComponent(`to:"${address}"`)}&limit=200`)
      if (!found.ok) throw new Error(`Mailpit search: ${found.status}`)
      const { messages } = (await found.json()) as { messages: Array<{ ID: string; To: ReadonlyArray<{ Address: string }> | null }> }
      const ids = messages.filter((m) => (m.To ?? []).some((t) => t.Address.toLowerCase() === address.toLowerCase())).map((m) => m.ID)
      if (ids.length === 0) return deleted
      const gone = await fetch(`${MAILPIT_API}/messages`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ IDs: ids }) })
      if (!gone.ok) throw new Error(`Mailpit delete: ${gone.status}`)
      deleted += ids.length
    }
    throw new Error(`Mailpit still has messages to ${address} after 50 rounds`)
  }

  async function mail(sceneNo: string) {
    const row = workbook.table('Demo_Script_P1').find((r) => r.values.scene === sceneNo)
    if (!row) throw new Error(`Demo_Script_P1 has no scene ${sceneNo}`)
    const v = row.values
    if (v.channel !== 'EMAIL') throw new Error(`scene ${sceneNo} is not an e-mail scene (channel ${v.channel ?? '(empty)'})`)
    const expectJson = JSON.parse(v.expectJson ?? '{}') as { mail?: { subjectTh?: string; attachment?: string; clearMailboxFirst?: boolean } }
    if (expectJson.mail?.attachment !== 'ETAX_XML' || !expectJson.mail.subjectTh) throw new Error(`scene ${sceneNo}: expectJson.mail names no e-Tax attachment or subject`)
    const invoiceNo = v.invoiceNo
    if (!invoiceNo || !v.supplier || !v.historyRef) throw new Error(`scene ${sceneNo}: invoiceNo, supplier and historyRef are needed`)
    const inbox = ((org.settings as { ap?: { inboxAddress?: string } } | null)?.ap?.inboxAddress ?? '').trim()
    if (!inbox) throw new Error(`${orgCode} has no ap.inboxAddress`)
    const supplier = await prisma.supplier.findFirstOrThrow({ where: { organizationId, code: v.supplier }, select: { nameTh: true, taxId: true, branchCode: true, email: true } })
    if (!supplier.email || !supplier.taxId) throw new Error(`${v.supplier} has no e-mail or tax id`)
    const po = await poOf(v.historyRef)
    const deleted = expectJson.mail.clearMailboxFirst ? await clearMailTo(inbox) : 0
    const issueDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date())
    const xml = etaxSampleXml({
      invoiceNo,
      issueDate,
      sellerName: supplier.nameTh,
      sellerTaxId: supplier.taxId,
      sellerBranch: supplier.branchCode,
      net: bahtText(satangOfSheet(v.net)),
      vat: bahtText(satangOfSheet(v.vat)),
      gross: bahtText(satangOfSheet(v.gross)),
    })
    const subject = expectJson.mail.subjectTh.replaceAll('{invoiceNo}', invoiceNo).replaceAll('{poNumber}', po.poNumber ?? '')
    const { default: nodemailer } = await import('nodemailer')
    await nodemailer.createTransport({ host: 'localhost', port: 1025, secure: false }).sendMail({
      from: supplier.email,
      to: inbox,
      subject,
      text: 'ใบแจ้งหนี้ตามแนบ',
      messageId: `<p1demo-${sceneNo.padStart(2, '0')}-${v.historyRef}@supplier.simec.local>`,
      attachments: [{ filename: `${invoiceNo.replace(/[^A-Za-z0-9-]/g, '-')}.xml`, content: Buffer.from(xml), contentType: 'application/xml' }],
    })
    return { inbox, from: supplier.email, subject, issueDate, deleted, poId: po.poId, poNumber: po.poNumber }
  }

  async function invoiceOf(supplierCode: string, invoiceNo: string, since: string) {
    if (!/^\d+$/.test(since)) throw new Error(`invoice takes the seq to read events after, not ${since}`)
    const invoice = await prisma.invoice.findFirst({
      where: { organizationId, kind: 'INVOICE', supplier: { code: supplierCode }, supplierInvoiceNo: invoiceNo, status: { notIn: ['CANCELLED'] } },
      orderBy: { createdAt: 'desc' },
      include: {
        po: { select: { id: true, number: true } },
        lines: { orderBy: { lineNo: 'asc' }, include: { costCenter: { select: { code: true } }, poLine: { select: { budgetLineId: true } } } },
        exceptions: { orderBy: { createdAt: 'asc' }, include: { invoiceLine: { select: { lineNo: true } } } },
        recordedBy: { select: { employeeCode: true } },
      },
    })
    if (!invoice) return null
    const routes = await prisma.approvalRoute.findMany({
      where: { organizationId, subjectType: 'INVOICE', subjectId: invoice.id },
      orderBy: { routeNo: 'asc' },
      select: {
        id: true,
        ruleCode: true,
        amountBasis: true,
        amountSatang: true,
        status: true,
        steps: { orderBy: { stepNo: 'asc' }, select: { tasks: { orderBy: { createdAt: 'asc' }, select: { id: true, assigneeMemberId: true, status: true, decision: true, channel: true } } } },
      },
    })
    const tasks = routes.flatMap((r) => r.steps.flatMap((s) => s.tasks))
    const members = await prisma.member.findMany({ where: { organizationId, id: { in: tasks.map((t) => t.assigneeMemberId) } }, select: { id: true, employeeCode: true } })
    const codeOf = (id: string) => members.find((m) => m.id === id)?.employeeCode ?? null
    const budgetLineIds = [...new Set(invoice.lines.map((l) => l.poLine.budgetLineId))]
    const after = BigInt(since)
    const own = await prisma.event.findMany({
      where: { organizationId, seq: { gt: after }, aggregateId: { in: [invoice.id, ...(invoice.inboundEmailId ? [invoice.inboundEmailId] : []), ...tasks.map((t) => t.id)] } },
      orderBy: { seq: 'asc' },
      select: { type: true, aggregateType: true, data: true },
    })
    const budget = await prisma.event.findMany({
      where: { organizationId, seq: { gt: after }, aggregateType: 'BudgetLine', aggregateId: { in: budgetLineIds }, data: { path: ['documentId'], equals: invoice.poId } },
      orderBy: { seq: 'asc' },
      select: { type: true, data: true },
    })
    const variance = own.find((e) => e.type === 'invoice.variance_submitted')?.data as { doaRuleCode?: string; netSatang?: string; vatSatang?: string } | undefined
    const ready = own.find((e) => e.type === 'invoice.ready')?.data as { expectedWhtSatang?: string } | undefined
    return {
      id: invoice.id,
      number: invoice.number,
      poId: invoice.po.id,
      poNumber: invoice.po.number,
      status: invoice.status,
      channel: invoice.channel,
      prefill: invoice.prefill,
      matchResult: invoice.matchResult,
      recordedBy: invoice.recordedBy?.employeeCode ?? null,
      inboundEmailId: invoice.inboundEmailId,
      invoiceDate: day(invoice.invoiceDate),
      dueDate: day(invoice.dueDate),
      netSatang: satang(invoice.netSatang),
      statedVatSatang: satang(invoice.statedVatSatang),
      grossSatang: satang(invoice.grossSatang),
      payableSatang: satang(invoice.payableSatang),
      expectedWhtSatang: satang(invoice.expectedWhtSatang),
      lines: invoice.lines.map((l) => ({
        lineNo: l.lineNo,
        quantity: l.quantity.toString(),
        unitPriceSatang: satang(l.unitPriceSatang),
        netSatang: satang(l.netSatang),
        matchStatus: l.matchStatus,
        accountCode: l.accountCode,
        costCenter: l.costCenter?.code ?? null,
        whtIncomeTypeCode: l.whtIncomeTypeCode,
        codingConfirmed: l.codingConfirmedAt !== null,
      })),
      exceptions: invoice.exceptions.map((e) => ({ type: e.type, amountSatang: satang(e.amountSatang), assigneeRole: e.assigneeRole, status: e.status, lineNo: e.invoiceLine?.lineNo ?? null })),
      routes: routes.map((r) => ({
        ruleCode: r.ruleCode,
        amountBasis: r.amountBasis,
        amountSatang: satang(r.amountSatang),
        status: r.status,
        tasks: r.steps.flatMap((s) => s.tasks.map((t) => ({ assignee: codeOf(t.assigneeMemberId), status: t.status, decision: t.decision, channel: t.channel }))),
      })),
      variance: variance ? { doaRuleCode: variance.doaRuleCode ?? null, netSatang: variance.netSatang ?? null, vatSatang: variance.vatSatang ?? null } : null,
      readyExpectedWhtSatang: ready?.expectedWhtSatang ?? null,
      balances: await balances(budgetLineIds),
      events: [...own.map((e) => e.type), ...budget.map((e) => e.type)],
    }
  }

  try {
    switch (command) {
      case 'seq': {
        const last = await prisma.event.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true } })
        return { seq: (last?.seq ?? 0n).toString() }
      }
      case 'po':
        if (!args[0]) throw new Error('po <ref>')
        return await poOf(args[0])
      case 'mail':
        if (!args[0] || !/^\d+$/.test(args[0])) throw new Error('mail <scene>')
        return await mail(args[0])
      case 'invoice':
        if (!args[0] || !args[1] || !args[2]) throw new Error('invoice <supplier> <invoiceNo> <seq>')
        return await invoiceOf(args[0], args[1], args[2])
      default:
        throw new Error(`unknown S8 scene command ${command ?? '(none)'}`)
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
