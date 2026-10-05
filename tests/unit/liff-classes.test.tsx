import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { NextIntlClientProvider } from 'next-intl'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { twMerge } from 'tailwind-merge'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { BoundaryConfirm } from '@/ui/admin-doa/boundary-confirm'
import { Button as WorkspaceButton } from '@/ui/form/button'
import { Notice } from '@/ui/form/notice'
import { LiffActionBar } from '@/ui/liff/action-bar'
import { Button, type ButtonProps } from '@/ui/liff/button'
import { cn } from '@/ui/liff/cn'
import { LiffContent, LiffSection } from '@/ui/liff/content'
import { LiffDelegationStateMark, type LiffDelegationState } from '@/ui/liff/delegation/state-mark'
import { LiffFrame } from '@/ui/liff/frame'
import { LiffIcon, type LiffIconName } from '@/ui/liff/icons'
import { LiffLanguageSwitch } from '@/ui/liff/language-switch'
import { LiffNotice, NoticeIcon, type LiffNoticeTone } from '@/ui/liff/notice'
import { PinInput } from '@/ui/liff/pin-input'
import { CameraIcon } from '@/ui/liff/receiving/camera-icon'
import { FieldError, LiffField, LiffTextArea } from '@/ui/liff/receiving/fields'
import { LiffStatusMark, MARK_SHAPES, MarkIcon, type MarkShape } from '@/ui/liff/receiving/marks'
import { LiffCameraAttach } from '@/ui/liff/requests/camera-attach'
import th from '../../messages/th.json'

// §9.4 · the classes of the LIFF components without tailwind-merge (src/ui/liff/cn.ts). The workspace joins classes with
// src/ui/cn.ts, which resolves conflicting Tailwind classes — the later one wins — with tailwind-merge, some 8.6 KB gzip in
// the first JavaScript of every page that draws one of its components. A LIFF page's first JavaScript is at most 200 KB
// gzip with the LINE SDK and its page data, and the LIFF components need no merging: each writes its classes so that no
// two set the same thing, and its callers add classes without overriding one. This test holds them to it: no LIFF source
// imports src/ui/cn.ts or the workspace's button; no LIFF page brings tailwind-merge into the browser for its first
// screen, through its own components or the workspace's it draws (the imports followed from the page and its layouts, as
// the bundler follows them, the chunks loaded with import() included); every class list a LIFF component draws — in every
// tone, variant and with every className its callers pass — is one tailwind-merge would leave as it is, and so are those
// of the workspace components a LIFF page draws (the notice of a request's files, a DOA version's boundary tick), which
// join theirs the same way; and every LIFF use of the LIFF button draws the classes the workspace's button draws for it
// (the same look, merged or not).

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined, replace: () => undefined }) }))

const ROOT = path.resolve(import.meta.dirname, '../..')
const SRC = path.join(ROOT, 'src')
const rel = (file: string) => path.relative(ROOT, file).replaceAll('\\', '/')

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? filesUnder(full) : /\.tsx?$/.test(name) ? [full] : []
  })
}

/** The LIFF app's own sources: its pages and its components */
const LIFF_SOURCES = [...filesUnder(path.join(SRC, 'ui', 'liff')), ...filesUnder(path.join(SRC, 'app', 'liff'))]

function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/') ? path.join(SRC, specifier.slice(2)) : specifier.startsWith('.') ? path.resolve(path.dirname(from), specifier) : null
  if (!base) return null
  return [base, `${base}.ts`, `${base}.tsx`].find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
}

const APP = path.join(SRC, 'app')
/** A package among the modules: package:<its name> */
const PACKAGE = 'package:'
/** The workspace's class merger: src/ui/cn.ts and the package it calls */
const MERGER = [path.join(SRC, 'ui', 'cn.ts'), `${PACKAGE}tailwind-merge`]

/** What a module brings into the browser with it: what it imports, and the chunks it loads later with import() */
interface ModuleImports {
  /** 'use client' or 'use server' when the module starts with one */
  readonly directive: string | null
  readonly imports: readonly string[]
  readonly lazy: readonly string[]
}

