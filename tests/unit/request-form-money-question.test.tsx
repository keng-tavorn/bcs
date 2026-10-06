import { NextIntlClientProvider } from 'next-intl'
import { isValidElement, useState, type ChangeEvent, type FocusEvent, type InputHTMLAttributes, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { formDataSchema, type FieldDef } from '@/core/forms/fields'
import { MONEY_TEXT } from '@/core/forms/money-text'
import { LiffField } from '@/ui/liff/requests/field'
import { FieldInput } from '@/ui/request-form/field-input'
import { moneyShown, plainMoney } from '@/ui/request-form/money'
import { MoneyInput } from '@/ui/request-form/money-input'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// FR-PLT-002 AC3 · §9.9 principle 6 · FR-INT-002: a question of type money in a request type's form — the workspace's
// field (src/ui/request-form/field-input.tsx) and the LIFF one (src/ui/liff/requests/field.tsx), both with the money
// input of the lines and quotations (src/ui/request-form/money-input.tsx) — reads as money: grouped by thousands with two
// decimals while it is not being edited, the raw digits while it is, and the answer the form keeps and saves is the
// plain digits the server takes (MONEY_TEXT), whether the person typed separators or not. The demo forms ask no such
// question, so no screenshot shows it: these tests draw the field. No DOM here: the field is drawn as static markup, and
// played — focused, typed into, left — by a probe that runs the field's own handlers while it renders (play below).

type Locale = 'th' | 'en'

const html = (node: ReactNode, locale: Locale = 'th') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : th} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )

/** A money question as an organization's form may ask it (FR-ADM-005): no hint of its own, so the form's hint shows */
const ESTIMATE: FieldDef = { id: 'estimatedCost', type: 'money', required: true, label: { th: 'ค่าใช้จ่ายโดยประมาณ', en: 'Estimated cost' } }

/** The two fields that draw a question of the form */
const FIELDS = [
  { name: 'web', Field: FieldInput },
  { name: 'LIFF', Field: LiffField },
] as const
type FieldComponent = (typeof FIELDS)[number]['Field']

/** The question's input, as the markup of its field holds it */
function inputOf(markup: string): string {
  const input = /<input[^>]*id="field-estimatedCost"[^>]*>/.exec(markup)?.[0]
  expect(input, 'the field has its input').toBeDefined()
  return input!
}
const valueOf = (input: string) => /\svalue="([^"]*)"/.exec(input)?.[1]

const drawn = (Field: FieldComponent, answer: unknown, locale: Locale = 'th') => html(<Field def={ESTIMATE} value={answer} onChange={() => undefined} locale={locale} />, locale)

