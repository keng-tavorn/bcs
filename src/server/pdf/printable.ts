import { formatSatang } from '@/core/money/format'
import { lineNet, parseQuantity } from '@/core/money/math'
import { formatQuantity } from '@/core/receiving'
import { formatThaiDate, formatThaiDateTime } from '@/core/thai'
import { bahtText } from '@/core/thai/baht-text'
import type { TenantTx } from '@/server/db/tenant'

// What a printed PR or PO shows (spec FR-PLT-009 AC1 AC2; OQ-25 default: the approval section is data — the name,
// position, date-time, channel and DOA reference of every approver — without signatures). Everything is formatted
// here: Buddhist-era dates (BR-DATE-01), amounts with two decimals (§9.9), the total in words (BR-THAI-01); the
// renderer only lays the document out on A4.

export interface PrintableDocument {
  readonly kind: 'PR' | 'PO'
  readonly titleTh: string
  readonly titleEn: string
  readonly organization: { readonly name: string; readonly address: string; readonly taxLine: string }
  readonly number: string
  readonly dateText: string
  /** PO: the supplier; PR: the requester and the department */
  readonly counterparty: { readonly label: string; readonly name: string; readonly lines: readonly string[] }
  readonly meta: ReadonlyArray<{ readonly label: string; readonly value: string }>
  readonly amountHeader: string
  readonly lines: ReadonlyArray<{ readonly no: number; readonly description: string; readonly quantity: string; readonly uom: string; readonly unitPrice: string; readonly amount: string }>
  readonly totals: { readonly net: string; readonly vatLabel: string; readonly vat: string; readonly gross: string; readonly grossText: string }
  readonly approvals: ReadonlyArray<{ readonly name: string; readonly position: string; readonly atText: string; readonly channel: string; readonly doaRef: string }>
  readonly note: string | null
  readonly footer: string
}

const HEAD_OFFICE = '00000'
const PERCENT_BP = 100

/**
 * The channel of an approval as printed; the two LINE channels and the two connected ones (tier 4) in the timeline's words
 * (messages/src/th/timeline.json)
 */
const CHANNEL_TH: Readonly<Record<string, string>> = {
  WEB: 'เว็บ',
  LIFF: 'หน้าจอใน LINE',
  LINE_CHAT: 'แชท LINE',
  PWA: 'แอปบนมือถือ',
  EMAIL: 'ลิงก์ในอีเมล',
  PORTAL: 'พอร์ทัล',
  SYSTEM: 'ระบบ',
  API: 'ระบบอื่นที่เชื่อมต่อ',
  MCP: 'ผู้ช่วย AI ที่เชื่อมต่อ',
}

