import type { BadgeLook } from '../document/badge-looks'

// The supplier's risk status as a badge (S11-10 · BR-RSK-14): §9.10 has no row for it, so it follows the table's way — a
// tone with an icon and a word, never colour alone (NFR-A11Y-03). Assessed is fine (ok), due soon a thing to look at
// (warn), overdue and "reassess" what blocks or needs work (danger), the rest plain.

export const SUPPLIER_RISK_STATUSES = ['NOT_ASSESSED', 'IN_PROGRESS', 'CURRENT', 'EXPIRING', 'OVERDUE', 'REASSESS_REQUIRED'] as const
export type SupplierRiskStatusUi = (typeof SUPPLIER_RISK_STATUSES)[number]

export const SUPPLIER_RISK_BADGES: Readonly<Record<SupplierRiskStatusUi, BadgeLook>> = {
  NOT_ASSESSED: { tone: 'neutral', icon: 'CircleDot' },
  IN_PROGRESS: { tone: 'info', icon: 'Hourglass' },
  CURRENT: { tone: 'ok', icon: 'CircleCheck' },
  EXPIRING: { tone: 'warn', icon: 'AlarmClock' },
  OVERDUE: { tone: 'danger', icon: 'Clock' },
  REASSESS_REQUIRED: { tone: 'danger', icon: 'Undo2' },
}

export const isSupplierRiskStatus = (value: string): value is SupplierRiskStatusUi => (SUPPLIER_RISK_STATUSES as readonly string[]).includes(value)
