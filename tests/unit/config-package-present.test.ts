import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SANDBOX_CODE, sandboxErrorOf } from '@/ui/admin/sandbox-form'
import {
  CONFIG_INVALID_REASONS,
  CONFIG_ROW_REASONS,
  CONFIG_SECTIONS,
  chosenSections,
  configErrorField,
  configErrorKey,
  createdLinks,
  exportFileName,
  sortedRows,
  toConfigFailure,
  type ConfigErrorKey,
} from '@/ui/admin-config/present'
import { LiffUatBanner } from '@/ui/liff/uat-banner'
import { UatBanner } from '@/ui/shell/uat-banner'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S6-21 on screen (FR-PLT-101 AC1 AC2 · BR-UAT-01 to BR-UAT-04): what /admin/config makes of the answers of the export
// and the import — the refusal's screen-safe parts and its words, the rows that do not fit, the drafts made with the page
// where each is reviewed, the file's name — what the BCS team's sandbox form makes of a refusal, and the trial-system
// banner. The messages are read in both languages: every key the helpers return has its Thai and English words.

type Catalogue = Record<string, unknown>
const at = (catalogue: Catalogue, path: string): unknown => path.split('.').reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Catalogue)[key] : undefined), catalogue)
const both = (path: string) => [at(th, path), at(en, path)]

const ERROR_KEYS: ConfigErrorKey[] = [
  ...CONFIG_INVALID_REASONS.map((r) => `INVALID_${r}` as const),
  'ROWS',
  'SECTIONS',
  'FILE_MISSING',
  'FILE_TOO_LARGE',
  'DATE',
  'DATE_PAST',
  'REASON',
  'LINT',
  'FORBIDDEN',
  'CONFLICT',
  'UNAUTHENTICATED',
  'INTERNAL',
  'FAILED',
]

