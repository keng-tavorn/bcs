import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { parse } from 'yaml'
import { renderValue } from '../../../src/core/ai-checks/text'
import { th } from '../demo/support'
import { expect } from '../fixtures'
import { script } from './support'

// Steps the AI scenes of phase 1 share (scenes 12, 13 and 14 · S13 · FR-AI-301 FR-AI-302 FR-AI-303 FR-AI-307 FR-AI-309):
// the scene script ./scripts/s13.ts, the documents of sheet DocSamples as files, the request types' forms as the seed
// publishes them (prisma/seed/forms.yaml), the words of the AI boxes (messages/th.json) and the ⌘K question. Not a test
// file: the p1demo project runs only *.spec.ts.

const ROOT = path.resolve(import.meta.dirname, '../../..')

/** ./scripts/s13.ts: plays the AI jobs of the e2e app (no Inngest) and reads what the database says */
export const s13 = <T>(...args: string[]): T => script<T>('scripts/s13.ts', ...args)

/**
 * Waits until the screen's start call made the AI action the job will answer: the screen says "กำลังอ่านเอกสาร" before
 * the call returns (src/ui/ai/use-ai-read.ts), so the played job could otherwise find nothing PENDING yet
 */
export async function startedAiAction(scene: number, purpose: 'INTAKE' | 'QUOTATION_READ') {
  await expect
    .poll(() => s13<{ pending: number }>('pending', String(scene), purpose).pending, { message: `the ${purpose} action the screen started`, timeout: 30_000 })
    .toBe(1)
}

// ---------- the documents of sheet DocSamples ----------

interface ManifestFile {
  readonly id: string
  readonly file: string
  readonly mediaType: string
  readonly sha256: string
  readonly purpose: string
}

/**
 * The file of a document of sheet DocSamples as the evaluation set made it (tests/fixtures/ai-docs/manifest.json), under
 * the name the scene uploads it with. Its bytes must still be the ones the recorded answers are keyed by (their sha256).
 */
export function docSampleFile(sampleId: string, name: string): { readonly name: string; readonly mimeType: string; readonly buffer: Buffer; readonly sha256: string; readonly purpose: string } {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/ai-docs/manifest.json'), 'utf8')) as { files: ManifestFile[] }
  const entry = manifest.files.find((f) => f.id === sampleId)
  if (!entry) throw new Error(`tests/fixtures/ai-docs/manifest.json has no ${sampleId}`)
  const buffer = readFileSync(path.join(ROOT, 'tests/fixtures/ai-docs', entry.file))
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  if (sha256 !== entry.sha256) throw new Error(`${entry.file} is not the file the manifest lists (sha256 ${sha256}): its recorded answers no longer match`)
  return { name, mimeType: entry.mediaType, buffer, sha256, purpose: entry.purpose }
}

/** Whether a recorded answer of that purpose exists for the file (tests/fixtures/ai/<purpose>/<sha256>.json) */
export function recordedAnswerOf(purpose: string, sha256: string): { readonly promptVersion: string; readonly model: string } | null {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/ai', purpose, `${sha256}.json`), 'utf8')) as { promptVersion: string; model: string }
  } catch {
    return null
  }
}

// ---------- the forms the seed publishes ----------

interface FormField {
  readonly id: string
  readonly type: string
  readonly label: { readonly th: string }
  readonly optionLabels?: Readonly<Record<string, { readonly th: string }>>
}
interface FormRule {
  readonly id: string
  readonly when?: { readonly field?: string; readonly op?: string; readonly value?: string }
  readonly require?: unknown
}
export interface SeedForm {
  readonly fields: ReadonlyMap<string, FormField>
  readonly rules: readonly FormRule[]
}

/** The form of a request type as prisma/seed/forms.yaml gives it to every organization of the seed */
export function seedFormOf(requestType: string): SeedForm {
  const forms = (parse(readFileSync(path.join(ROOT, 'prisma/seed/forms.yaml'), 'utf8')) as { forms: Record<string, { fields?: unknown[]; rules?: FormRule[] }> }).forms
  const form = forms[requestType]
  if (!form) throw new Error(`prisma/seed/forms.yaml has no form of ${requestType}`)
  const fields = ((form.fields ?? []) as unknown[]).flat(2) as FormField[]
  return { fields: new Map(fields.map((f) => [f.id, f])), rules: form.rules ?? [] }
}

// ---------- the words of the AI boxes ----------

/** The text before a message's first argument: "ยืนยันค่าที่เหลือทั้งหมด ({count} ช่อง)" → "ยืนยันค่าที่เหลือทั้งหมด" */
export const leadOf = (key: string) => th(key).split(/[({]/)[0]!.trim()

/** What the Intake box calls a value it filled (src/ui/request-form/intake-ai.tsx labelOf) */
export function intakeFieldLabel(path: string): string {
  const line = /^lines\.(\d+)\.(description|quantity|uom|unitPrice)$/.exec(path)
  if (line) return th(`aiAssist.intake.fields.line.${line[2]!}`, { n: Number(line[1]) + 1 })
  return th(`aiAssist.intake.fields.${path}`)
}

/**
 * Confirms the values that wait one by one, each by its own box (BR-AI-16), and then the others together with the
 * button the person presses; the box then says every value is confirmed (FR-AI-303 AC1, FR-AI-302 AC1)
 */
export async function confirmAiValues(box: Locator, oneByOne: readonly string[]) {
  await expect(box.getByText(th('aiAssist.badge'), { exact: true })).toBeVisible()
  await expect(box.getByText(th('aiAssist.mustConfirm'), { exact: true })).toHaveCount(oneByOne.length)
  for (const label of oneByOne) {
    const tick = box.getByRole('checkbox', { name: th('aiAssist.confirmField', { field: label }), exact: true })
    await expect(tick).not.toBeChecked()
    await tick.click()
    await expect(tick).toBeChecked()
  }
  const rest = box.getByRole('button', { name: new RegExp(`^${leadOf('aiAssist.confirmRest')}`) })
  if ((await rest.count()) > 0 && (await rest.isEnabled())) await rest.click()
  await expect(box.getByRole('status').filter({ hasText: th('aiAssist.allConfirmed') })).toBeVisible()
}

/** A value of money in an input as the form may write it, with or without thousands separators ("129,684.00") */
export function moneyValue(satang: bigint): RegExp {
  const whole = (satang / 100n).toLocaleString('en-US').replace(/,/g, ',?')
  return new RegExp(`^${whole}\\.${String(satang % 100n).padStart(2, '0')}$`)
}

/** A share in basis points as BCS AI's answers write it (renderValue: 711 → "7.11%") */
export const bpText = (bp: number) => renderValue({ kind: 'bp', value: bp })

/** A day plus some days, YYYY-MM-DD (calendar days) */
export function addDays(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`)
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

// ---------- ⌘K "ถาม BCS AI" ----------

/** Asks BCS AI from the search of the shell (⌘K): the question's own row, then the chat sheet it opens (FR-AI-309 AC2) */
export async function askBcsAi(page: Page, question: string): Promise<Locator> {
  await page.getByRole('button', { name: th('shell.search.trigger'), exact: true }).first().click()
  await page.getByRole('combobox').fill(question)
  await page.getByRole('option', { name: th('aiAssist.ask.paletteRow', { question }) }).click()
  const sheet = page.getByRole('dialog', { name: th('aiAssist.ask.title') })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText(question, { exact: true })).toBeVisible()
  return sheet
}
