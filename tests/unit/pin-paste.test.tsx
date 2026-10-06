import { isValidElement, type ChangeEvent, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PinInput, pinDigits } from '@/ui/liff/pin-input'
import { PinField, pinFieldDigits } from '@/ui/tasks/pin-field'

// FR-AUTH-005 AC2 · a PIN pasted into the decision's PIN field keeps all six digits: on the web (/tasks/[id],
// src/ui/tasks/pin-field.tsx) and in LIFF (/liff/tasks/[id], src/ui/liff/pin-input.tsx). A PIN copied from a note is often
// "582 931" or "58-29-31": seven or eight characters. With maxLength=6 the browser cuts the paste to "582 93" before the
// field picks out the digits, so the field holds "58293" — masked, nobody sees a digit went missing, and the decision is
// refused as a wrong PIN, which counts toward the lock (FR-AUTH-005 AC3). So neither field has a maxLength: each change
// keeps the digits, at most six. No DOM here: the server's HTML is read for the attribute, and the field's own change
// handler is called with what the browser hands it after a paste (the e2e of /settings/pin pastes for real).

// The web field waits for the page's script (src/ui/form/hydrated.ts): here the script runs
vi.mock('@/ui/form/hydrated', () => ({ useHydrated: () => true }))

type InputProps = { readonly onChange?: (event: ChangeEvent<HTMLInputElement>) => void; readonly children?: ReactNode }

/** The element that carries the field's change handler: the input itself, or the shared Field it is drawn with */
function changeHandlerOf(node: ReactNode): (event: ChangeEvent<HTMLInputElement>) => void {
  const queue: ReactNode[] = [node]
  while (queue.length) {
    const next = queue.shift()
    if (Array.isArray(next)) queue.push(...(next as ReactNode[]))
    else if (isValidElement(next)) {
      const element = next as ReactElement<InputProps>
      if (typeof element.props.onChange === 'function') return element.props.onChange
      queue.push(element.props.children)
    }
  }
  throw new Error('no change handler')
}

/** What the field hands on when the browser's value becomes `pasted` (the whole value after the paste) */
function afterPaste(field: ReactNode, pasted: string, kept: string[]): string {
  changeHandlerOf(field)({ currentTarget: { value: pasted } } as ChangeEvent<HTMLInputElement>)
  return kept.at(-1)!
}

const PASTES: ReadonlyArray<readonly [string, string]> = [
  ['582 931', '582931'],
  ['58-29-31', '582931'],
  [' 582931 ', '582931'],
  // A seventh digit does not fit
  ['582 9317', '582931'],
  // Anything but the digits 0–9 is dropped
  ['58a9-1', '5891'],
]

describe('[FR-AUTH-005/AC2] the web decision’s PIN field keeps all six digits of a pasted PIN', () => {
  const field = (kept: string[]) => PinField({ id: 'pin', label: 'PIN', value: '', onChange: (v) => kept.push(v) })

  it('has no maxLength for the browser to cut a paste with', () => {
    const markup = renderToStaticMarkup(<PinField id="pin" label="PIN" value="" onChange={() => undefined} />)
    expect(markup).toMatch(/<input[^>]*\bid="pin"/)
    expect(markup).not.toMatch(/maxlength=/i)
  })

  it.each(PASTES)('a paste of %j leaves %j in the field', (pasted, digits) => {
    const kept: string[] = []
    expect(afterPaste(field(kept), pasted, kept)).toBe(digits)
    expect(pinFieldDigits(pasted)).toBe(digits)
  })
})

describe('[FR-AUTH-005/AC2] [FR-LINE-003/AC2] the LIFF decision’s PIN field keeps all six digits of a pasted PIN', () => {
  const field = (kept: string[]) => PinInput({ id: 'pin', label: 'PIN', length: 6, value: '', onChange: (v) => kept.push(v) })

  it('has no maxLength for the browser to cut a paste with', () => {
    const markup = renderToStaticMarkup(<PinInput id="pin" label="PIN" length={6} value="" onChange={() => undefined} />)
    expect(markup).toMatch(/<input[^>]*\bid="pin"/)
    expect(markup).not.toMatch(/maxlength=/i)
  })

  it.each(PASTES)('a paste of %j leaves %j in the field', (pasted, digits) => {
    const kept: string[] = []
    expect(afterPaste(field(kept), pasted, kept)).toBe(digits)
    expect(pinDigits(pasted, 6)).toBe(digits)
  })
})