describe('[FR-PLT-101/AC2] the configuration package page', () => {
  it('keeps the refused rows with a section it knows, and names a reason it has no words for OTHER', () => {
    const failure = toConfigFailure({
      code: 'VALIDATION_FAILED',
      details: {
        reason: 'CONFIG_PACKAGE_ROWS',
        rows: [
          { section: 'WORKFLOW', ref: 'WF-01/R1/DM@NOPE', reason: 'POSITION_NOT_FOUND' },
          { section: 'CATALOG', ref: 'X-1/SUP-9', reason: 'SOMETHING_NEW' },
          { section: 'BUDGET', ref: 'B-1', reason: 'POSITION_NOT_FOUND' },
          'not a row',
        ],
        message: 'never shown',
      },
    })
    expect(failure).toEqual({
      ok: false,
      code: 'VALIDATION_FAILED',
      reason: 'CONFIG_PACKAGE_ROWS',
      rows: [
        { section: 'WORKFLOW', ref: 'WF-01/R1/DM@NOPE', reason: 'POSITION_NOT_FOUND' },
        { section: 'CATALOG', ref: 'X-1/SUP-9', reason: 'OTHER' },
      ],
    })
    expect(configErrorKey(failure)).toBe('ROWS')
  })

  it('says why a file is not a package it imports, under the file field (BR-UAT-03: checksum and schemaVersion)', () => {
    for (const reason of CONFIG_INVALID_REASONS) {
      const key = configErrorKey(toConfigFailure({ code: 'CONFIG_PACKAGE_INVALID', details: { reason } }))
      expect(key).toBe(`INVALID_${reason}`)
      expect(configErrorField(key)).toBe('file')
    }
    expect(configErrorKey({ ok: false, code: 'CONFIG_PACKAGE_INVALID', reason: 'UNHEARD_OF' })).toBe('INVALID_NOT_A_PACKAGE')
    expect(configErrorKey({ ok: false, code: 'CONFIG_PACKAGE_INVALID' })).toBe('INVALID_NOT_A_PACKAGE')
  })

  it('puts a date or a reason the drafts refuse under its field, and a draft that fails the checks here above the form', () => {
    expect(configErrorKey({ ok: false, code: 'VALIDATION_FAILED', field: 'effectiveDate', reason: 'EFFECTIVE_IN_PAST' })).toBe('DATE_PAST')
    expect(configErrorKey({ ok: false, code: 'VALIDATION_FAILED', field: 'effectiveDate', reason: 'DATE' })).toBe('DATE')
    expect(configErrorField('DATE_PAST')).toBe('effectiveDate')
    expect(configErrorKey({ ok: false, code: 'VALIDATION_FAILED', field: 'changeReason' })).toBe('REASON')
    expect(configErrorField('REASON')).toBe('changeReason')
    expect(configErrorKey({ ok: false, code: 'VALIDATION_FAILED', field: 'sections' })).toBe('SECTIONS')
    expect(configErrorKey({ ok: false, code: 'VALIDATION_FAILED', field: 'file', reason: 'TOO_LARGE' })).toBe('FILE_TOO_LARGE')
    for (const code of ['DOA_LINT_FAILED', 'WORKFLOW_LINT_FAILED', 'REVIEWER_NOT_FOUND']) {
      expect(configErrorKey({ ok: false, code })).toBe('LINT')
      expect(configErrorField('LINT')).toBeNull()
    }
    expect(configErrorKey({ ok: false, code: 'FORBIDDEN' })).toBe('FORBIDDEN')
    expect(configErrorKey({ ok: false, code: 'IDEMPOTENCY_CONFLICT' })).toBe('CONFLICT')
    expect(configErrorKey({ ok: false, code: 'INTERNAL', requestId: 'r-1' })).toBe('INTERNAL')
    expect(configErrorKey({ ok: false, code: 'RATE_LIMITED' })).toBe('FAILED')
  })

  it('links every draft an import made to where it is reviewed, the catalogue once with its count (BR-UAT-03: drafts only)', () => {
    const links = createdLinks({
      forms: [{ id: 'f1', code: 'BUY GOODS' }],
      workflows: [{ id: 'w1', code: 'WF-01' }],
      doa: [{ id: 'd1' }],
      catalog: [
        { id: 'c1', code: 'CAT-1' },
        { id: 'c2', code: 'CAT-2' },
      ],
    })
    expect(links).toEqual([
      { section: 'FORMS', key: 'form', values: { code: 'BUY GOODS' }, href: '/admin/request-types/BUY%20GOODS/form' },
      { section: 'WORKFLOW', key: 'workflow', values: { code: 'WF-01' }, href: '/admin/workflows/w1' },
      { section: 'DOA', key: 'doa', values: { n: 1 }, href: '/admin/doa/d1' },
      { section: 'CATALOG', key: 'catalog', values: { count: 2, codes: 'CAT-1, CAT-2' }, href: '/catalog/manage' },
    ])
    expect(createdLinks({ forms: [], workflows: [], doa: [], catalog: [] })).toEqual([])
  })

  it('lists the refused rows in the order of the package, and the ticked sections too', () => {
    expect(
      sortedRows([
        { section: 'CATALOG', ref: 'B', reason: 'SUPPLIER_NOT_FOUND' },
        { section: 'FORMS', ref: 'Z', reason: 'DRAFT_EXISTS' },
        { section: 'CATALOG', ref: 'A', reason: 'CATALOG_CODE_EXISTS' },
      ]).map((r) => `${r.section}:${r.ref}`),
    ).toEqual(['FORMS:Z', 'CATALOG:A', 'CATALOG:B'])
    expect(chosenSections(['CATALOG', 'WORKFLOW', 'NOPE'])).toEqual(['WORKFLOW', 'CATALOG'])
  })

  it('names an exported file by the organization and the day it was exported, from the file itself', () => {
    expect(exportFileName(JSON.stringify({ kind: 'BCS_CONFIG_PACKAGE', organizationCode: 'DEMO', exportedAt: '2026-10-15T03:04:05.000Z' }))).toBe('config-DEMO-2026-10-15.json')
    expect(exportFileName(JSON.stringify({ organizationCode: '../x y', exportedAt: '2026-10-15T00:00:00Z' }))).toBe('config-xy-2026-10-15.json')
    expect(exportFileName('{not json')).toBe('config-package.json')
    expect(exportFileName(JSON.stringify({ organizationCode: 'DEMO' }))).toBe('config-package.json')
  })

  it('has Thai and English words for every section, row reason and refusal', () => {
    for (const s of CONFIG_SECTIONS) for (const path of [`configPackages.sections.${s}.name`, `configPackages.sections.${s}.exportHint`]) expect(both(path).every((v) => typeof v === 'string' && v.length > 0), path).toBe(true)
    for (const r of CONFIG_ROW_REASONS) expect(both(`configPackages.rows.reasons.${r}`).every((v) => typeof v === 'string' && v.length > 0), r).toBe(true)
    for (const k of ERROR_KEYS) expect(both(`configPackages.errors.${k}`).every((v) => typeof v === 'string' && v.length > 0), k).toBe(true)
    for (const k of ['form', 'workflow', 'doa', 'catalog']) expect(both(`configPackages.created.${k}`).every((v) => typeof v === 'string'), k).toBe(true)
    // The page says plainly that an import makes drafts only (BR-UAT-03)
    expect(at(th, 'configPackages.import.draftsOnly')).toContain('สร้างเฉพาะร่าง')
    expect(at(en, 'configPackages.import.draftsOnly')).toContain('drafts only')
  })
})

