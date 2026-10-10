import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLIENT_MESSAGES, LIFF_GATE_SCOPE, pickMessages, type LiffPartScope } from '@/i18n/client-messages'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// §9.4 · NFR-I18N-01 · FR-PLT-002 AC2: the messages providers of src/app (src/i18n/client-messages.ts). The root layout
// and every part of the app pass their client components only the messages those read, so that a LIFF page carries its
// own words in its HTML and not the whole catalogue (§9.4: 200 KB gzip with the page data). A client component that
// reads a namespace its provider does not pass shows the key instead of the words, in Thai and in English: this test
// follows the imports of every page and layout to its client components ('use client' and everything they import) and
// fails on such a namespace or message, naming the component and the provider.
// Rules it reads: a layout with a provider renders everything it renders inside it. <ClientMessages scope="…"> passes
// its scope and replaces the provider above it; <NextIntlClientProvider> with no messages prop passes the whole
// catalogue (the workspace). A page, error or not-found file is inside the provider of the nearest layout above it that
// has one; global-error replaces the root layout and has a provider of its own, with the `app` namespace of the files it
// imports. A client module that renders a <NextIntlClientProvider> with the messages above it (useMessages()) and
// namespaces it imports from messages/src in both languages adds those namespaces: a client module that imports it draws
// everything else it imports inside it (src/ui/liff/requests/step-words.tsx and the parts of the LIFF request form loaded
// with their words). A translator whose keys are all written out
// ('t("boundaryConfirm")') may be covered message by message; any other use of it (a key built at run time, the
// translator handed on) needs its whole namespace.

const ROOT = path.resolve(import.meta.dirname, '../..')
const SRC = path.join(ROOT, 'src')
const APP = path.join(SRC, 'app')
const rel = (file: string) => path.relative(ROOT, file).replaceAll('\\', '/')

type Scope = keyof typeof CLIENT_MESSAGES
/**
 * A layout's provider: a scope of src/i18n/client-messages.ts (`member`: a LIFF part's, passed to a member only — anyone
 * else gets the gate's words, src/app/liff/_lib/part-messages.tsx), or the whole catalogue
 */
type LayoutProvider = { readonly kind: 'scope'; readonly scope: Scope; readonly member?: true } | { readonly kind: 'all' }
/** What reaches a client component: its provider's scope, the whole catalogue, the namespaces of a provider of its own, or nothing */
type Provider = LayoutProvider | { readonly kind: 'own'; readonly paths: readonly string[] } | { readonly kind: 'none' }

interface Translator {
  /** The namespace as written; null when it is not a plain string */
  readonly namespace: string | null
  /** The keys read with it, or 'dynamic' when it is used any other way */
  readonly keys: readonly string[] | 'dynamic'
}

interface ModuleInfo {
  readonly client: boolean
  readonly server: boolean
  readonly imports: readonly string[]
  readonly translators: readonly Translator[]
  /** useMessages(): the whole provider */
  readonly readsAll: boolean
  /** A provider of its own that holds the messages above it and adds these namespaces; null for any other module */
  readonly adds: readonly string[] | null
}

