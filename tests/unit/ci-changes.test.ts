import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  })

  // A dozen git processes in a temporary repository take longer than the 5 s default on a busy Windows machine
  it('[FR-PLT-006/AC1] code moved into docs/ and code not committed yet both count as code', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'bcs-ci-changes-'))
    const git = (...args: string[]) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' })
      expect(r.status, r.stderr).toBe(0)
      return r.stdout.trim()
    }
    const write = (file: string, text: string) => {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
      writeFileSync(path.join(repo, file), text)
    }
    try {
      git('init', '-q')
      write('src/a.ts', 'export const a = 1')
      write('docs/notes.md', 'notes')
      git('add', '.')
      git('commit', '-q', '-m', 'base')
      const base = git('rev-parse', 'HEAD')
      // A rename is read as the deleted code file and the new document, so it is not documents only
      git('mv', 'src/a.ts', 'docs/a.ts')
      git('commit', '-q', '-m', 'move')
      expect(changedSince(base, repo)?.sort()).toEqual(['docs/a.ts', 'src/a.ts'])
      expect(isDocumentsOnly(changedSince(base, repo)!)).toBe(false)

      // A documents-only commit, then work not committed yet: an edited code file and a new one
      const moved = git('rev-parse', 'HEAD')
      write('docs/notes.md', 'more notes')
      git('commit', '-q', '-am', 'notes')
      expect(changedSince(moved, repo)).toEqual(['docs/notes.md'])
      write('docs/a.ts', 'export const a = 2')
      write('src/new.ts', 'export {}')
      expect(changedSince(moved, repo)?.sort()).toEqual(['docs/a.ts', 'docs/notes.md', 'src/new.ts'])
      expect(isDocumentsOnly(changedSince(moved, repo)!)).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 30_000)
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
    concurrency?: unknown
    permissions: Record<string, string>
    jobs: Record<'verify' | 'deploy-staging', { concurrency?: { group: string; 'cancel-in-progress': unknown }; steps: Array<{ id?: string; name?: string; if?: string; run?: string }> }>
  }
  const steps = workflow.jobs.verify.steps
  const verify = steps.find((s) => s.name === 'pnpm verify --strict --e2e')

  it('[FR-PLT-006/AC1] one run at a time per branch: on main the run under way finishes and only the newest push waits; a deploy under way is never cut', () => {
    // At the workflow level a cancel would stop deploy-staging too, while Vercel's build goes on migrating staging
    expect(workflow.concurrency).toBeUndefined()
    // A pull request's newer commit replaces its run under way; on main the newer push waits (GitHub keeps only the newest
    // waiting run), so a full run finishes even while several chats push
    expect(workflow.jobs.verify.concurrency).toEqual({ group: 'ci-verify-${{ github.ref }}', 'cancel-in-progress': "${{ github.event_name == 'pull_request' }}" })
    expect(workflow.jobs['deploy-staging'].concurrency).toEqual({ group: 'deploy-staging', 'cancel-in-progress': false })
  })

  it('[FR-PLT-006/AC2] the staging check waits until /api/health answers ok with this very commit, not just any answer', () => {
    const health = workflow.jobs['deploy-staging'].steps.find((s) => s.name?.startsWith('/api/health'))?.run ?? ''
    // One answer from the previous deployment is not a failure: the domain moves over a little after the deploy
    expect(health).toContain('seq 1 30')
    expect(health).toContain("grep -q '\"status\":\"ok\"' && echo \"$body\" | grep -q '\"commit\":\"${{ github.sha }}\"'; then")
    expect(health.trim().endsWith('exit 1')).toBe(true)
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
