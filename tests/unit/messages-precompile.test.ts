import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { _createCache, _createIntlFormatters, createTranslator } from 'next-intl'
import { describe, expect, it } from 'vitest'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// §9.4 · NFR-I18N-01: next.config.ts compiles the messages when the app is built (next-intl's precompile), and the
// browser formats them without the ICU parser — some 9 KB gzip less in the first JavaScript of every page. This test
// compiles every message of both catalogues as the build does and formats it as the browser then does, next to how the
// app formatted it before (the ICU parser with intl-messageformat), with a value for every argument, every select and
// plural branch the sample takes and every tag: a message the compiler refuses, or one that would read differently,
// fails here with its key.

const fromHere = createRequire(import.meta.url)
const fromNextIntl = createRequire(fromHere.resolve('next-intl'))
const useIntl = fromNextIntl.resolve('use-intl')
const fromUseIntl = createRequire(useIntl)
const fromMessageFormat = createRequire(fromUseIntl.resolve('intl-messageformat'))
const load = async <T>(file: string) => (await import(pathToFileURL(file).href)) as T

/** The compiler the build runs on every message file (icu-minify/compile, next-intl's catalogue loader) */
const { default: compile } = await load<{ default: (message: string) => unknown }>(fromUseIntl.resolve('icu-minify/compile'))
/** What next-intl formats with in the browser once messages are compiled (next.config.ts aliases use-intl to it) */
const { default: formatCompiled } = await load<{ default: (key: string, message: unknown, values: Values, options: object) => unknown }>(
  fromNextIntl.resolve('use-intl/format-message/format-only'),
)
/** The ICU parser, to know the arguments of a message */
const { parse } = await load<{ parse: (message: string) => Element[] }>(fromMessageFormat.resolve('@formatjs/icu-messageformat-parser'))

type Values = Record<string, string | number | Date | ((chunks: string) => string)>
interface Element {
  readonly type: number
  readonly value?: string
  readonly options?: Record<string, { readonly value: Element[] }>
  readonly children?: Element[]
}

// Element types of @formatjs/icu-messageformat-parser
const ARGUMENT = 1
const NUMBER = 2
const DATE = 3
const TIME = 4
const SELECT = 5
const PLURAL = 6
const TAG = 8

const WHEN = new Date('2026-10-04T03:04:05Z')

/** A value for every argument of a message: a word, a number, a date, a select branch, a tag that wraps its words */
function sampleValues(elements: readonly Element[], values: Values = {}): Values {
  for (const element of elements) {
    const name = element.value ?? ''
    if (element.type === ARGUMENT) values[name] ??= 'X'
    else if (element.type === NUMBER) values[name] = 1234.5
    else if (element.type === DATE || element.type === TIME) values[name] = WHEN
    else if (element.type === SELECT) {
      values[name] ??= Object.keys(element.options ?? {}).find((key) => key !== 'other') ?? 'other'
      for (const option of Object.values(element.options ?? {})) sampleValues(option.value, values)
    } else if (element.type === PLURAL) {
      values[name] = 2
      for (const option of Object.values(element.options ?? {})) sampleValues(option.value, values)
    } else if (element.type === TAG) {
      values[name] = (chunks) => `<${name}>${[chunks].flat().join('')}</${name}>`
      sampleValues(element.children ?? [], values)
    }
  }
  return values
}

const flatten = (node: unknown, prefix = ''): Array<[string, string]> =>
  typeof node === 'string' ? [[prefix, node]] : Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => flatten(value, prefix ? `${prefix}.${key}` : key))

describe('[NFR-I18N-01] [§9.4] every message compiles for the browser and reads as it did before', () => {
  for (const [locale, catalogue] of [['th', th] as const, ['en', en] as const]) {
    it(`${locale}: compiles and formats every message the same way`, () => {
      const before = createTranslator({ locale, messages: catalogue, timeZone: 'Asia/Bangkok' }) as unknown as { markup(key: string, values?: Values): string }
      const options = { locale, timeZone: 'Asia/Bangkok', cache: _createCache(), formatters: _createIntlFormatters(_createCache()) }
      const refused: string[] = []
      const differ: string[] = []
      const messages = flatten(catalogue)
      for (const [key, message] of messages) {
        let compiled: unknown
        try {
          compiled = compile(message)
        } catch (error) {
          refused.push(`${key}: ${(error as Error).message}`)
          continue
        }
        const values = sampleValues(parse(message))
        const was = before.markup(key, values)
        const now = [formatCompiled(key, compiled, values, options)].flat().join('')
        if (now !== was) differ.push(`${key}: "${was}" → "${now}"`)
      }
      expect(messages.length).toBeGreaterThan(4000)
      expect(refused).toEqual([])
      expect(differ).toEqual([])
    })
  }

  it('leaves a message without arguments as it is, and turns one with arguments into its compiled form', () => {
    expect(compile('ทำรายการไม่สำเร็จ')).toBe('ทำรายการไม่สำเร็จ')
    expect(compile("Supplier's register status changed")).toBe("Supplier's register status changed")
    expect(Array.isArray(compile('รหัสอ้างอิง {reference}'))).toBe(true)
  })
})