/** "2000.0000" → "2,000" · "2.5000" → "2.5" */
function quantityText(quantity: { toString(): string }): string {
  const [whole, fraction] = formatQuantity(parseQuantity(quantity.toString())).split('.')
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''}`
}

/** 700 → "ภาษีมูลค่าเพิ่ม 7%" · 750 → "ภาษีมูลค่าเพิ่ม 7.5%" */
function vatLabel(rateBp: number | null): string {
  if (rateBp === null) return 'ภาษีมูลค่าเพิ่ม'
  const whole = Math.trunc(rateBp / PERCENT_BP)
  const fraction = String(rateBp % PERCENT_BP).padStart(2, '0').replace(/0+$/, '')
  return `ภาษีมูลค่าเพิ่ม ${whole}${fraction ? `.${fraction}` : ''}%`
}

async function organizationOf(tx: TenantTx, organizationId: string) {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { legalNameTh: true, taxId: true, branchCode: true, address: true } })
  return {
    name: org.legalNameTh,
    address: org.address ?? '',
    taxLine: `เลขประจำตัวผู้เสียภาษี ${org.taxId} · ${org.branchCode === HEAD_OFFICE ? 'สำนักงานใหญ่' : `สาขา ${org.branchCode}`}`,
  }
}

/** Every approval of the subject's latest route, in the order they were given (FR-PLT-009 AC2) */
async function approvalsOf(tx: TenantTx, subjectType: 'REQUEST' | 'PURCHASE_ORDER', subjectId: string): Promise<PrintableDocument['approvals']> {
  const route = await tx.approvalRoute.findFirst({
    where: { subjectType, subjectId },
    orderBy: { routeNo: 'desc' },
    select: { ruleCode: true, doaVersion: { select: { code: true, versionNo: true } }, steps: { select: { tasks: { where: { decision: 'APPROVE' }, select: { decidedAt: true, channel: true, resolvedFrom: true, decidedBy: { select: { displayNameTh: true } }, principal: { select: { displayNameTh: true } } } } } } },
  })
  if (!route) return []
  const tasks = route.steps.flatMap((s) => s.tasks).filter((t) => t.decidedAt && t.decidedBy)
  tasks.sort((a, b) => a.decidedAt!.getTime() - b.decidedAt!.getTime())
  const positions = await positionNames(
    tx,
    tasks.map((t) => t.resolvedFrom),
  )
  const doaRef = `${route.doaVersion.code} ฉบับ ${route.doaVersion.versionNo} ข้อ ${route.ruleCode}`
  return tasks.map((t) => ({
    name: t.principal ? `${t.decidedBy!.displayNameTh} (ทำแทน ${t.principal.displayNameTh})` : t.decidedBy!.displayNameTh,
    position: positions(t.resolvedFrom),
    atText: formatThaiDateTime(t.decidedAt!),
    channel: (t.channel && CHANNEL_TH[t.channel]) ?? '—',
    doaRef,
  }))
}

/** "POSITION:VP@OPS" → "รองประธานฝ่ายปฏิบัติการ · ฝ่ายปฏิบัติการ"; a named member or anything else → "—" */
async function positionNames(tx: TenantTx, sources: readonly string[]): Promise<(source: string) => string> {
  const parsed = sources.map((s) => /^POSITION:([^@]+)@(.+)$/.exec(s)).filter((m): m is RegExpExecArray => m !== null)
  const [positions, departments] = await Promise.all([
    tx.position.findMany({ where: { code: { in: parsed.map((m) => m[1]!) } }, select: { code: true, nameTh: true } }),
    tx.department.findMany({ where: { code: { in: parsed.map((m) => m[2]!) } }, select: { code: true, nameTh: true } }),
  ])
  return (source) => {
    const m = /^POSITION:([^@]+)@(.+)$/.exec(source)
    if (!m) return '—'
    const position = positions.find((p) => p.code === m[1])?.nameTh ?? m[1]!
    const department = departments.find((d) => d.code === m[2])?.nameTh
    return department ? `${position} · ${department}` : position
  }
}

/** A purchase order as printed and sent to the supplier (FR-PLT-009, FR-P2P-005 AC1) */
export async function printablePurchaseOrder(tx: TenantTx, organizationId: string, poId: string, printedAt: Date): Promise<PrintableDocument> {
  const po = await tx.purchaseOrder.findUniqueOrThrow({
    where: { id: poId },
    include: {
      supplier: { select: { nameTh: true, taxId: true, branchCode: true, address: true } },
      deliverySite: { select: { nameTh: true, address: true } },
      lines: { orderBy: { lineNo: 'asc' }, include: { sources: { select: { requestLine: { select: { request: { select: { number: true } } } } } } } },
    },
  })
  const prNumbers = [...new Set(po.lines.flatMap((l) => l.sources.map((s) => s.requestLine.request.number)).filter((n): n is string => !!n))].sort()
  const number = po.number ?? 'ร่าง'
  const supplierTax = po.supplier.taxId ? [`เลขประจำตัวผู้เสียภาษี ${po.supplier.taxId} · ${po.supplier.branchCode === HEAD_OFFICE ? 'สำนักงานใหญ่' : `สาขา ${po.supplier.branchCode}`}`] : []
  return {
    kind: 'PO',
    titleTh: 'ใบสั่งซื้อ',
    titleEn: 'Purchase Order',
    organization: await organizationOf(tx, organizationId),
    number,
    dateText: formatThaiDate(po.approvedAt ?? po.submittedAt ?? po.createdAt),
    counterparty: { label: 'ผู้ขาย', name: po.supplier.nameTh, lines: [...(po.supplier.address ? [po.supplier.address] : []), ...supplierTax] },
    meta: [
      ...(po.deliverySite ? [{ label: 'สถานที่ส่ง', value: [po.deliverySite.nameTh, po.deliverySite.address].filter(Boolean).join(' · ') }] : []),
      ...(po.paymentTermDays !== null ? [{ label: 'เงื่อนไขการชำระเงิน', value: po.paymentTermDays === 0 ? 'ชำระเมื่อส่งของ' : `เครดิต ${po.paymentTermDays} วัน` }] : []),
      ...(prNumbers.length ? [{ label: 'อ้างอิงใบขอซื้อ', value: prNumbers.join(', ') }] : []),
      ...(po.urgency === 'URGENT' ? [{ label: 'ความเร่งด่วน', value: 'ด่วน' }] : []),
      // S8-10 (ADR-125, BR-POC-04): a changed PO prints which revision it is
      ...(po.revisionNo > 0 ? [{ label: 'ฉบับแก้ไข', value: `แก้ไขครั้งที่ ${po.revisionNo}` }] : []),
    ],
    amountHeader: 'จำนวนเงิน',
    lines: po.lines.map((l) => ({ no: l.lineNo, description: l.description, quantity: quantityText(l.quantity), uom: l.uom, unitPrice: formatSatang(l.unitPriceSatang), amount: formatSatang(l.netSatang) })),
    totals: { net: formatSatang(po.netSatang), vatLabel: vatLabel(po.vatRateBp), vat: formatSatang(po.vatSatang), gross: formatSatang(po.grossSatang), grossText: bahtText(po.grossSatang) },
    approvals: await approvalsOf(tx, 'PURCHASE_ORDER', po.id),
    note: po.notesToSupplier,
    footer: `พิมพ์จากระบบ BCS · ${number} · ${formatThaiDateTime(printedAt)}`,
  }
}

/** A purchase request as printed (FR-PLT-009 AC1 AC2) */
export async function printableRequest(tx: TenantTx, organizationId: string, requestId: string, printedAt: Date): Promise<PrintableDocument> {
  const request = await tx.request.findUniqueOrThrow({
    where: { id: requestId },
    include: {
      lines: { orderBy: { lineNo: 'asc' } },
      requester: { select: { displayNameTh: true } },
      chargedDepartment: { select: { nameTh: true } },
      budgetLine: { select: { code: true, nameTh: true } },
      deliverySite: { select: { nameTh: true } },
      requestType: { select: { nameTh: true } },
    },
  })
  const number = request.number ?? 'ร่าง'
  // A request priced with VAT shows the prices as typed; the totals still split before VAT and VAT (BR-VAT-02)
  const withVat = request.priceIncludesVat
  return {
    kind: 'PR',
    titleTh: 'ใบขอซื้อ',
    titleEn: 'Purchase Request',
    organization: await organizationOf(tx, organizationId),
    number,
    dateText: formatThaiDate(request.submittedAt ?? request.createdAt),
    counterparty: {
      label: 'ผู้ขอซื้อ',
      name: request.requester.displayNameTh,
      lines: [request.chargedDepartment.nameTh, ...(request.budgetLine ? [`งบประมาณ ${request.budgetLine.code} ${request.budgetLine.nameTh}`] : [])],
    },
    meta: [
      { label: 'เรื่อง', value: request.title },
      { label: 'ประเภทคำขอ', value: request.requestType.nameTh },
      ...(request.neededBy ? [{ label: 'ต้องการใช้', value: formatThaiDate(request.neededBy) }] : []),
      ...(request.deliverySite ? [{ label: 'สถานที่ส่ง', value: request.deliverySite.nameTh }] : []),
      ...(request.urgency === 'URGENT' ? [{ label: 'ความเร่งด่วน', value: 'ด่วน' }] : []),
    ],
    amountHeader: withVat ? 'จำนวนเงิน (รวม VAT)' : 'จำนวนเงิน',
    lines: request.lines.map((l) => ({
      no: l.lineNo,
      description: l.description,
      quantity: quantityText(l.quantity),
      uom: l.uom,
      unitPrice: formatSatang(l.unitPriceSatang),
      amount: formatSatang(withVat ? lineNet(l.quantity.toString(), l.unitPriceSatang) : l.netSatang),
    })),
    totals: { net: formatSatang(request.netSatang), vatLabel: vatLabel(request.vatRateBp), vat: formatSatang(request.vatSatang), gross: formatSatang(request.grossSatang), grossText: bahtText(request.grossSatang) },
    approvals: await approvalsOf(tx, 'REQUEST', request.id),
    note: withVat ? 'ราคาต่อหน่วยรวมภาษีมูลค่าเพิ่มแล้ว' : null,
    footer: `พิมพ์จากระบบ BCS · ${number} · ${formatThaiDateTime(printedAt)}`,
  }
}
