import { spawnSync } from 'node:child_process'
import { E2E_BASE_URL, e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { checkScreen } from './liff-support'

// S7-14 (FR-AI-304 AC2 AC3 · scene 1 of Demo_Script_P2 with the AI on, fixture mode · ADR-142): the supplier uploads its
// company certificate on a phone; once scanned clean, the Supplier Onboarding Agent reads it (the jobs run by the scene
// script, Inngest is not in e2e) and the form shows the values read beside the fields with "เติมโดย AI โปรดตรวจ"; the
// supplier ticks the ones confirmed one by one, takes the rest together, and the form holds them. No account number is
// read. tests/e2e/portal-apply.spec.ts is the same scene with the AI off (EG-1).

function portalScene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/portal-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`portal scene ${args[0]} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)!) as T
}

// the file the recorded answer of tests/fixtures/ai/SUPPLIER_DOC_READ/<sha256>.json was made for (byte for byte)
const CERTIFICATE = Buffer.from('%PDF-1.7\n% S7-14 e2e: company certificate of RATCHABURI CONSTRUCTION (synthetic)\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')

test.describe('@portal the AI reads the supplier’s document and the supplier checks each value', () => {
  test.describe.configure({ timeout: 240_000 })

  test('[FR-AI-304/AC2] [FR-AI-304/AC3] the company certificate read, the critical values ticked one by one, the rest taken together', async ({ page }, testInfo) => {
    const made = portalScene<{ org: string; organizationId: string; url: string; contactId: string; applicationId: string }>('invite-ai')
    const base = `/portal/${made.org}`
    await page.goto(made.url.replace(/^https?:\/\/[^/]+/, E2E_BASE_URL))
    await page.getByRole('button', { name: 'ส่งรหัสยืนยันให้ฉัน' }).click()
    const { code } = portalScene<{ code: string }>('code', made.contactId)
    await page.getByLabel('รหัสยืนยัน 6 หลัก').fill(code)
    await page.getByRole('button', { name: 'เข้าระบบ' }).click()
    await page.getByRole('button', { name: 'รับทราบ' }).click()
    await expect(page).toHaveURL(new RegExp(`${base}/apply`))

    // the company certificate in step 5
    await page.goto(`${base}/apply?step=documents`)
    const item = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'หนังสือรับรองบริษัท', exact: true }) })
    await item.getByLabel('ไฟล์').setInputFiles({ name: 'หนังสือรับรอง.pdf', mimeType: 'application/pdf', buffer: CERTIFICATE })
    await item.getByLabel('วันที่ออก').fill('2026-10-20')
    await item.getByRole('button', { name: 'ส่ง หนังสือรับรองบริษัท' }).click()
    await expect(page.getByText('ขั้นที่ 5 จาก 6')).toBeVisible()

    // the scan and the reading (jobs file-scan, supplier-document-scanned, supplier-document-ai, ai-agent-run)
    expect(portalScene<{ requested: string; read: string }>('ai-read', `${made.organizationId}:${made.applicationId}`)).toEqual({ requested: 'REQUESTED', read: 'DRAFT' })

    // step 1 shows what the AI read beside the fields
    await page.goto(`${base}/apply?step=company`)
    const panel = page.getByRole('region', { name: 'ค่าที่ AI อ่านจากเอกสารของท่าน' })
    await expect(panel).toBeVisible()
    await expect(panel.getByText('เติมโดย AI โปรดตรวจ').first()).toBeVisible()
    await expect(panel).toContainText('0999998020010')
    await expect(panel).not.toContainText('เลขที่บัญชี')
    await checkScreen(page, testInfo, 'portal-apply-ai')
    for (const label of ['ชื่อ (ไทย)', 'เลขประจำตัวผู้เสียภาษี', 'สาขา', 'ภาษีมูลค่าเพิ่ม']) await panel.getByLabel(new RegExp(`^${label.replace(/[()]/g, '\\$&')}`)).check()
    await panel.getByRole('button', { name: 'ยืนยันค่าที่เหลือทั้งหมด' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'ใช้ค่าที่ AI อ่านแล้ว' })).toBeVisible()
    await expect(page.getByLabel('ที่อยู่ตามทะเบียน')).toHaveValue('99 หมู่ 4 ต.เจดีย์หัก อ.เมือง จ.ราชบุรี 70000')
    await expect(page.getByRole('region', { name: 'ค่าที่ AI อ่านจากเอกสารของท่าน' })).toHaveCount(0)
  })
})
