// Golden integrity (spec §7.0, §15.2, §17.3 "never edit golden expects"):
// every tests/golden/*.yaml (and fixtures/*.yaml) must be byte-identical to its block in spec.md, where the
// block's first line is the comment `# tests/golden/<name>.yaml`. With --strict, all spec blocks must exist.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const strict = process.argv.includes('--strict')

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

function main() {
  const blocks = goldenBlocksFromSpec(readFileSync(path.join(ROOT, 'spec.md'), 'utf8'))
  const dir = path.join(ROOT, 'tests/golden')
  const present = existsSync(dir)
    ? readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .map((f) => `tests/golden/${f.split(path.sep).join('/')}`)
        .filter((f) => f.endsWith('.yaml'))
    : []
  const problems: string[] = []
  for (const file of present) {
    const expected = blocks.get(file)
    if (!expected) {
      problems.push(`${file} ไม่มีบล็อกที่ตรงกันใน spec.md`)
      continue
    }
    const actual = readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n')
    if (actual !== expected) problems.push(`${file} ต่างจากบล็อกใน spec.md`)
  }
  if (strict) for (const file of blocks.keys()) if (!present.includes(file)) problems.push(`${file} ยังไม่มีใน repo (โหมด strict ต้องครบ ${blocks.size} ไฟล์)`)
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.log(`golden ${present.length}/${blocks.size} ไฟล์ตรงกับ spec ทุกไบต์`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main()