/** A module of src/ as its file, a package as package:<name>; null for anything else (a JSON file, a stylesheet) */
function moduleOf(from: string, specifier: string): string | null {
  if (!specifier.startsWith('@/') && !specifier.startsWith('.')) {
    const parts = specifier.split('/')
    return `${PACKAGE}${(specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)).join('/')}`
  }
  const base = specifier.startsWith('@/') ? path.join(SRC, specifier.slice(2)) : path.resolve(path.dirname(from), specifier)
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')].find((c) => /\.tsx?$/.test(c) && existsSync(c) && statSync(c).isFile()) ?? null
}

const importsRead = new Map<string, ModuleImports>()

/** A module's imports as the bundler reads them: `import type`, and imports and re-exports of types alone, are erased */
function importsOf(file: string): ModuleImports {
  const known = importsRead.get(file)
  if (known) return known
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const first = source.statements[0]
  const directive = first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) ? first.expression.text : null
  const typesOnly = (elements: ReadonlyArray<{ readonly isTypeOnly: boolean }>) => elements.length > 0 && elements.every((e) => e.isTypeOnly)
  const imports: string[] = []
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      const named = clause?.namedBindings
      if (clause?.isTypeOnly || (clause && !clause.name && named && ts.isNamedImports(named) && typesOnly(named.elements))) continue
      imports.push((statement.moduleSpecifier as ts.StringLiteral).text)
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      const named = statement.exportClause
      if (statement.isTypeOnly || (named && ts.isNamedExports(named) && typesOnly(named.elements))) continue
      imports.push((statement.moduleSpecifier as ts.StringLiteral).text)
    }
  }
  const lazy: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments
      if (specifier && ts.isStringLiteralLike(specifier)) lazy.push(specifier.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  const resolve = (specifiers: readonly string[]) => specifiers.map((s) => moduleOf(file, s)).filter((m): m is string => m !== null)
  const read = { directive, imports: resolve(imports), lazy: resolve(lazy) }
  importsRead.set(file, read)
  return read
}

/** The LIFF form's steps 2 and 3: it loads them with import() when the person moves to them (src/ui/liff/requests/request-form.tsx) */
const AFTER_AN_ACTION = new Set(['items-with-words.tsx', 'review-with-words.tsx'].map((name) => path.join(SRC, 'ui', 'liff', 'requests', name)))

/**
 * The modules a page's first screen brings into the browser, each with the module that brought it ('' for the page's
 * own files): the client components ('use client') its server components import, everything those import, and the
 * chunks they load with import() as the screen shows — the LINE SDK, a task's decision, an unlinked account's sign-in —
 * but for AFTER_AN_ACTION. A module of server actions stays on the server: the browser calls them by reference.
 */
function browserModulesOf(routeFiles: readonly string[]): ReadonlyMap<string, string> {
  const brought = new Map<string, string>()
  const onServer = new Set<string>()
  const inBrowser = (module: string, by: string): void => {
    if (brought.has(module)) return
    brought.set(module, by)
    if (module.startsWith(PACKAGE)) return
    const { directive, imports, lazy } = importsOf(module)
    if (directive === 'use server') return
    for (const next of imports) inBrowser(next, module)
    for (const next of lazy) if (!AFTER_AN_ACTION.has(next)) inBrowser(next, module)
  }
  const server = (module: string): void => {
    if (onServer.has(module)) return
    onServer.add(module)
    for (const next of importsOf(module).imports) {
      if (next.startsWith(PACKAGE)) continue
      if (importsOf(next).directive === 'use client') inBrowser(next, module)
      else server(next)
    }
  }
  for (const file of routeFiles) {
    if (importsOf(file).directive === 'use client') inBrowser(file, '')
    else server(file)
  }
  return brought
}

/** How a module came into a page: the module, the one that imported it, and so on up to a server component or the page's own file */
function pathTo(brought: ReadonlyMap<string, string>, module: string): string {
  const chain: string[] = []
  for (let at: string | undefined = module; at; at = brought.get(at)) chain.push(at.startsWith(PACKAGE) ? at.slice(PACKAGE.length) : rel(at))
  return chain.join(' ← ')
}

