import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// §9.4 · NFR-I18N-01: next.config.ts compiles the messages when the app is built (next-intl's precompile), and next-intl
// then formats them without the ICU parser. One thing reads differently: a message given too few values. The ICU
// formatter failed on it and the page showed the message's key; the compiled formatter writes "undefined" where the
// value should be, with no error, in Thai and in English. Neither is right, and TypeScript does not see it (the
// catalogue's types are the JSON's: strings). So this test reads every translator of src that has its namespace written
// out — useTranslations('…'), getTranslations('…') or getTranslations({ namespace: '…' }), alone or in a Promise.all —
// and every call of it with its key written out, and fails when the call gives no value for an argument or a tag of the
// message, in either language. A call whose values are not an object written out (a variable, a spread) is left to its
// own tests, and so is a translator handed to another function.

const ROOT = path.resolve(import.meta.dirname, '../..')
const SRC = path.join(ROOT, 'src')
const rel = (file: string) => path.relative(ROOT, file).replaceAll('\\', '/')

/** The ICU parser of next-intl's formatter, to know the arguments and tags of a message */
const fromNextIntl = createRequire(createRequire(import.meta.url).resolve('next-intl'))
const fromUseIntl = createRequire(fromNextIntl.resolve('use-intl'))
const fromMessageFormat = createRequire(fromUseIntl.resolve('intl-messageformat'))
const { parse } = (await import(pathToFileURL(fromMessageFormat.resolve('@formatjs/icu-messageformat-parser')).href)) as { parse: (message: string) => Element[] }

interface Element {
  readonly type: number
  readonly value?: string
  readonly options?: Record<string, { readonly value: Element[] }>
  readonly children?: Element[]
}

// Element types of @formatjs/icu-messageformat-parser that take a value: argument, number, date, time, select, plural, tag
const NEEDS_VALUE = new Set([1, 2, 3, 4, 5, 6, 8])

/** The names a message needs values for: its arguments and its tags, in every branch */
function namesOf(elements: readonly Element[], names = new Set<string>()): Set<string> {
  for (const element of elements) {
    if (NEEDS_VALUE.has(element.type) && element.value) names.add(element.value)
    for (const option of Object.values(element.options ?? {})) namesOf(option.value, names)
    if (element.children) namesOf(element.children, names)
  }
  return names
}

type Catalogue = Readonly<Record<string, unknown>>

function messageAt(catalogue: Catalogue, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), catalogue)
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return full === path.join(SRC, 'server', 'db', 'generated') ? [] : filesUnder(full)
    return /\.tsx?$/.test(name) && !name.endsWith('.d.ts') && !/\.test\.tsx?$/.test(name) ? [full] : []
  })
}

/** The files of src that make a translator: only those are parsed */
const translating = () => filesUnder(SRC).filter((file) => /\b(?:useTranslations|getTranslations)\(/.test(readFileSync(file, 'utf8')))

/** Parsing and binding some hundreds of files takes a few seconds on a busy machine */
const PARSE_TIMEOUT_MS = 60_000

const stringOf = (node: ts.Node | undefined): string | null => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null)

/** The namespace of a translator this expression makes — useTranslations('a'), await getTranslations('a' | { namespace: 'a' }) — or null */
function namespaceMadeBy(expression: ts.Expression): string | null {
  const call = ts.isAwaitExpression(expression) ? expression.expression : expression
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return null
  if (call.expression.text !== 'useTranslations' && call.expression.text !== 'getTranslations') return null
  const [first] = call.arguments
  if (first === undefined) return ''
  const named = stringOf(first)
  if (named !== null) return named
  if (!ts.isObjectLiteralExpression(first)) return null
  for (const property of first.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'namespace') return stringOf(property.initializer)
  }
  return ''
}

/** The elements of `await Promise.all([…])`, or null */
function promiseAllElements(expression: ts.Expression): readonly ts.Expression[] | null {
  if (!ts.isAwaitExpression(expression) || !ts.isCallExpression(expression.expression)) return null
  const call = expression.expression
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression) || callee.expression.text !== 'Promise' || callee.name.text !== 'all') return null
  const [list] = call.arguments
  return list && ts.isArrayLiteralExpression(list) ? list.elements : null
}