/** The code after the leading comments: where a 'use client' or 'use server' directive stands */
function directiveOf(text: string): 'client' | 'server' | null {
  const head = text.replace(/^(?:\s+|\/\/[^\n]*\n?|\/\*[\s\S]*?\*\/)*/, '')
  if (/^['"]use client['"]/.test(head)) return 'client'
  if (/^['"]use server['"]/.test(head)) return 'server'
  return null
}

function resolveImport(from: string, specifier: string): string | null {
  let base: string
  if (specifier.startsWith('@/')) base = path.join(SRC, specifier.slice(2))
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(from), specifier)
  else return null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile() && /\.tsx?$/.test(candidate)) return candidate
  }
  return null
}

/** The runtime imports of a module: static (not type-only), re-exports and import() */
function importsOf(file: string, text: string): string[] {
  const specifiers: string[] = []
  for (const m of text.matchAll(/(?:^|[;\n])\s*import\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    const clause = m[2] ?? ''
    const onlyTypes = /^\{[\s\S]*\}$/.test(clause.trim()) && clause.replace(/[{}\s]/g, '').split(',').filter(Boolean).every((s) => s.startsWith('type'))
    if (!m[1] && !onlyTypes) specifiers.push(m[3]!)
  }
  for (const m of text.matchAll(/(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g)) specifiers.push(m[1]!)
  for (const m of text.matchAll(/(?:^|[;\n])\s*export\s+(type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g)) {
    if (!m[1]) specifiers.push(m[2]!)
  }
  for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(m[1]!)
  return specifiers.map((s) => resolveImport(file, s)).filter((f): f is string => f !== null)
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The translators a module makes (useTranslations) and the keys it reads with each */
function translatorsOf(text: string): Translator[] {
  const calls = [...text.matchAll(/useTranslations\(\s*([^)]*?)\s*\)/g)]
  const bound = [...text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*useTranslations\(\s*([^)]*?)\s*\)/g)]
  const literal = (arg: string): string | null => {
    if (arg === '') return ''
    const m = /^(['"])([^'"`$]*)\1$/.exec(arg)
    return m ? m[2]! : null
  }
  const names = bound.map((b) => b[1]!)
  const translators: Translator[] = bound.map((b) => {
    const name = b[1]!
    const namespace = literal(b[2]!)
    // A name bound twice in the file (two components) cannot be told apart here: each needs its whole namespace
    if (names.filter((n) => n === name).length > 1) return { namespace, keys: 'dynamic' }
    const keys: string[] = []
    let dynamic = false
    const uses = [...text.matchAll(new RegExp(`(?<![.\\w$])${escape(name)}(?![\\w$])`, 'g'))]
    for (const use of uses) {
      const at = use.index
      // The binding itself
      if (at === b.index + b[0].indexOf(name, b[0].indexOf(' '))) continue
      const rest = text.slice(at + name.length)
      const call = /^(?:\.(?:rich|markup|raw|has))?\(\s*(['"])([^'"`$]+)\1\s*[,)]/.exec(rest)
      if (call) keys.push(call[2]!)
      else dynamic = true
    }
    return { namespace, keys: dynamic ? 'dynamic' : keys }
  })
  // A translator used without a name (useTranslations('x')('key'), handed on at once): its whole namespace
  const boundCalls = new Set(bound.map((b) => b.index + b[0].indexOf('useTranslations(')))
  for (const call of calls) if (!boundCalls.has(call.index)) translators.push({ namespace: literal(call[1]!), keys: 'dynamic' })
  return translators
}

/**
 * The namespaces a client provider of its own adds to the messages above it: a module that renders a
 * <NextIntlClientProvider> with useMessages() and imports the same namespaces from messages/src in Thai and in English
 * (src/ui/liff/requests/step-words.tsx); null for any other module
 */
function addedNamespacesOf(directive: 'client' | 'server' | null, text: string): string[] | null {
  if (directive !== 'client' || !/<NextIntlClientProvider\b/.test(text) || !/\buseMessages\(\)/.test(text)) return null
  const imported = (locale: string) => new Set([...text.matchAll(new RegExp(`from '(?:\\.\\./)+messages/src/${locale}/(\\w+)\\.json'`, 'g'))].map((m) => m[1]!))
  const [thNamespaces, enNamespaces] = [imported('th'), imported('en')]
  if (thNamespaces.size === 0 || thNamespaces.size !== enNamespaces.size || [...thNamespaces].some((ns) => !enNamespaces.has(ns))) return null
  return [...thNamespaces].sort()
}

const modules = new Map<string, ModuleInfo>()
function moduleInfo(file: string): ModuleInfo {
  const known = modules.get(file)
  if (known) return known
  const text = readFileSync(file, 'utf8')
  const directive = directiveOf(text)
  const info: ModuleInfo = {
    client: directive === 'client',
    server: directive === 'server',
    imports: importsOf(file, text),
    translators: translatorsOf(text),
    readsAll: /\buseMessages\(/.test(text),
    adds: addedNamespacesOf(directive, text),
  }
  modules.set(file, info)
  return info
}

/**
 * The client modules a page or layout renders — every 'use client' module it reaches, and all those import — each with
 * the namespaces a provider of its own adds above it (none for a module drawn outside every such provider). A module
 * that imports such a provider draws everything else it imports inside it; a module reached more than one way has only
 * what every way gives it.
 */
function clientModulesOf(entry: string): Map<string, readonly string[]> {
  const server = new Set<string>()
  const client = new Map<string, readonly string[]>()
  const visitClient = (file: string, added: readonly string[]) => {
    const known = client.get(file)
    const now = known ? known.filter((ns) => added.includes(ns)) : added
    if (known && now.length === known.length) return
    client.set(file, now)
    const info = moduleInfo(file)
    const provider = info.imports.find((next) => moduleInfo(next).adds !== null)
    const inside = provider ? [...new Set([...now, ...moduleInfo(provider).adds!])] : now
    for (const next of info.imports) if (!moduleInfo(next).server) visitClient(next, next === provider ? now : inside)
  }
  const visitServer = (file: string) => {
    if (server.has(file)) return
    server.add(file)
    for (const next of moduleInfo(file).imports) {
      const info = moduleInfo(next)
      if (info.server) continue
      if (info.client) visitClient(next, [])
      else visitServer(next)
    }
  }
  if (moduleInfo(entry).client) visitClient(entry, [])
  else visitServer(entry)
  return client
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? filesUnder(full) : [full]
  })
}

const isScope = (scope: string): scope is Scope => Object.hasOwn(CLIENT_MESSAGES, scope)

/** The provider a layout puts around what it renders, if any */
function providerOfLayout(file: string): LayoutProvider | 'unknown' | null {
  const text = readFileSync(file, 'utf8')
  const scoped = [...text.matchAll(/<ClientMessages\s+scope="(\w+)"/g)].map((m) => m[1]!)
  const forMember = [...text.matchAll(/<LiffPartMessages\s+scope="(\w+)"/g)].map((m) => m[1]!)
  const whole = [...text.matchAll(/<NextIntlClientProvider\b([^>]*)>/g)]
  const kinds = [scoped, forMember, whole].filter((found) => found.length > 0).length
  if (kinds === 0) return null
  if (kinds > 1 || new Set(scoped).size > 1 || new Set(forMember).size > 1 || whole.some((m) => /\bmessages=/.test(m[1] ?? ''))) return 'unknown'
  if (whole.length > 0) return { kind: 'all' }
  const scope = scoped[0] ?? forMember[0]!
  if (!isScope(scope)) return 'unknown'
  return forMember.length > 0 ? { kind: 'scope', scope, member: true } : { kind: 'scope', scope }
}

const ENTRY = /^(page|layout|error|not-found|loading|template|default|forbidden|unauthorized|global-error)\.tsx$/
const entries = filesUnder(APP).filter((file) => ENTRY.test(path.basename(file)))
const layouts = new Map(entries.filter((f) => path.basename(f) === 'layout.tsx').map((f) => [path.dirname(f), providerOfLayout(f)] as const))

/**
 * The parts of the LIFF app (folders under src/app/liff) whose words go to a member only, and their scopes. The
 * catalogue and a request's page are route groups of their own, so that the form of a type and the form of a draft are
 * not under them: a page under two providers carries the words of both (§9.4)
 */
const LIFF_PARTS: ReadonlyArray<readonly [string, LiffPartScope]> = [
  ['tasks/[id]', 'liffTask'],
  ['requests/new/(catalog)', 'liffCatalog'],
  ['requests/new/[type]', 'liffRequestForm'],
  ['requests/[id]/(view)', 'liffRequest'],
  ['requests/[id]/edit', 'liffRequestForm'],
  ['delegation', 'liffDelegation'],
  ['gr', 'liffReceiving'],
]

/** The provider of the parts of the LIFF request form that are loaded with their words (steps 2 and 3, …) */
const STEP_WORDS = path.join(SRC, 'ui', 'liff', 'requests', 'step-words.tsx')

/** The provider of global-error: its own, with the `app` namespace of the two files it imports */
function globalErrorProvider(file: string): Provider | 'unknown' {
  const text = readFileSync(file, 'utf8')
  const imports = ['th', 'en'].every((locale) => text.includes(`from '../../messages/src/${locale}/app.json'`))
  return imports && /<NextIntlClientProvider\b[^>]*\bmessages=\{\{ app: /.test(text) ? { kind: 'own', paths: ['app'] } : 'unknown'
}

/** The provider around an entry: global-error has its own, anything else is inside the nearest layout's provider */
function providerOf(entry: string): Provider | 'unknown' {
  if (path.basename(entry) === 'global-error.tsx') return globalErrorProvider(entry)
  for (let dir = path.dirname(entry); dir.startsWith(APP); dir = path.dirname(dir)) {
    const provider = layouts.get(dir)
    if (provider) return provider
  }
  return { kind: 'none' }
}

const covers = (paths: readonly string[], message: string) => paths.some((p) => message === p || message.startsWith(`${p}.`))

/** What a client module reads that the provider does not pass, with the namespaces a provider of its own adds above it */
function missingIn(provider: Provider, info: ModuleInfo, added: readonly string[] = []): string[] {
  if (provider.kind === 'all') return []
  const paths: readonly string[] = [...(provider.kind === 'scope' ? CLIENT_MESSAGES[provider.scope] : provider.kind === 'own' ? provider.paths : []), ...added]
  const missing: string[] = []
  // A provider of its own hands every message above it on, with its own namespaces: it reads none of them itself
  if (info.readsAll && info.adds === null) missing.push('useMessages() (every message of the provider)')
  for (const { namespace, keys } of info.translators) {
    if (namespace === null) missing.push('useTranslations() with a namespace that is not a plain string')
    else if (namespace !== '' && covers(paths, namespace)) continue
    else if (keys === 'dynamic') missing.push(namespace === '' ? 'useTranslations() of the whole catalogue' : namespace)
    else for (const key of keys) if (!covers(paths, namespace === '' ? key : `${namespace}.${key}`)) missing.push(namespace === '' ? key : `${namespace}.${key}`)
  }
  return missing
}

const describeProvider = (provider: Provider) =>
  provider.kind === 'scope'
    ? provider.member
      ? `LiffPartMessages scope "${provider.scope}" (a member's)`
      : `ClientMessages scope "${provider.scope}"`
    : provider.kind === 'all'
      ? 'the whole catalogue'
      : provider.kind === 'own'
        ? `its own provider (${provider.paths.join(', ')})`
        : 'no provider'

describe('[NFR-I18N-01] [FR-PLT-002/AC2] [§9.4] every client component finds its words in the messages its provider passes', () => {
  it('finds the pages and layouts of every part of the app, and a provider in the root layout and in each part', () => {
    expect(entries.length).toBeGreaterThan(50)
    expect(layouts.get(APP)).toEqual({ kind: 'scope', scope: 'root' })
    expect(layouts.get(path.join(APP, '(workspace)'))).toEqual({ kind: 'all' })
    expect(layouts.get(path.join(APP, '(auth)'))).toEqual({ kind: 'scope', scope: 'auth' })
    expect(layouts.get(path.join(APP, '(platform)'))).toEqual({ kind: 'scope', scope: 'platform' })
    expect(layouts.get(path.join(APP, 'liff'))).toEqual({ kind: 'scope', scope: 'liff' })
    // The LIFF parts: /liff/link links an account that has no session yet; the others pass their words to a member only
    expect(layouts.get(path.join(APP, 'liff', 'link'))).toEqual({ kind: 'scope', scope: 'liffLink' })
    for (const [part, scope] of LIFF_PARTS) expect(layouts.get(path.join(APP, 'liff', ...part.split('/'))), part).toEqual({ kind: 'scope', scope, member: true })
    // global-error replaces the root layout: its own provider, with the app namespace of the files it imports
    expect(providerOf(path.join(APP, 'global-error.tsx'))).toEqual({ kind: 'own', paths: ['app'] })
  })

  it('has every provider written so this test can read it: <ClientMessages scope="…"> with a scope of src/i18n/client-messages.ts, or <NextIntlClientProvider> with the whole catalogue', () => {
    const unreadable = [...layouts].filter(([, provider]) => provider === 'unknown').map(([dir]) => rel(dir))
    expect(unreadable).toEqual([])
  })

  // It reads every file of src: under verify's coverage run it can outlast the 5 s default (like design-system.test.ts)
  it('passes every client component of every page and layout what it reads', () => {
    const problems: string[] = []
    for (const entry of entries) {
      const provider = providerOf(entry)
      if (provider === 'unknown') continue
      for (const [file, added] of clientModulesOf(entry)) {
        const missing = missingIn(provider, moduleInfo(file), added)
        const by = describeProvider(provider) + (added.length > 0 ? ` with ${added.join(', ')} of a provider of its own` : '')
        if (missing.length > 0) problems.push(`${rel(entry)} → ${rel(file)} reads ${[...new Set(missing)].join(', ')}, not passed by ${by}`)
      }
    }
    expect([...new Set(problems)]).toEqual([])
  }, 60_000)

  it('sees what a client component reads: whole namespaces, messages read by name, and translators used any other way', () => {
    expect(
      translatorsOf(`
        const t = useTranslations('a.b')
        const u = useTranslations("c")
        const v = useTranslations('d')
        t('one'); t.rich('two', {}); t("three"); u(\`x.\${y}\`); v('k'); f(v); w.t('no')
      `),
    ).toEqual([
      { namespace: 'a.b', keys: ['one', 'two', 'three'] },
      { namespace: 'c', keys: 'dynamic' },
      { namespace: 'd', keys: 'dynamic' },
    ])
    expect(translatorsOf(`const t = useTranslations(ns)`)).toEqual([{ namespace: null, keys: [] }])
    expect(translatorsOf(`const t = useTranslations('a'); useTranslations('b')('c')`)).toEqual([
      { namespace: 'a', keys: [] },
      { namespace: 'b', keys: 'dynamic' },
    ])
    expect(directiveOf(`// a comment\n/* another */\n'use client'\nimport x from 'y'`)).toBe('client')
    const reading = (translators: Translator[]): ModuleInfo => ({ client: true, server: false, imports: [], readsAll: false, translators, adds: null })
    const task: Provider = { kind: 'scope', scope: 'liffTask' }
    expect(missingIn(task, reading([{ namespace: 'adminDoa.detail', keys: ['boundaryConfirm'] }]))).toEqual([])
    expect(missingIn(task, reading([{ namespace: 'adminDoa.detail', keys: 'dynamic' }]))).toEqual(['adminDoa.detail'])
    // The task page's own provider holds the gate's words too: it replaces the LIFF layout's
    expect(missingIn(task, reading([{ namespace: 'liff.gate', keys: 'dynamic' }, { namespace: 'tasks.decide', keys: 'dynamic' }]))).toEqual([])
    expect(missingIn({ kind: 'scope', scope: 'liff' }, reading([{ namespace: 'tasks.decide', keys: 'dynamic' }]))).toEqual(['tasks.decide'])
    expect(missingIn({ kind: 'none' }, reading([{ namespace: 'app.error', keys: ['title'] }]))).toEqual(['app.error.title'])
    // Inside a provider of its own, the namespaces it adds are there too
    const form: Provider = { kind: 'scope', scope: 'liffRequestForm' }
    expect(missingIn(form, reading([{ namespace: 'requestForm.lines', keys: 'dynamic' }]))).toEqual(['requestForm.lines'])
    expect(missingIn(form, reading([{ namespace: 'requestForm.lines', keys: 'dynamic' }]), ['requestForm'])).toEqual([])
    // useMessages() reads every message, unless the module is a provider of its own that hands them on
    expect(missingIn(form, { ...reading([]), readsAll: true })).toEqual(['useMessages() (every message of the provider)'])
    expect(missingIn(form, { ...reading([]), readsAll: true, adds: ['requestForm'] })).toEqual([])
  })

  it('sees a provider of its own: the namespaces it imports in both languages, which reach what the module importing it draws', () => {
    expect(addedNamespacesOf('client', `const m = useMessages(); <NextIntlClientProvider messages={m} />\nimport a from '../../messages/src/th/x.json'\nimport b from '../../messages/src/en/x.json'`)).toEqual(['x'])
    // One language only, no provider, or not a client module: none
    expect(addedNamespacesOf('client', `useMessages(); <NextIntlClientProvider />\nimport a from '../../messages/src/th/x.json'`)).toBeNull()
    expect(addedNamespacesOf('client', `import a from '../../messages/src/th/x.json'\nimport b from '../../messages/src/en/x.json'`)).toBeNull()
    expect(addedNamespacesOf(null, `useMessages(); <NextIntlClientProvider />\nimport a from '../../messages/src/th/x.json'\nimport b from '../../messages/src/en/x.json'`)).toBeNull()
    // The LIFF request form: steps 2 and 3 are drawn inside the provider of their words, step 1 and the shell outside it
    expect(moduleInfo(STEP_WORDS).adds).toEqual(['files', 'liffRequests', 'requestForm'])
    const form = clientModulesOf(path.join(APP, 'liff', 'requests', 'new', '[type]', 'page.tsx'))
    const inForm = (file: string) => form.get(path.join(SRC, ...file.split('/')))
    expect(inForm('ui/liff/requests/request-form.tsx')).toEqual([])
    expect(inForm('ui/liff/requests/details-step.tsx')).toEqual([])
    expect(inForm('ui/liff/requests/step-words.tsx')).toEqual([])
    expect(inForm('ui/request-form/details-items.tsx')).toEqual(['files', 'liffRequests', 'requestForm'])
    expect(inForm('ui/liff/requests/review-step.tsx')).toEqual(['files', 'liffRequests', 'requestForm'])
    expect(inForm('ui/liff/requests/camera-attach.tsx')).toEqual(['files', 'liffRequests', 'requestForm'])
    // A module drawn outside the provider as well has only the page's words (the notice of step 1 and of step 3)
    expect(inForm('ui/liff/notice.tsx')).toEqual([])
  })
})

describe('[NFR-I18N-01] [§9.4] a LIFF part passes its words to a member only, and anyone else sees the gate alone', () => {
  // src/app/liff/_lib/part-messages.tsx: opened without a member's session, a part's provider holds the gate's words
  // (LIFF_GATE_SCOPE) and not the part's. That is right only while the part's pages show anyone but a member the gate and
  // nothing else, and while the gate reads nothing beyond the gate's scope; the gate signs in and refreshes the page, and
  // the part's words come with the page's content.
  const pagesUnder = (dir: string) => entries.filter((entry) => path.basename(entry) === 'page.tsx' && path.dirname(entry).startsWith(dir))

  it('every page under such a part reads the session of the page and shows anyone but a member the gate', () => {
    const memberOnly = [...layouts].filter((entry): entry is [string, LayoutProvider] => {
      const provider = entry[1]
      return provider !== null && provider !== 'unknown' && provider.kind === 'scope' && provider.member === true
    })
    expect(memberOnly.map(([dir]) => rel(dir)).sort()).toEqual(LIFF_PARTS.map(([part]) => `src/app/liff/${part}`).sort())
    const pages = memberOnly.flatMap(([dir]) => pagesUnder(dir))
    expect(pages.length).toBeGreaterThanOrEqual(LIFF_PARTS.length - 1)
    const showsMore = pages.filter((page) => {
      const text = readFileSync(page, 'utf8')
      return !(/\bliffPage\(\)/.test(text) && /if \(page\.kind !== 'member'\)/.test(text) && /<LiffGate\b/.test(text))
    })
    expect(showsMore.map(rel)).toEqual([])
  })

  it('the gate and everything it imports read only the words of the gate scope', () => {
    const gate = path.join(SRC, 'ui', 'liff', 'liff-gate.tsx')
    const modules = clientModulesOf(gate)
    expect(modules.has(gate) && modules.size > 1).toBe(true)
    const problems = [...modules.keys()].flatMap((file) => {
      const missing = missingIn({ kind: 'scope', scope: LIFF_GATE_SCOPE }, moduleInfo(file))
      return missing.length > 0 ? [`${rel(file)} reads ${missing.join(', ')}`] : []
    })
    expect(problems).toEqual([])
    // Every part's scope holds the gate's words, so the gate reads the same with the part's words as without them
    for (const [part, scope] of LIFF_PARTS) for (const gatePath of CLIENT_MESSAGES[LIFF_GATE_SCOPE]) expect(CLIENT_MESSAGES[scope] as readonly string[], part).toContain(gatePath)
  })
})

describe('[NFR-I18N-01] [§9.4] the messages of each scope', () => {
  it('names only namespaces and messages that exist in Thai and in English, and every scope is used by a layout', () => {
    const used = new Set([...layouts.values()].flatMap((p) => (p && p !== 'unknown' && p.kind === 'scope' ? [p.scope] : [])))
    for (const [scope, paths] of Object.entries(CLIENT_MESSAGES)) {
      expect(used.has(scope as keyof typeof CLIENT_MESSAGES), `scope ${scope} is used by a layout`).toBe(true)
      for (const message of paths) {
        for (const [locale, catalogue] of [['th', th] as const, ['en', en] as const]) {
          const value = message.split('.').reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined), catalogue)
          expect(value, `${scope}: ${message} in ${locale}`).toBeDefined()
        }
      }
    }
  })

  it('the root passes only what the error boundary reads, and no LIFF page gets a namespace of the workspace screens', () => {
    expect(CLIENT_MESSAGES.root).toEqual(['app.error'])
    const workspaceOnly = ['adminOrg', 'adminSettings', 'budgets', 'finance', 'procurement', 'purchaseOrder', 'suppliers', 'reports', 'kpi', 'audit', 'board']
    for (const [scope, paths] of Object.entries(CLIENT_MESSAGES)) {
      if (!scope.startsWith('liff')) continue
      expect(paths.filter((p) => workspaceOnly.includes(p.split('.')[0]!)), scope).toEqual([])
    }
  })
})

describe('[§9.4] pickMessages takes the named parts of a catalogue', () => {
  const catalogue = { a: { b: { c: 'C', d: 'D' }, e: 'E' }, f: { g: 'G' }, h: 'H' }

  it('keeps namespaces and single messages in the shape of the catalogue, and leaves out paths that name nothing', () => {
    expect(pickMessages(catalogue, ['a.b.c', 'f', 'h', 'x.y'])).toEqual({ a: { b: { c: 'C' } }, f: { g: 'G' }, h: 'H' })
    expect(pickMessages(catalogue, [])).toEqual({})
  })

  it('takes a namespace whole when a message of it is named too, in either order', () => {
    expect(pickMessages(catalogue, ['a.b.c', 'a.b'])).toEqual({ a: { b: { c: 'C', d: 'D' } } })
    expect(pickMessages(catalogue, ['a', 'a.b.c'])).toEqual({ a: catalogue.a })
  })

  it('never changes the catalogue it picks from', () => {
    const before = JSON.stringify(catalogue)
    const picked = pickMessages(catalogue, ['a.b', 'a.e', 'f']) as { a: { b: Record<string, string> } }
    expect(JSON.stringify(catalogue)).toBe(before)
    expect(picked.a).not.toBe(catalogue.a)
    expect(picked.a.b).toBe(catalogue.a.b)
  })

  it('picks a scope from the real catalogue in both languages with the same keys', () => {
    const keysOf = (node: unknown, prefix = ''): string[] =>
      node && typeof node === 'object' ? Object.entries(node).flatMap(([k, v]) => keysOf(v, prefix ? `${prefix}.${k}` : k)) : [prefix]
    for (const scope of Object.keys(CLIENT_MESSAGES) as Array<keyof typeof CLIENT_MESSAGES>) {
      const thKeys = keysOf(pickMessages(th, CLIENT_MESSAGES[scope])).sort()
      expect(thKeys.length, scope).toBeGreaterThan(0)
      expect(keysOf(pickMessages(en, CLIENT_MESSAGES[scope])).sort(), scope).toEqual(thKeys)
    }
  })
})