/** The files Next.js draws a page with: the page, and the layout, template, loading, error and not-found files of every segment up to the root */
function routeFilesOf(page: string): string[] {
  const files = [page]
  for (let dir = path.dirname(page); ; dir = path.dirname(dir)) {
    for (const name of ['layout.tsx', 'template.tsx', 'loading.tsx', 'error.tsx', 'not-found.tsx', 'global-error.tsx']) {
      const file = path.join(dir, name)
      if (existsSync(file)) files.push(file)
    }
    if (dir === APP || dir === path.dirname(dir)) return files
  }
}

const classSet = (classes: string) => new Set(classes.split(/\s+/).filter(Boolean))
const sameClasses = (a: string, b: string) => {
  const [x, y] = [classSet(a), classSet(b)]
  return x.size === y.size && [...x].every((c) => y.has(c))
}

/** The class lists of the markup that tailwind-merge would change: two classes that set the same thing */
function conflictsIn(markup: string): string[] {
  const lists = [...markup.matchAll(/\bclass="([^"]*)"/g)].map((m) => m[1]!.replaceAll('&amp;', '&').replaceAll('&quot;', '"'))
  return lists.filter((classes) => !sameClasses(classes, twMerge(classes)))
}

const html = (node: ReactElement) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="th" messages={th} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )

/** The class attribute of the first element of the markup */
const firstClass = (markup: string) => /\bclass="([^"]*)"/.exec(markup)?.[1]?.replaceAll('&amp;', '&') ?? ''

interface ButtonUse {
  readonly where: string
  readonly variant: NonNullable<ButtonProps['variant']>
  readonly className: string | undefined
}

/** The opening tag that starts at `at`: up to its first '>' outside braces */
function openingTag(text: string, at: number): string {
  let depth = 0
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0 && text[i - 1] !== '=') return text.slice(at, i + 1)
  }
  return text.slice(at)
}

/**
 * The values a prop of a tag may take, as written: a string, a constant string of the same file, or either string of a
 * condition (`{a ? 'x' : 'y'}`); null when the prop is written any other way, [] when it is not there
 */
function valuesOf(prop: string, tag: string, file: string): string[] | null {
  const written = new RegExp(`\\b${prop}=("[^"]*"|\\{[^{}]*\\})`).exec(tag)?.[1]
  if (written === undefined) return []
  if (written.startsWith('"')) return [written.slice(1, -1)]
  const named = /^\{(\w+)\}$/.exec(written)
  if (named) {
    const constant = new RegExp(`\\bconst ${named[1]}\\s*=\\s*(['"])([^'"]*)\\1`).exec(file)
    return constant ? [constant[2]!] : null
  }
  const either = /^\{[^{}?]*\?\s*(['"])([^'"]*)\1\s*:\s*(['"])([^'"]*)\3\s*\}$/.exec(written)
  return either ? [either[2]!, either[4]!] : null
}

/** Every <Button> of the LIFF sources with each variant and className it may be drawn with */
function buttonUses(): { readonly uses: ButtonUse[]; readonly unreadable: string[] } {
  const uses: ButtonUse[] = []
  const unreadable: string[] = []
  for (const file of LIFF_SOURCES) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/<Button\b/g)) {
      const tag = openingTag(text, m.index)
      const where = `${rel(file)}:${text.slice(0, m.index).split('\n').length}`
      const variants = valuesOf('variant', tag, text)
      const classNames = valuesOf('className', tag, text)
      if (variants === null || classNames === null) {
        unreadable.push(where)
        continue
      }
      for (const variant of variants.length > 0 ? variants : ['primary']) {
        for (const className of classNames.length > 0 ? classNames : [undefined]) uses.push({ where, variant: variant as ButtonUse['variant'], className })
      }
    }
  }
  return { uses, unreadable }
}

/** Every className the sources pass to the workspace's notice (src/ui/form/notice.tsx), read as buttonUses reads them */
function noticeClassNames(): { readonly notices: number; readonly classNames: string[]; readonly unreadable: string[] } {
  const notice = path.join(SRC, 'ui', 'form', 'notice.tsx')
  let notices = 0
  const classNames: string[] = []
  const unreadable: string[] = []
  for (const file of filesUnder(SRC)) {
    if (!importsOf(file).imports.includes(notice)) continue
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/<Notice\b/g)) {
      notices++
      const values = valuesOf('className', openingTag(text, m.index), text)
      if (values === null) unreadable.push(`${rel(file)}:${text.slice(0, m.index).split('\n').length}`)
      else classNames.push(...values)
    }
  }
  return { notices, classNames, unreadable }
}

