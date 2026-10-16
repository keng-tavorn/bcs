// S17-09 (BR-APP-02, FR-PLT-301 AC10): the BCS Go app is the web, so wherever code lists or compares channels and
// lets WEB through, it lets APP through too — otherwise work done in the app is refused or its Event cannot be
// written (the policy decision of src/server/services/approvals/policy-decide.ts did exactly that before S17-09). This
// test reads every source file of src and fails on a channel list, union or comparison that takes WEB without APP.
// A place that rightly takes WEB alone is named below with the reason.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { CHANNELS } from '@/server/context'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const SRC = path.join(ROOT, 'src')

// Places that take WEB without APP on purpose (file → reason). Each must still hold such a place, so a fixed or moved
// one is taken off the list instead of staying as a blank exception.
const WEB_ONLY: Readonly<Record<string, string>> = {
  'src/server/auth/session.ts': 'SessionChannel is the kind of page that asks (web, LIFF, PWA); ctxFromSession records APP for a web page asked from the app',
  'src/server/auth/auth-events.ts': 'sign-in events: the app signs in on the web sign-in page, and the work done after records APP',
  'src/server/seed/sheets.ts': 'the channels a decided request of the input workbook history names; the synthetic history has no app decisions',
}

const OTHER_CHANNELS = new Set(CHANNELS.filter((c) => c !== 'WEB' && c !== 'APP'))

interface Finding {
  readonly file: string
  readonly line: number
  readonly text: string
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return full.endsWith(path.join('server', 'db', 'generated')) ? [] : sourceFiles(full)
    return /\.(ts|tsx|mts)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [full] : []
  })
}

const literalOf = (node: ts.Node): string | null => (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null)
const literalTypeOf = (node: ts.TypeNode): string | null => (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal) ? node.literal.text : null)

/** Whether `node` holds the string APP anywhere (a comparison, a list, a ternary) */
function mentionsApp(node: ts.Node): boolean {
  let found = false
  const visit = (n: ts.Node) => {
    if (found) return
    if (literalOf(n) === 'APP' || (ts.isLiteralTypeNode(n) && ts.isStringLiteral(n.literal) && n.literal.text === 'APP')) found = true
    else n.forEachChild(visit)
  }
  visit(node)
  return found
}

/** The whole condition a comparison belongs to: up through &&, ||, ! and parentheses */
function conditionOf(node: ts.Node): ts.Node {
  let current = node
  for (;;) {
    const parent = current.parent
    if (ts.isParenthesizedExpression(parent) || (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken)) current = parent
    else if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind)) current = parent
    else return current
  }
}

function webWithoutApp(rel: string, text: string): Finding[] {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const findings: Finding[] = []
  const report = (node: ts.Node) =>
    findings.push({ file: rel, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.getText().replace(/\s+/g, ' ').slice(0, 140) })
  const visit = (node: ts.Node) => {
    // ['WEB', 'LIFF', …] — a list of channels (z.enum, new Set, `as const` lists)
    if (ts.isArrayLiteralExpression(node)) {
      const values = node.elements.map(literalOf)
      if (values.includes('WEB') && values.some((v) => v !== null && OTHER_CHANNELS.has(v as never)) && !values.includes('APP')) report(node)
    }
    // 'WEB' | 'LIFF' | … — a channel type
    if (ts.isUnionTypeNode(node)) {
      const values = node.types.map(literalTypeOf)
      if (values.includes('WEB') && values.some((v) => v !== null && OTHER_CHANNELS.has(v as never)) && !values.includes('APP')) report(node)
    }
    // x.channel === 'WEB' / channel !== 'WEB' — a check of the channel, whose whole condition must say APP too
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) {
      const [lit, other] = literalOf(node.right) === 'WEB' ? [node.right, node.left] : literalOf(node.left) === 'WEB' ? [node.left, node.right] : [null, null]
      if (lit && other && /channel$/i.test(other.getText()) && !mentionsApp(conditionOf(node))) report(node)
    }
    node.forEachChild(visit)
  }
  visit(source)
  return findings
}

describe('[FR-PLT-301/AC10] every channel list and check that takes WEB takes APP (BR-APP-02)', () => {
  const findings = sourceFiles(SRC).flatMap((file) => webWithoutApp(path.relative(ROOT, file).split(path.sep).join('/'), readFileSync(file, 'utf8')))

  it('finds no list, type or comparison of channels in src that lets WEB through but not APP', () => {
    const unexplained = findings.filter((f) => !(f.file in WEB_ONLY)).map((f) => `${f.file}:${f.line} ${f.text}`)
    expect(unexplained).toEqual([])
  })

  it('every named exception still holds a WEB-only place (an exception never outlives its reason)', () => {
    for (const file of Object.keys(WEB_ONLY)) expect(findings.some((f) => f.file === file), file).toBe(true)
  })

  it('the check itself sees a WEB-only list, type and condition, and lets the ones with APP pass', () => {
    const probe = [
      "const a = z.enum(['WEB', 'LIFF'])",
      "type B = 'WEB' | 'PWA'",
      "if (ctx.channel !== 'WEB' && ctx.channel !== 'LIFF') refuse()",
      "const d = row.channel === 'WEB' ? 1 : 2",
      "const ok1 = z.enum(['WEB', 'APP', 'LIFF'])",
      "type Ok2 = 'WEB' | 'LIFF' | 'APP'",
      "if (ctx.channel !== 'WEB' && ctx.channel !== 'APP') refuse()",
      "const ok4 = ['WEB', 'Mobile'] // not channels",
    ].join('\n')
    expect(webWithoutApp('probe.ts', probe).map((f) => f.line)).toEqual([1, 2, 3, 4])
  })

  it('the channels of the context hold APP', () => {
    expect(CHANNELS).toContain('APP')
  })
})
