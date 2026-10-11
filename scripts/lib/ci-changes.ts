// Which pushes may leave out the e2e gate in CI (P1-03): a change of documents only. GitHub Free has 2,000 Actions
// minutes a month and the e2e gate takes most of a run's 75 to 100, while a tick or a note in the spec changes nothing
// the browser tests see. Every other gate still runs on such a push (the spec, its generated tests, golden drift and
// feature status read documents). The rule is pure and has tests (tests/unit/ci-changes.test.ts); scripts/ci-changes.ts
// prints it for the workflow, and pnpm verify --docs-only=<base> checks it again before it lets the e2e gate skip.
import { spawnSync } from 'node:child_process'

/** The workbooks the seed and the demo scenes read: data, not documents */
const DATA_UNDER_DOCS = 'docs/inputs/'

/** A Markdown file anywhere, or anything under docs/ but the input workbooks */
export function isDocument(file: string): boolean {
  const p = file.replaceAll('\\', '/')
  if (p.startsWith(DATA_UNDER_DOCS)) return false
  return p.startsWith('docs/') || /\.md$/i.test(p)
}

/** True when the change has at least one file and every file is a document (an empty diff proves nothing) */
export function isDocumentsOnly(files: readonly string[]): boolean {
  const changed = files.map((f) => f.trim()).filter(Boolean)
  return changed.length > 0 && changed.every(isDocument)
}

/**
 * The files changed between <base> and HEAD (git diff base...HEAD), or null when that cannot be known for sure: no
 * base, the all-zero base of a new branch, or a base git does not have (a force push). Null means: run everything.
 */
export function changedSince(base: string | undefined): string[] | null {
  if (!base || !/^[0-9a-f]{7,40}$/i.test(base) || /^0+$/.test(base)) return null
  const diff = spawnSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' })
  return diff.status === 0 ? diff.stdout.split(/\r?\n/).filter(Boolean) : null
}
