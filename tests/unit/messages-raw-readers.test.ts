import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// §9.4 · NFR-I18N-01: next.config.ts compiles the messages when the app is built (next-intl's precompile). In every build
// a message with an argument or a tag is then its compiled form — an array, not text — wherever the app reads it, while
// TypeScript and Vitest (no build loader) still see the text. next-intl formats both the same (messages-precompile.test.ts),
// but code that reads message values itself — getMessages() or useMessages() and then a value, t.raw(), an import of a
// messages/ file — would show the compiled form, and in a production build only. This test finds every such reader in
// src and fails on one it does not know: a new reader formats its words through next-intl (useTranslations,
// getTranslations, a provider of its own as src/app/global-error.tsx), or is added here with the messages it reads as
// text, and each of those must stay plain text (no argument, no tag) in Thai and in English.

const ROOT = path.resolve(import.meta.dirname, '../..')
const SRC = path.join(ROOT, 'src')
const rel = (file: string) => path.relative(ROOT, file).replaceAll('\\', '/')

/** What a reader does with the messages: hands them to next-intl to format, or reads these messages as text */
type Use = { readonly formats: string } | { readonly asText: readonly string[]; readonly why: string }

const READERS: Readonly<Record<string, Use>> = {
  'src/i18n/request.ts': { formats: 'the catalogue of next-intl on the server' },
  'src/app/_lib/client-messages.tsx': { formats: 'the messages of a part of the app, handed to NextIntlClientProvider' },
  'src/app/global-error.tsx': { formats: 'the app namespace, through a NextIntlClientProvider of its own' },
  'src/app/(workspace)/audit/page.tsx': { asText: ['audit.events', 'audit.groups', 'audit.aggregate'], why: 'the names of event types, their groups and the documents in the search and the rows' },
  'src/app/offline/route.ts': { asText: ['pwa.offlineTitle', 'pwa.offlineBody', 'pwa.retry'], why: 'the offline page is plain HTML the service worker keeps' },
}

/** The ways code reads message values itself */
const READS = [
  { name: 'getMessages()', test: (text: string) => /\bgetMessages\s*\(/.test(text) },
  { name: 'useMessages()', test: (text: string) => /\buseMessages\s*\(/.test(text) },
  // Static, dynamic and template imports of a messages file (an import of types only reads no value)
  { name: 'an import of a messages file', test: (text: string) => /(?:^|\n)\s*import\s+(?!type\b)[^'"`;]*?from\s*['"][^'"]*messages\/[^'"]*\.json['"]|\bimport\(\s*['"`][^'"`]*messages\/[^'"`]*\.json['"`]\s*\)/.test(text) },
  // t.raw() of a translator: in a file that reads messages through next-intl
  { name: 't.raw()', test: (text: string) => /from\s*['"]next-intl(?:\/server)?['"]/.test(text) && /\.raw\s*\(/.test(text) },
] as const

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? filesUnder(full) : /\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [full] : []
  })
}

const found = new Map<string, string[]>()
for (const file of filesUnder(SRC)) {
  const text = readFileSync(file, 'utf8')
  const ways = READS.filter((way) => way.test(text)).map((way) => way.name)
  if (ways.length > 0) found.set(rel(file), ways)
}

/** The compiler the build runs on every message file (next.config.ts: next-intl's catalogue loader, icu-minify) */
const fromNextIntl = createRequire(createRequire(import.meta.url).resolve('next-intl'))
const fromUseIntl = createRequire(fromNextIntl.resolve('use-intl'))
const { default: compile } = (await import(pathToFileURL(fromUseIntl.resolve('icu-minify/compile')).href)) as { default: (message: string) => unknown }

/** Every message under a path of a catalogue, with its key */
function messagesUnder(catalogue: unknown, at: string): Array<[string, unknown]> {
  const node = at.split('.').reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), catalogue)
  const flatten = (value: unknown, key: string): Array<[string, unknown]> =>
    value && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => flatten(v, `${key}.${k}`)) : [[key, value]]
  return node === undefined ? [] : flatten(node, at)
}

describe('[NFR-I18N-01] [§9.4] code that reads message values itself, with messages compiled when the app is built', () => {
  it('knows every reader of message values in src, and every reader it knows still reads them', () => {
    const unknown = [...found].filter(([file]) => !Object.hasOwn(READERS, file)).map(([file, ways]) => `${file}: ${ways.join(', ')}`)
    expect(unknown, 'format these words through next-intl, or list the file in READERS with the messages it reads as text').toEqual([])
    expect(Object.keys(READERS).filter((file) => !found.has(file))).toEqual([])
  })

  it('reads as text only messages without an argument or a tag, which stay text when compiled, in Thai and in English', () => {
    const problems: string[] = []
    for (const [file, use] of Object.entries(READERS)) {
      if (!('asText' in use)) continue
      for (const at of use.asText) {
        for (const [locale, catalogue] of [['th', th] as const, ['en', en] as const]) {
          const messages = messagesUnder(catalogue, at)
          if (messages.length === 0) problems.push(`${file}: ${at} is not in ${locale}`)
          for (const [key, message] of messages) {
            if (typeof message !== 'string' || typeof compile(message) !== 'string') problems.push(`${file}: ${locale} ${key} is not plain text once compiled`)
          }
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('tells a message with an argument from plain text as the build does', () => {
    expect(compile('ไม่มีการเชื่อมต่ออินเทอร์เน็ต')).toBe('ไม่มีการเชื่อมต่ออินเทอร์เน็ต')
    expect(typeof compile('รหัสอ้างอิง {reference}')).not.toBe('string')
    expect(typeof compile('อ่าน <b>ก่อน</b>')).not.toBe('string')
  })
})