describe('[FR-PLT-002/AC3] [FR-INT-002/AC1] a money question of a request type’s form reads as money while it is not being edited, on the web and in LIFF', () => {
  it.each(FIELDS)('$name: the answer grouped by thousands with two decimals, right-aligned in tabular digits, over the phone’s keypad of digits', ({ Field }) => {
    const page = drawn(Field, '140000')
    const input = inputOf(page)
    expect(valueOf(input)).toBe('140,000.00')
    expect(input).toContain('name="estimatedCost"')
    expect(input).toContain('inputMode="decimal"')
    expect(input).toMatch(/class="[^"]*\btabular\b[^"]*\btext-right\b/)
    expect(input).toContain('required=""')
    // Its label, and the form's hint for an amount tied to it: separators may be typed, and come out of the answer
    expect(page).toMatch(/<label for="field-estimatedCost"[^>]*>ค่าใช้จ่ายโดยประมาณ/)
    expect(input).toContain('aria-describedby="field-estimatedCost-hint"')
    expect(page).toMatch(/<p id="field-estimatedCost-hint"[^>]*>จำนวนเงินเป็นบาท เช่น 1500 หรือ 1,500.50<\/p>/)
    expect(drawn(Field, '140000', 'en')).toMatch(/<p id="field-estimatedCost-hint"[^>]*>An amount in baht, for example 1500 or 1,500.50<\/p>/)
  })

  it.each(FIELDS)('$name: every amount the server takes reads with two decimals; no answer yet, or text that is no amount, as it is', ({ Field }) => {
    const shown = (answer: unknown) => valueOf(inputOf(drawn(Field, answer)))
    expect(shown('1500.5')).toBe('1,500.50')
    expect(shown('0.75')).toBe('0.75')
    expect(shown('9999999999999.99')).toBe('9,999,999,999,999.99')
    expect(shown(undefined)).toBe('')
    expect(shown('')).toBe('')
    // Not an amount: as typed, for the server's refusal beside it to name
    expect(shown('12a')).toBe('12a')
    expect(shown('1.234')).toBe('1.234')
  })
})

/** One thing a person does to the field's input: its handler, called with what the browser would hand it */
type Step = (input: InputHTMLAttributes<HTMLInputElement>) => void
const focus: Step = (input) => input.onFocus?.({} as FocusEvent<HTMLInputElement>)
const type = (text: string): Step => (input) => input.onChange?.({ currentTarget: { value: text } } as ChangeEvent<HTMLInputElement>)
const leave: Step = (input) => input.onBlur?.({} as FocusEvent<HTMLInputElement>)

/** What the input shows and the answer the form keeps, at one moment */
interface Seen {
  readonly shown: string
  readonly answer: unknown
}

/** The element of `type` in a tree of elements as a component returns it (not rendered) */
function elementOf<P>(node: ReactNode, type: (props: P) => ReactNode): ReactElement<P> {
  const queue: ReactNode[] = [node]
  while (queue.length) {
    const next = queue.shift()
    if (Array.isArray(next)) queue.push(...(next as ReactNode[]))
    else if (isValidElement<{ readonly children?: ReactNode }>(next)) {
      if (next.type === type) return next as unknown as ReactElement<P>
      queue.push(next.props.children)
    }
  }
  throw new Error(`the field draws no ${type.name}`)
}

/**
 * The question with its form around it: the probe keeps the answer as the form does (FormAction 'field' stores what the
 * field hands on), draws the field, and runs the field's money input inside itself, so that the input's handlers, which
 * `onRender` calls while the probe renders, update the probe's own state. React then draws the probe again at once — on
 * the server too (an update during render) — until a render calls no handler.
 */
function Probe({ Field, onRender }: { readonly Field: FieldComponent; readonly onRender: (input: InputHTMLAttributes<HTMLInputElement>, answer: unknown) => void }) {
  const [answer, setAnswer] = useState<unknown>(undefined)
  const money = elementOf(Field({ def: ESTIMATE, value: answer, onChange: setAnswer, locale: 'th' }), MoneyInput)
  const input = MoneyInput(money.props)
  onRender(input.props as InputHTMLAttributes<HTMLInputElement>, answer)
  return null
}

/** Plays `steps` on the question, one a render: what it showed and kept before the first step and after each */
function play(Field: FieldComponent, steps: readonly Step[]): Seen[] {
  const seen: Seen[] = []
  let next = 0
  html(
    <Probe
      Field={Field}
      onRender={(input, answer) => {
        seen.push({ shown: String(input.value), answer })
        if (next < steps.length) steps[next++]!(input)
      }}
    />,
  )
  expect(next, 'every step was played').toBe(steps.length)
  return seen
}

describe('[FR-PLT-002/AC3] [FR-INT-002/AC1] a money question shows the raw digits while it is edited, and keeps the plain digits the server takes', () => {
  it.each(FIELDS)('$name: typed with separators, read once left, edited again from its raw digits', ({ Field }) => {
    const seen = play(Field, [focus, type('140,000.5'), leave, focus, type('150000'), leave])
    expect(seen).toEqual<Seen[]>([
      { shown: '', answer: undefined },
      // Focused with no answer yet: nothing to show
      { shown: '', answer: undefined },
      // While edited: the text as typed; the form keeps the plain digits
      { shown: '140,000.5', answer: '140000.5' },
      // Left: grouped by thousands with two decimals
      { shown: '140,000.50', answer: '140000.5' },
      // Edited again: the raw digits the form holds, no separators added
      { shown: '140000.5', answer: '140000.5' },
      { shown: '150000', answer: '150000' },
      { shown: '150,000.00', answer: '150000' },
    ])
  })

  it.each(FIELDS)('$name: what the form keeps is the answer the server takes for a money question (MONEY_TEXT), however the amount was typed', ({ Field }) => {
    const server = formDataSchema([ESTIMATE])
    for (const [typed, kept] of [
      ['140000', '140000'],
      ['1,500.50', '1500.50'],
      [' 2 500 ', '2500'],
      ['1,234,567.8', '1234567.8'],
    ] as const) {
      const seen = play(Field, [focus, type(typed), leave])
      expect(seen.at(-1)!.answer, typed).toBe(kept)
      expect(kept).toMatch(MONEY_TEXT)
      expect(server.safeParse({ estimatedCost: kept }).success, typed).toBe(true)
      expect(seen.at(-1)!.shown, typed).toBe(moneyShown(kept, null))
    }
    // Text that is no amount is kept as it is, separators aside: the server refuses it and names the question
    const wrong = play(Field, [focus, type('12a'), leave]).at(-1)!
    expect(wrong).toEqual<Seen>({ shown: '12a', answer: '12a' })
    expect(server.safeParse({ estimatedCost: wrong.answer }).success).toBe(false)
  })

  it('reads an amount without its separators and spaces, as the lines do (model.ts plainNumber), and shows what is typed while edited', () => {
    expect(plainMoney('140,000.50 ')).toBe('140000.50')
    expect(plainMoney(' 2 500 ')).toBe('2500')
    expect(plainMoney('12a')).toBe('12a')
    expect(moneyShown('140000', null)).toBe('140,000.00')
    expect(moneyShown('140000', '140000')).toBe('140000')
    expect(moneyShown('140000', '140,000')).toBe('140,000')
    expect(moneyShown('12a', null)).toBe('12a')
  })
})
