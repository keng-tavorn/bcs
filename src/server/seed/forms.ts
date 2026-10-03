import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { FormSchemaJson } from '@/server/forms/schema'

// Forms of the demo request types (spec §7.9, BR-FORM-04 to BR-FORM-06): prisma/seed/forms.yaml, in the JSON shape
// ORG_ADMIN imports (FR-ADM-005). Lists may hold the shared parts (YAML aliases), so one level of nesting is flattened.

export const SEED_FORMS_PATH = path.resolve(import.meta.dirname, '../../../prisma/seed/forms.yaml')

const FormsFile = z.strictObject({ shared: z.unknown().optional(), forms: z.record(z.string(), z.record(z.string(), z.unknown())) })

export type SeedForm = z.output<typeof FormSchemaJson>

export function loadSeedForms(file: string = SEED_FORMS_PATH): Map<string, SeedForm> {
  const raw = FormsFile.parse(parseYaml(readFileSync(file, 'utf8')))
  const forms = new Map<string, SeedForm>()
  for (const [code, form] of Object.entries(raw.forms)) {
    const flat = Object.fromEntries(Object.entries(form).map(([key, value]) => [key, Array.isArray(value) ? value.flat() : value]))
    const parsed = FormSchemaJson.safeParse(flat)
    if (!parsed.success) throw new Error(`forms.yaml: the form of ${code} is not valid: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`)
    forms.set(code, parsed.data)
  }
  return forms
}
