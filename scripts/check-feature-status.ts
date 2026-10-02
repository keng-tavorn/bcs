// Validates docs/feature-status.yaml against spec.md (spec §15.5 gate 10, §15.6).
// - every tier-1 FR in spec §8 has an entry and every entry is a real FR
// - status/step are valid; done/verified/live need evidence files that exist; verified/live need verifiedBy
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'

const ROOT = path.resolve(import.meta.dirname, '..')
const STATUSES = new Set(['planned', 'in_progress', 'done', 'verified', 'live'])

interface Feature {
  status?: string
  step?: string
  evidence?: string[]
  verifiedBy?: string | null
  notes?: string
}

const spec = readFileSync(path.join(ROOT, 'spec.md'), 'utf8')
const definedFrs = new Set<string>()
let inCode = false
for (const line of spec.split(/\r?\n/)) {
  if (line.trim().startsWith('```')) {
    inCode = !inCode
    continue
  }
  const m = !inCode && /^#{2,5} (FR-[A-Z0-9]+-\d{3})\b/.exec(line)
  if (m) definedFrs.add(m[1]!)
}
const tier1 = [...definedFrs].filter((id) => /^FR-[A-Z0-9]+-0\d\d$/.test(id))

const doc = parse(readFileSync(path.join(ROOT, 'docs/feature-status.yaml'), 'utf8')) as {
  updatedAt?: string
  features?: Record<string, Feature>
}
const problems: string[] = []
if (!/^\d{4}-\d{2}-\d{2}$/.test(String(doc.updatedAt ?? ''))) problems.push('updatedAt ต้องเป็นวันที่ YYYY-MM-DD')
const features = doc.features ?? {}

for (const id of tier1) if (!features[id]) problems.push(`${id} ไม่มีใน feature-status`)
for (const [id, f] of Object.entries(features)) {
  if (!definedFrs.has(id)) problems.push(`${id} ไม่มีใน spec.md`)
  if (!STATUSES.has(f.status ?? '')) problems.push(`${id}: status "${f.status}" ไม่ถูกต้อง`)
  if (!/^S([1-9]|1[0-5])$/.test(f.step ?? '')) problems.push(`${id}: step "${f.step}" ไม่ถูกต้อง`)
  if (['done', 'verified', 'live'].includes(f.status ?? '')) {
    if (!f.evidence?.length) problems.push(`${id}: status ${f.status} ต้องมี evidence`)
    for (const e of f.evidence ?? []) if (!existsSync(path.join(ROOT, e))) problems.push(`${id}: evidence ${e} ไม่มีอยู่จริง`)
  }
  if (['verified', 'live'].includes(f.status ?? '') && !f.verifiedBy) problems.push(`${id}: status ${f.status} ต้องระบุ verifiedBy (§16.2 ข้อ 5)`)
}

if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
const count = (s: string) => Object.values(features).filter((f) => f.status === s).length
console.log(`${Object.keys(features).length} FR · done ${count('done')} · in_progress ${count('in_progress')} · planned ${count('planned')}`)
