import type { FlexBox, FlexComponent, FlexText } from './types'

// The look of the LINE cards, from the screen tokens of spec §9.9: one quiet card, no gradient, the approve button the
// only filled one, and every status said in words as well as colour (NFR-A11Y-03). Text is LINE's "md" (16 px on a
// phone) except the heading.

export const INK = '#1C2B33'
export const INK_MUTED = '#4A5A63'
export const PRIMARY = '#0B6E5F'
export const WARN = '#9A5B00'
export const DANGER = '#B42318'
export const SURFACE = '#F5F7F8'
export const LINE_COLOR = '#DDE3E7'

export const heading = (text: string, color = INK): FlexText => ({ type: 'text', text, weight: 'bold', size: 'lg', color, wrap: true })

export const plain = (text: string, color = INK): FlexText => ({ type: 'text', text, size: 'md', color, wrap: true })

/** A label and its value on one line; the value wraps under itself */
export function row(label: string, value: string, valueColor = INK): FlexBox {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'md',
    contents: [
      { type: 'text', text: label, size: 'md', color: INK_MUTED, flex: 2, wrap: true },
      { type: 'text', text: value, size: 'md', color: valueColor, flex: 5, wrap: true },
    ],
  }
}

export const vertical = (contents: readonly FlexComponent[], extra: Partial<Omit<FlexBox, 'type' | 'layout' | 'contents'>> = {}): FlexBox => ({ type: 'box', layout: 'vertical', contents, ...extra })
