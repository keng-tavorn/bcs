// Golden integrity (spec §7.0, §15.2, §17.3 "never edit golden expects"):
// every tests/golden/*.yaml (and fixtures/*.yaml) must be byte-identical to its block in spec.md, where the
// block's first line is the comment `# tests/golden/<name>.yaml`. With --strict (finish line A), every spec block
// must also exist in the repo, except the files in GOLDEN_STRICT_OPTIONAL.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

// Blocks that finish line A does not need, with the reason printed in strict mode
export const GOLDEN_STRICT_OPTIONAL: Record<string, string> = {
  'tests/golden/wht.yaml': 'ตัวอย่างชั้น 2 (status: preview-T2) engine มาใน sub-spec S8–S9 (§7.14)',
  'tests/golden/grni.yaml': 'รายงาน GRNI อยู่ในข้อ S4-18 ที่เป็น [go-live] ไม่ใช่ [demo] (§7.16)',
}

export function goldenBlocksFromSpec(specText: string): Map<string, string> {
  const blocks = new Map<string, string>()
  const lines = specText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (!/^```ya?ml\s*$/.test(lines[i]!.trim())) continue
    const body: string[] = []
    let j = i + 1
    while (j < lines.length && lines[j]!.trim() !== '```') body.push(lines[j++]!)
    const m = /^#\s*(tests\/golden\/\S+\.yaml)/.exec(body[0] ?? '')
    if (m) blocks.set(m[1]!, body.join('\n') + '\n')
    i = j
  }
  return blocks
}

/** Problems (FAIL) and notes for the golden files present in the repo compared with the spec blocks. */
export function goldenDriftProblems(input: {
  blocks: Map<string, string>
  present: readonly string[]
  readFile: (file: string) => string
  strict: boolean
}): { problems: string[]; notes: string[] } {
  const problems: string[] = []
  const notes: string[] = []
  for (const file of input.present) {
    const expected = input.blocks.get(file)
    if (!expected) {
      problems.push(`${file} ไม่มีบล็อกที่ตรงกันใน spec.md`)
      continue
    }
    if (input.readFile(file).replace(/\r\n/g, '\n') !== expected) problems.push(`${file} ต่างจากบล็อกใน spec.md`)
  }
  if (input.strict) {
    for (const file of input.blocks.keys()) {
      if (input.present.includes(file)) continue
      const reason = GOLDEN_STRICT_OPTIONAL[file]
      if (reason) notes.push(`${file} ยังไม่มี — อนุญาตใน strict: ${reason}`)
      else problems.push(`${file} ยังไม่มีใน repo (โหมด strict ต้องมีทุกไฟล์ที่เส้นชัย A ใช้)`)
    }
  }
  return { problems, notes }
}

function main() {
  const strict = process.argv.includes('--strict')
  const blocks = goldenBlocksFromSpec(readFileSync(path.join(ROOT, 'spec.md'), 'utf8'))
  const dir = path.join(ROOT, 'tests/golden')
  const present = existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => path.relative(ROOT, path.join(d.parentPath, d.name)).split(path.sep).join('/'))
        .filter((f) => f.endsWith('.yaml'))
    : []
  const { problems, notes } = goldenDriftProblems({ blocks, present, readFile: (f) => readFileSync(path.join(ROOT, f), 'utf8'), strict })
  for (const note of notes) console.log(note)
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  const required = strict ? [...blocks.keys()].filter((f) => !GOLDEN_STRICT_OPTIONAL[f]).length : blocks.size
  console.log(
    strict
      ? `golden ${present.length} ไฟล์ตรงกับ spec ทุกไบต์ · ครบ ${required} ไฟล์ที่เส้นชัย A ต้องใช้`
      : `golden ${present.length}/${blocks.size} ไฟล์ที่มีอยู่ตรงกับ spec ทุกไบต์ (ยังไม่ตรวจว่าครบ — ใช้ --strict)`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main()
