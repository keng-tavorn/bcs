import type { NumberingRefusalView, SettingsFailure, SettingsOutcome } from './outcome'

// Shapes and constants of the numbering page, shared by the page (server) and its form (client). A 'use client' module
// can hand a server component only components, so these live here.

export const NUMBER_DOCUMENTS = ['PR', 'PO', 'GR', 'RQ'] as const
export type NumberDocument = (typeof NUMBER_DOCUMENTS)[number]
export const NUMBER_RESETS = ['YEARLY', 'MONTHLY', 'NEVER'] as const
export type NumberReset = (typeof NUMBER_RESETS)[number]
/** A running number of width 5, as the help and the messages show it */
export const SEQ_EXAMPLE = '{SEQ5}'
export const DEPT_TOKEN = '{DEPT}'
/** The codes of BR-NUM-02 as written in a pattern, with their key under adminSettings.numbering.tokens */
export const PATTERN_TOKENS = [
  ['{BE}', 'BE'],
  ['{YY}', 'YY'],
  ['{CE}', 'CE'],
  ['{MM}', 'MM'],
  ['{DEPT}', 'DEPT'],
  ['{SEQn}', 'SEQ'],
] as const

export interface NumberPreviewView {
  readonly nextNumber: string | null
  readonly continues: boolean
  readonly department: string | null
  readonly refusal: NumberingRefusalView | null
}

export type PreviewNumberingAction = (input: { document: NumberDocument; pattern: string; reset: NumberReset; department?: string }) => Promise<
  { readonly ok: true; readonly preview: NumberPreviewView } | SettingsFailure
>
export type SaveNumberingAction = (input: { document: NumberDocument; pattern: string; reset: NumberReset }, idempotencyKey: string) => Promise<SettingsOutcome>
