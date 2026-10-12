import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { changedSince, isDocument, isDocumentsOnly } from '../../scripts/lib/ci-changes'
import { parseVerifyArgs } from '../../scripts/lib/verify-gates'

// P1-03: CI leaves out the e2e gate only for a change of documents, and a newer push cancels the run before it, so
// the 2,000 Actions minutes a month of GitHub Free last. Every other gate of pnpm verify --strict still runs.

const ROOT = path.resolve(import.meta.dirname, '..', '..')

describe('documents only (scripts/lib/ci-changes.ts)', () => {
  it('[FR-PLT-006/AC1] a Markdown file anywhere and anything under docs/ are documents; the input workbooks, code, messages and the workflow are not', () => {
    for (const file of ['spec.md', 'CLAUDE.md', 'docs/reports/p1-demo-ready.md', 'docs/feature-status.yaml', 'docs/decisions/ADR-066.md', '.claude/skills/bcs-lane/SKILL.md', 'docs\\runbooks\\parallel-lanes.md'])
      expect(isDocument(file), file).toBe(true)
    for (const file of ['docs/inputs/BCS_inputs_p1.xlsx', 'docs/inputs/BCS_inputs_v1_demo.xlsx', 'scripts/inputs_p1/make.py', 'src/ui/shell/workspace-shell.tsx', 'messages/src/en/shell.json', '.github/workflows/ci.yml', 'tests/e2e/shell.spec.ts', 'prisma/schema.prisma', 'package.json'])
      expect(isDocument(file), file).toBe(false)
  })

  it('[FR-PLT-006/AC1] one file that is not a document, or no file at all, means the full run', () => {
    expect(isDocumentsOnly(['spec.md', 'docs/feature-status.yaml'])).toBe(true)
    expect(isDocumentsOnly(['spec.md', 'src/app/page.tsx'])).toBe(false)
    expect(isDocumentsOnly(['spec.md', 'docs/inputs/BCS_inputs_p1.xlsx'])).toBe(false)
    expect(isDocumentsOnly([])).toBe(false)
    expect(isDocumentsOnly(['', '  '])).toBe(false)
  })

  it('[FR-PLT-006/AC1] a base that cannot be compared — none, a new branch, not a commit, one git does not have — is not known: null', () => {
    expect(changedSince(undefined)).toBeNull()
    expect(changedSince('')).toBeNull()
    expect(changedSince('0000000000000000000000000000000000000000')).toBeNull()
    expect(changedSince('HEAD~1')).toBeNull()
    expect(changedSince('--output=x')).toBeNull()
    expect(changedSince('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBeNull()
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
    expect(changedSince(head)).toEqual([])
  })
})

describe('pnpm verify --docs-only=<commit>', () => {
  it('[EG-7] takes a commit id and nothing else', () => {
    const names = ['e2e', 'trace']
    expect(parseVerifyArgs(['--strict', '--e2e', '--docs-only=1a2b3c4'], names)).toEqual({ args: { strict: true, e2e: true, only: null, docsOnlySince: '1a2b3c4' } })
    expect(parseVerifyArgs(['--docs-only='], names)).toHaveProperty('error')
    expect(parseVerifyArgs(['--docs-only=HEAD~1'], names)).toHaveProperty('error')
    expect(parseVerifyArgs(['--docs-only=1a2b3c4;rm'], names)).toHaveProperty('error')
  })
})

describe('the CI workflow (.github/workflows/ci.yml)', () => {
  const workflow = parseYaml(readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
    concurrency: { 'cancel-in-progress': unknown }
    permissions: Record<string, string>
    jobs: { verify: { steps: Array<{ id?: string; name?: string; if?: string; run?: string }> } }
  }
  const steps = workflow.jobs.verify.steps
  const verify = steps.find((s) => s.name === 'pnpm verify --strict --e2e')

  it('[FR-PLT-006/AC1] a newer push cancels the run still going on the same branch, main included', () => {
    expect(workflow.concurrency['cancel-in-progress']).toBe(true)
  })

  it('[FR-PLT-006/AC1] every run is pnpm verify --strict --e2e; only a change of documents since the last green main adds --docs-only', () => {
    const changes = steps.find((s) => s.id === 'changes')
    expect(changes?.run).toContain('--status success')
    expect(changes?.run).toContain('scripts/ci-changes.ts')
    expect(workflow.permissions.actions).toBe('read')
    expect(steps.find((s) => s.run?.includes('playwright install'))?.if).toBe("steps.changes.outputs.docs_only != 'true'")
    const commands = (verify?.run ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('pnpm verify'))
    expect(commands).toEqual(['pnpm verify --strict --e2e --docs-only="$BASE"', 'pnpm verify --strict --e2e'])
  })
})
