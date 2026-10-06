import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { InitialPackageForm, type InitialPackageFormProps } from '@/ui/admin-doa/initial-package-form'
import { thaiLocalToIso } from '@/ui/admin-org/thai-time'
import th from '../../messages/th.json'

// FR-DOA-002 AC3 (BR-DOA-19, ADR-042 item 1): with no DOA yet, a draft's page offers the initial package. Its first step
// lists today's holders of the positions the version names, one line each with one edit button — never a page of
// selects (§9.9: no single step of more than 8 fields; one row is edited at a time) — and its second step takes the
// reason and sends. The interactions run in tests/e2e/admin-doa-initial.spec.ts; the service rules are in
// tests/integration/initial-package.test.ts and the page data in tests/integration/admin-org-screens-doa.test.ts.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

const HQ = '0199a1b2-0000-7000-8000-0000000000a1'
const CON = '0199a1b2-0000-7000-8000-0000000000a2'
const base: InitialPackageFormProps = {
  versionId: '0199a1b2-0000-7000-8000-0000000000f1',
  positions: [
    { code: 'CEO', nameTh: 'ประธานเจ้าหน้าที่บริหาร', nameEn: null, scope: 'ORG' },
    { code: 'DM', nameTh: 'ผู้จัดการฝ่าย', nameEn: null, scope: 'DEPARTMENT' },
  ],
  departments: [
    { id: HQ, code: 'HQ', nameTh: 'สำนักงานใหญ่', nameEn: null, depth: 0, root: true },
    { id: CON, code: 'CON', nameTh: 'ฝ่ายก่อสร้าง', nameEn: null, depth: 1, root: false },
  ],
  members: [
    { id: 'm-ceo', nameTh: 'ศักดิ์ชัย ผู้นำ', nameEn: null, employeeCode: 'ceo' },
    { id: 'm-dm', nameTh: 'ดำรง ก่อสร้างไทย', nameEn: null, employeeCode: 'dm_con' },
  ],
  holders: [
    { positionCode: 'CEO', departmentId: HQ, memberId: 'm-ceo' },
    { positionCode: 'DM', departmentId: CON, memberId: 'm-dm' },
  ],
  signatory: { id: 'm-ceo', nameTh: 'ศักดิ์ชัย ผู้นำ', nameEn: null },
  // The page's boundary table, which step 2 asks to tick as checked (FR-DOA-009 AC3)
  boundaryTableId: 'boundaries',
  submit: async () => ({ ok: true, assigneeMemberId: 'm-ceo' }),
}

const render = (props: InitialPackageFormProps) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="th" messages={th} timeZone="Asia/Bangkok">
      <InitialPackageForm {...props} />
    </NextIntlClientProvider>,
  )

describe('[FR-DOA-002/AC3] the initial package form', () => {
  it('starts at step 1 with one line and one edit button per current holder, and says who signs', () => {
    const html = render(base)
    expect(html).toContain('ชุดตั้งต้นจะส่งให้ ศักดิ์ชัย ผู้นำ (ผู้มีอำนาจลงนามตามสัญญา) อนุมัติ')
    expect(html).toMatch(/<li aria-current="step"[^>]*>ขั้นที่ 1 ตรวจรายชื่อผู้ดำรงตำแหน่ง<\/li>/)
    expect(html).toContain('ขั้นที่ 2 ใส่เหตุผลและส่ง')
    expect(html).toContain('แก้ ประธานเจ้าหน้าที่บริหาร (CEO) ของ สำนักงานใหญ่')
    expect(html).toContain('แก้ ผู้จัดการฝ่าย (DM) ของ ฝ่ายก่อสร้าง')
    expect(html).toContain('ดำรง ก่อสร้างไทย')
    // No row of selects: a row is edited on its own, three fields at a time
    expect(html).not.toContain('<select')
    expect(html).toContain('เพิ่มผู้ดำรงตำแหน่ง')
    expect(html).toContain('ถัดไป: ใส่เหตุผลและส่ง')
    // Every position the version names has a holder: nothing missing to point out
    expect(html).not.toContain('ยังไม่มีในรายชื่อ')
  })

  it('with nobody holding a named position yet, says what to add and which positions are missing', () => {
    const html = render({ ...base, holders: [] })
    expect(html).toContain('ยังไม่มีผู้ดำรงตำแหน่งในชุดนี้')
    expect(html).toContain('ตำแหน่งที่ฉบับนี้อ้างถึงแต่ยังไม่มีในรายชื่อ: ประธานเจ้าหน้าที่บริหาร (CEO), ผู้จัดการฝ่าย (DM)')
    expect(html).not.toContain('<select')
  })

  it('without a verified contract signatory it does not name one', () => {
    const html = render({ ...base, signatory: null })
    expect(html).not.toContain('ชุดตั้งต้นจะส่งให้')
  })

  it('a first version without a band edge has no boundary table: the form takes no table to tick and starts the same', () => {
    // The tick sits in step 2 and only when the page shows a table (src/ui/admin-doa/boundary-tick.ts, unit-tested in
    // admin-doa-editor.test.tsx); the service sends such a version without one (tests/integration/doa-editor-boundary.test.ts)
    const html = render({ ...base, boundaryTableId: null })
    expect(html).toMatch(/<li aria-current="step"[^>]*>ขั้นที่ 1 ตรวจรายชื่อผู้ดำรงตำแหน่ง<\/li>/)
    expect(html).toContain('ถัดไป: ใส่เหตุผลและส่ง')
    expect(html).not.toContain('ฉันตรวจตารางผลที่ขอบแล้ว')
  })
})

describe('[FR-DOA-010/AC1] times typed on the proposal form are Thai time', () => {
  it('reads a datetime-local value as Thai time and refuses a day or time that does not exist', () => {
    expect(thaiLocalToIso('2026-11-02T08:30')).toBe('2026-11-02T01:30:00.000Z')
    expect(thaiLocalToIso('2027-01-01T00:00')).toBe('2026-12-31T17:00:00.000Z')
    expect(thaiLocalToIso(' 2026-11-02T08:30 ')).toBe('2026-11-02T01:30:00.000Z')
    for (const bad of ['2026-02-30T08:00', '2026-04-31T09:00', '2026-11-02T24:00', '2026-11-02T08:60', '2026-11-02', '', 'tomorrow']) expect(thaiLocalToIso(bad), bad).toBeNull()
  })
})
