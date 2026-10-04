import type { ExpressField, OrgSettings } from '../../src/lib/org-settings'

// TEST FIXTURE — a file layout for tests only, NOT the Express import format. Nobody knows that format until the
// customer's sample import file arrives (OQ-10, P0-10, §7.13 "ห้ามเดารูปแบบไฟล์"), so the demo organization has no
// columns and its export is refused with MAPPING_NOT_SET. Service and screen tests export in this layout instead: every
// value the export can write (EXPRESS_FIELDS) once, under a header of the test's own. Its first column is the vendor
// code, so invoices of suppliers without one are kept out (BR-EXP-04). Pure data: Playwright specs import it too.

/** The test's header of each field, in the order of the test file's columns */
const HEADER_OF_FIELD: Readonly<Record<ExpressField, string>> = {
  expressVendorCode: 'รหัสเจ้าหนี้',
  invoiceNo: 'เลขที่ใบกำกับ',
  invoiceDate: 'วันที่ใบกำกับ',
  supplierCode: 'รหัสผู้ขาย',
  supplierName: 'ชื่อผู้ขาย',
  supplierTaxId: 'เลขประจำตัวผู้เสียภาษี',
  supplierBranch: 'สาขา',
  poNumber: 'เลขที่ใบสั่งซื้อ',
  net: 'ยอดก่อนภาษี',
  vat: 'ภาษีมูลค่าเพิ่ม',
  gross: 'ยอดรวม',
  budgetLineCode: 'บรรทัดงบ',
  costCenterCode: 'ศูนย์ต้นทุน',
  accountCode: 'รหัสบัญชี',
}

const FIELDS = Object.keys(HEADER_OF_FIELD) as ExpressField[]

/** xlsx, UTF-8 with a BOM, Buddhist-era dates, and one column per field (test fixture, not the Express format) */
export const TEST_EXPRESS_LAYOUT: OrgSettings['express'] = {
  fileType: 'xlsx',
  encoding: 'UTF-8-BOM',
  dateFormat: 'BE',
  mapping: FIELDS.map((field) => ({ header: HEADER_OF_FIELD[field], field })),
}

/** The header row of a file in the test layout */
export const TEST_EXPRESS_HEADERS: readonly string[] = TEST_EXPRESS_LAYOUT.mapping.map((c) => c.header)

/** Where `field` sits in a row of a file in the test layout */
export function testExpressColumn(field: ExpressField): number {
  return FIELDS.indexOf(field)
}

/** A row of a file in the test layout, from its value of every field (texts, or matchers such as expect.any(String)) */
export function testExpressRow(values: Readonly<Record<ExpressField, unknown>>): unknown[] {
  return TEST_EXPRESS_LAYOUT.mapping.map((c) => values[c.field])
}