/** These tests read every LIFF file or walk its imports: 5 s is too short when the whole unit project runs at once */
const SCAN_TIMEOUT_MS = 60_000

describe('[§9.4] the LIFF components join their classes without tailwind-merge', () => {
  it('no LIFF page or component imports the workspace’s class merger or its button, which brings it', () => {
    const merging = [path.join(SRC, 'ui', 'cn.ts'), path.join(SRC, 'ui', 'form', 'button.tsx')]
    const found = LIFF_SOURCES.flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      return [...text.matchAll(/(?:^|\n)\s*import\s+(?!type\b)[^'";]*?from\s*['"]([^'"]+)['"]/g)]
        .map((m) => resolveImport(file, m[1]!))
        .filter((target): target is string => target !== null && merging.includes(target))
        .map((target) => `${rel(file)} → ${rel(target)}`)
    })
    expect(found).toEqual([])
  }, SCAN_TIMEOUT_MS)

  it('no LIFF page brings tailwind-merge into the browser for its first screen, through its own components or the workspace’s it draws', () => {
    const pages = LIFF_SOURCES.filter((file) => path.basename(file) === 'page.tsx')
    expect(pages.length).toBeGreaterThanOrEqual(12)
    const merging = pages.flatMap((page) => {
      const brought = browserModulesOf(routeFilesOf(page))
      return MERGER.filter((module) => brought.has(module)).map((module) => `${rel(page)}: ${pathTo(brought, module)}`)
    })
    expect(merging).toEqual([])
  }, SCAN_TIMEOUT_MS)

  it('the walk sees what a page draws — a request’s list of files with its notice, a DOA version’s decision loaded with import() with its tick, the LINE SDK — and finds tailwind-merge where the workspace draws its components', () => {
    const at = (...parts: string[]) => path.join(SRC, ...parts)
    const request = browserModulesOf(routeFilesOf(path.join(APP, 'liff', 'requests', '[id]', '(view)', 'page.tsx')))
    expect([at('ui', 'request-view', 'attachments.tsx'), at('ui', 'form', 'notice.tsx')].filter((m) => !request.has(m)).map(rel)).toEqual([])
    const task = browserModulesOf(routeFilesOf(path.join(APP, 'liff', 'tasks', '[id]', 'page.tsx')))
    expect([at('ui', 'liff', 'tasks', 'policy-decision.tsx'), at('ui', 'admin-doa', 'boundary-confirm.tsx'), at('ui', 'liff', 'sdk.ts'), `${PACKAGE}@line/liff`].filter((m) => !task.has(m))).toEqual([])
    // The form's steps 2 and 3 come with import() only, after the person moves on: not with the form's first screen
    const form = browserModulesOf(routeFilesOf(path.join(APP, 'liff', 'requests', 'new', '[type]', 'page.tsx')))
    expect([...AFTER_AN_ACTION].filter((m) => !existsSync(m) || form.has(m) || !importsOf(at('ui', 'liff', 'requests', 'request-form.tsx')).lazy.includes(m)).map(rel)).toEqual([])
    // A page of the workspace draws its components with src/ui/cn.ts: the walk that finds no tailwind-merge in a LIFF page finds it there
    const workspace = browserModulesOf(routeFilesOf(path.join(APP, '(workspace)', 'requests', 'page.tsx')))
    expect(MERGER.filter((module) => !workspace.has(module))).toEqual([])
  }, SCAN_TIMEOUT_MS)

  it('the workspace components a LIFF page draws join classes that do not conflict: the notice in every tone with every className its callers pass, and the boundary tick', () => {
    const { notices, classNames, unreadable } = noticeClassNames()
    // Every notice of the workspace is read; a className this test cannot read is one it cannot check
    expect(notices).toBeGreaterThan(100)
    expect(unreadable).toEqual([])
    const tones = ['info', 'success', 'warning', 'danger'] as const
    const screens: ReadonlyArray<readonly [string, ReactElement]> = [
      ...tones.flatMap((tone) =>
        [undefined, ...classNames].map((className) => [`notice ${tone} ${className ?? ''}`, <Notice key={`${tone} ${className ?? ''}`} tone={tone} className={className}>ข้อความ</Notice>] as const),
      ),
      ...[false, true].flatMap((compact) =>
        [undefined, 'ติ๊กยืนยันก่อนอนุมัติ'].map(
          (error) =>
            [
              `boundary tick${compact ? ' compact' : ''}${error ? ' with its error' : ''}`,
              <BoundaryConfirm key={`${compact} ${error ?? ''}`} tableId="edges" checked={false} onChange={() => undefined} error={error} compact={compact} />,
            ] as const,
        ),
      ),
    ]
    const problems = screens.flatMap(([name, node]) => conflictsIn(html(node)).map((classes) => `${name}: "${classes}"`))
    expect(problems).toEqual([])
  }, SCAN_TIMEOUT_MS)

  it('cn joins the classes that are set and leaves out the others, without merging any', () => {
    expect(cn('a', false, null, undefined, '', 'b c')).toBe('a b c')
    expect(cn()).toBe('')
    // Two classes that set the same thing both stay: a LIFF component never writes them
    expect(cn('size-5', 'size-4')).toBe('size-5 size-4')
  })

  it('every LIFF use of the LIFF button draws the classes the workspace’s button draws for it, with no two that conflict', () => {
    const { uses, unreadable } = buttonUses()
    // A className this test cannot read is one it cannot check: a string, or a constant string of the same file
    expect(unreadable).toEqual([])
    expect(uses.length).toBeGreaterThan(30)
    expect(new Set(uses.map((u) => u.variant))).toEqual(new Set(['primary', 'secondary', 'danger', 'link']))
    const differ = uses.flatMap(({ where, variant, className }) => {
      const liff = firstClass(renderToStaticMarkup(<Button variant={variant} className={className} />))
      const workspace = firstClass(renderToStaticMarkup(<WorkspaceButton variant={variant} className={className} />))
      const problems: string[] = []
      if (!sameClasses(liff, workspace)) problems.push(`${where} ${variant} "${className ?? ''}": "${liff}" ≠ "${workspace}"`)
      if (conflictsIn(`class="${liff}"`).length > 0) problems.push(`${where} ${variant} "${className ?? ''}": "${liff}" has classes that conflict`)
      return problems
    })
    expect(differ).toEqual([])
  })

  it('a button whose className gives its own height or side padding draws no 44 px height or padding of its own; a link-styled one neither', () => {
    const plain = classSet(firstClass(renderToStaticMarkup(<Button />)))
    expect(plain.has('h-11') && plain.has('px-4')).toBe(true)
    const wrapping = classSet(firstClass(renderToStaticMarkup(<Button className="h-auto min-h-11 py-2" />)))
    expect([wrapping.has('h-11'), wrapping.has('h-auto'), wrapping.has('min-h-11'), wrapping.has('px-4')]).toEqual([false, true, true, true])
    const padded = classSet(firstClass(renderToStaticMarkup(<Button className="px-2" />)))
    expect([padded.has('px-4'), padded.has('px-2'), padded.has('h-11')]).toEqual([false, true, true])
    // min-h-11 sets the least height, not the height: the 44 px stays
    expect(classSet(firstClass(renderToStaticMarkup(<Button className="min-h-11 self-start" />))).has('h-11')).toBe(true)
    const link = classSet(firstClass(renderToStaticMarkup(<Button variant="link" />)))
    expect([link.has('h-11'), link.has('px-4'), link.has('h-auto'), link.has('px-0')]).toEqual([false, false, true, true])
    expect(renderToStaticMarkup(<Button>ส่ง</Button>)).toMatch(/^<button type="button"/)
  })

  it('every LIFF component draws classes that do not conflict, in every tone and state and with the classNames its callers pass', () => {
    const tones: readonly LiffNoticeTone[] = ['info', 'success', 'warning', 'danger']
    const icons: readonly LiffIconName[] = ['chevronLeft', 'shoppingCart', 'clipboardCheck', 'packageSearch', 'circleHelp']
    const states: readonly LiffDelegationState[] = ['ACTIVE', 'SCHEDULED', 'ENDED', 'REVOKED']
    const statuses = {
      po: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED', 'REJECTED', 'UNKNOWN'],
      receipt: ['DRAFT', 'POSTED', 'REVERSED'],
      variance: ['RECORDED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'],
    } as const
    const noop = async () => ({ ok: false as const, reason: 'FAILED' as const })
    const screens: ReadonlyArray<readonly [string, ReactElement]> = [
      ...tones.map((tone) => [`notice ${tone}`, <LiffNotice key={tone} tone={tone}>ข้อความ</LiffNotice>] as const),
      ...tones.map((tone) => [`notice icon ${tone}`, <NoticeIcon key={tone} tone={tone} />] as const),
      ['notice icon of a field error', <FieldError key="error" id="f" text="ตอบข้อนี้" />],
      ['content', <LiffContent key="content">x</LiffContent>],
      ['section', <LiffSection key="section" id="s" title="หัวข้อ">x</LiffSection>],
      ['action bar', <LiffActionBar key="bar" label="ปุ่ม">x</LiffActionBar>],
      ['frame', <LiffFrame key="frame" title="หน้า" back={{ href: '/liff', label: 'กลับ' }}>x</LiffFrame>],
      ...icons.flatMap((name) => [undefined, 'mt-1 text-primary', 'mt-3 text-primary'].map((className) => [`icon ${name} ${className ?? ''}`, <LiffIcon key={name} name={name} className={className} />] as const)),
      ...[undefined, 'size-4'].map((className) => [`camera icon ${className ?? ''}`, <CameraIcon key={className ?? '-'} className={className} />] as const),
      ...(Object.keys(MARK_SHAPES) as MarkShape[]).flatMap((shape) =>
        [undefined, 'mt-1 text-primary', 'mt-1 text-warn'].map((className) => [`mark ${shape} ${className ?? ''}`, <MarkIcon key={shape} shape={shape} className={className} />] as const),
      ),
      ...(Object.entries(statuses) as Array<[keyof typeof statuses, readonly string[]]>).flatMap(([of, list]) =>
        list.map((status) => [`status ${of} ${status}`, <LiffStatusMark key={status} of={of} status={status} label="สถานะ" />] as const),
      ),
      ...states.map((state) => [`delegation ${state}`, <LiffDelegationStateMark key={state} state={state} label="สถานะ" />] as const),
      ...[undefined, 'money', 'tabular text-right'].map((className) => [`field ${className ?? ''}`, <LiffField key={className ?? '-'} id="f" label="จำนวน" error="ใส่จำนวน" hint="ช่วย" className={className} />] as const),
      ['text area', <LiffTextArea key="area" id="a" label="หมายเหตุ" hint="ช่วย" />],
      ['language switch', <LiffLanguageSwitch key="language" current="th" label="ภาษา" options={[{ value: 'th', name: 'ไทย' }, { value: 'en', name: 'English' }]} action={async () => undefined} />],
      ['PIN', <PinInput key="pin" id="p" label="PIN" length={6} value="" onChange={() => undefined} hint="ช่วย" error="ผิด" disabled />],
      ...[false, true].map((busy) => [`camera ${busy ? 'busy' : 'ready'}`, <LiffCameraAttach key={String(busy)} taken={[]} busy={busy} ready={async () => 'go'} requestUpload={noop} completeUpload={noop} onAttach={async () => true} />] as const),
    ]
    const problems = screens.flatMap(([name, node]) => conflictsIn(html(node)).map((classes) => `${name}: "${classes}"`))
    expect(problems).toEqual([])
    // The camera icon beside the name of a photo is 16 px: its className's size takes the place of the 20 px
    const small = classSet(firstClass(html(<CameraIcon className="size-4" />)))
    expect([small.has('size-4'), small.has('size-5')]).toEqual([true, false])
    expect(classSet(firstClass(html(<CameraIcon />))).has('size-5')).toBe(true)
  }, SCAN_TIMEOUT_MS)
})