/** The names of the values an object written out gives; null when they cannot be read (a spread, a computed name, a variable) */
function namesGivenBy(values: ts.Expression | undefined): Set<string> | null {
  if (values === undefined) return new Set()
  if (!ts.isObjectLiteralExpression(values)) return null
  const names = new Set<string>()
  for (const property of values.properties) {
    if (ts.isShorthandPropertyAssignment(property)) names.add(property.name.text)
    else if ((ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) names.add(property.name.text)
    else return null
  }
  return names
}

interface Checked {
  /** Calls of a translator with a namespace and a key written out */
  readonly calls: number
  readonly problems: readonly string[]
}

/** Every call of a translator in these files that gives a message too few values, against these catalogues */
function check(files: readonly string[], catalogues: ReadonlyArray<readonly [string, Catalogue]>, host?: ts.CompilerHost): Checked {
  const program = ts.createProgram(files, { noResolve: true, noLib: true, types: [], jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, host)
  const checker = program.getTypeChecker()
  const wanted = new Set(files.map((file) => path.resolve(file)))
  const problems: string[] = []
  let calls = 0
  for (const source of program.getSourceFiles()) {
    if (!wanted.has(path.resolve(source.fileName))) continue
    // The translators of the file, by the symbol of the name they are bound to (a parameter of the same name is not one)
    const translators = new Map<ts.Symbol, string>()
    const remember = (name: ts.BindingName, namespace: string | null) => {
      if (namespace === null || !ts.isIdentifier(name)) return
      const symbol = checker.getSymbolAtLocation(name)
      if (symbol) translators.set(symbol, namespace)
    }
    const bindings = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) remember(node.name, namespaceMadeBy(node.initializer))
        else if (ts.isArrayBindingPattern(node.name)) {
          const made = promiseAllElements(node.initializer)
          node.name.elements.forEach((element, i) => {
            const expression = made?.[i]
            if (expression && ts.isBindingElement(element)) remember(element.name, namespaceMadeBy(expression))
          })
        }
      }
      ts.forEachChild(node, bindings)
    }
    bindings(source)
    if (translators.size === 0) continue
    const uses = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const target = ts.isIdentifier(callee)
          ? callee
          : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && (callee.name.text === 'rich' || callee.name.text === 'markup')
            ? callee.expression
            : null
        const symbol = target ? checker.getSymbolAtLocation(target) : undefined
        const namespace = symbol ? translators.get(symbol) : undefined
        const key = stringOf(node.arguments[0])
        if (namespace !== undefined && key !== null) {
          calls++
          const full = namespace ? `${namespace}.${key}` : key
          const given = namesGivenBy(node.arguments[1])
          for (const [locale, catalogue] of catalogues) {
            const message = messageAt(catalogue, full)
            if (typeof message !== 'string' || given === null) continue
            const missing = [...namesOf(parse(message))].filter((name) => !given.has(name))
            if (missing.length === 0) continue
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
            problems.push(`${rel(source.fileName)}:${line + 1} ${full} (${locale}) is given no value for ${missing.join(', ')}`)
          }
        }
      }
      ts.forEachChild(node, uses)
    }
    uses(source)
  }
  return { calls, problems }
}

const CATALOGUES = [['th', th], ['en', en]] as const satisfies ReadonlyArray<readonly [string, Catalogue]>

describe('[NFR-I18N-01] [§9.4] every message is given a value for each of its arguments and tags, as compiled messages need', () => {
  it(
    'finds no call of a translator in src that leaves out an argument or a tag of its message, in Thai or in English',
    () => {
      const { calls, problems } = check(translating(), CATALOGUES)
      // The translators of the app's pages, components and jobs: some four thousand calls with a key written out (3,991
      // when this test was written); far fewer would mean the test no longer finds them
      expect(calls).toBeGreaterThan(3000)
      expect(problems).toEqual([])
    },
    PARSE_TIMEOUT_MS,
  )

  it('knows the arguments and tags of a message in every branch', () => {
    expect([...namesOf(parse('รหัสอ้างอิง {reference}'))]).toEqual(['reference'])
    expect([...namesOf(parse('{count, plural, one {# รายการ} other {# รายการ ของ {who}}}'))].sort()).toEqual(['count', 'who'])
    expect([...namesOf(parse('อ่าน <b>{n, number}</b> ก่อน {when, date, short}'))].sort()).toEqual(['b', 'n', 'when'])
    expect([...namesOf(parse('ไม่มีค่าใด ๆ'))]).toEqual([])
  })

  it('reads translators and their calls as the app writes them, and names the call that leaves a value out', () => {
    const file = path.join(ROOT, 'tests', 'unit', '__messages-arguments-sample__.tsx')
    const sample = [
      "const t = useTranslations('a')",
      "t('ref', { reference: digest })",
      "t('ref')",
      "t.rich('ref', { ...values })",
      "t('plain')",
      "function inner(t: (key: string) => string) { return t('ref') }",
      "const [tl, other] = await Promise.all([getTranslations({ locale, namespace: 'a' }), getLocale()])",
      "tl.markup('ref', { digest })",
      "const tAll = await getTranslations()",
      "tAll('a.ref', { reference: 1 })",
      "t(`ref`, values)",
    ].join('\n')
    const host = ts.createCompilerHost({})
    const read = host.getSourceFile.bind(host)
    host.getSourceFile = (name, version) => (path.resolve(name) === file ? ts.createSourceFile(name, sample, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX) : read(name, version))
    host.fileExists = (name) => path.resolve(name) === file
    const catalogue = { a: { ref: 'รหัส {reference}', plain: 'ข้อความ' } }
    const { calls, problems } = check([file], [['th', catalogue]], host)
    expect(calls).toBe(7)
    expect(problems).toEqual([
      'tests/unit/__messages-arguments-sample__.tsx:3 a.ref (th) is given no value for reference',
      'tests/unit/__messages-arguments-sample__.tsx:8 a.ref (th) is given no value for reference',
    ])
  })
})