describe('[FR-PLT-101/AC1] the UAT sandbox on screen', () => {
  it('takes only a code the sandbox command takes', () => {
    for (const ok of ['SIMEC-UAT', 'DEMO_UAT2', 'A1']) expect(SANDBOX_CODE.test(ok), ok).toBe(true)
    for (const bad of ['simec-uat', '-UAT', 'A', 'X'.repeat(41), 'DEMO UAT']) expect(SANDBOX_CODE.test(bad), bad).toBe(false)
  })

  it('says a refusal of the sandbox command under its field or above the form', () => {
    expect(sandboxErrorOf({ ok: false, code: 'VALIDATION_FAILED', field: 'code', reason: 'CODE_TAKEN' })).toEqual({ field: 'code', key: 'CODE_TAKEN' })
    expect(sandboxErrorOf({ ok: false, code: 'VALIDATION_FAILED', reason: 'NOT_PRODUCTION' })).toEqual({ field: null, key: 'NOT_PRODUCTION' })
    expect(sandboxErrorOf({ ok: false, code: 'VALIDATION_FAILED', field: 'code' })).toEqual({ field: 'code', key: 'CODE' })
    expect(sandboxErrorOf({ ok: false, code: 'VALIDATION_FAILED', field: 'contractRef' })).toEqual({ field: 'contractRef', key: 'CONTRACT_REF' })
    expect(sandboxErrorOf({ ok: false, code: 'VALIDATION_FAILED', field: 'reason' })).toEqual({ field: 'reason', key: 'REASON' })
    expect(sandboxErrorOf({ ok: false, code: 'FORBIDDEN' })).toEqual({ field: null, key: 'FORBIDDEN' })
    expect(sandboxErrorOf({ ok: false, code: 'INTERNAL', requestId: 'r' })).toEqual({ field: null, key: 'INTERNAL' })
    for (const key of ['CODE', 'CODE_TAKEN', 'NOT_PRODUCTION', 'CONTRACT_REF', 'REASON', 'INPUT', 'FORBIDDEN', 'NOT_FOUND', 'UNAUTHENTICATED', 'INTERNAL', 'FAILED'])
      expect(both(`platform.tenant.sandbox.errors.${key}`).every((v) => typeof v === 'string' && v.length > 0), key).toBe(true)
  })

  it('draws the trial-system banner as a named region with an icon and its words, on the workspace and on LIFF (BR-UAT-01)', () => {
    expect(at(th, 'uat.banner')).toBe('ระบบทดลอง (UAT) — ข้อมูลในระบบนี้ไม่ใช่ของจริง')
    expect(at(en, 'uat.banner')).toBe('Trial system (UAT) — the data in this system is not real')
    for (const Banner of [UatBanner, LiffUatBanner]) {
      const html = renderToStaticMarkup(createElement(Banner, { text: 'ระบบทดลอง (UAT) — ข้อมูลในระบบนี้ไม่ใช่ของจริง' }))
      expect(html).toContain('role="region"')
      expect(html).toContain('aria-label="ระบบทดลอง (UAT) — ข้อมูลในระบบนี้ไม่ใช่ของจริง"')
      expect(html).toContain('<svg')
      expect(html).toContain('bg-warn-bg')
      // Nothing to close it with
      expect(html).not.toContain('<button')
    }
  })
})
