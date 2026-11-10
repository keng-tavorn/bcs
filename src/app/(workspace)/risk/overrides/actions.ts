'use server'

import { cancelRiskOverride, requestRiskOverride, submitRiskOverride, updateRiskOverride } from '@/server/services/risk'
import { runRiskCommand } from '../_outcome'

// Browser-facing adapters of /risk/overrides (S11-08 · FR-RSK-203 AC2 · BR-RSK-10): the session, then the service, which
// checks the RISK module, risk.override.request, that the reader asked for it, its state and its terms every time
// (BR-AUTH-05).

const page = (id: string) => `/risk/overrides/${id}`

export interface OverrideFields {
  readonly reason: string
  readonly capGross: string
  readonly expiresOn: string
}

export async function requestOverrideAction(supplierId: string, poId: string | null, fields: OverrideFields, key: string) {
  return runRiskCommand(key, (ctx) => requestRiskOverride(ctx, { supplierId, poId, ...fields }, { idempotencyKey: key }), '/risk/overrides', (d) => d.overrideId)
}

export async function updateOverrideAction(overrideId: string, expectedVersion: number, fields: OverrideFields, key: string) {
  return runRiskCommand(key, (ctx) => updateRiskOverride(ctx, { overrideId, expectedVersion, ...fields }, { idempotencyKey: key }), page(overrideId))
}

export async function submitOverrideAction(overrideId: string, expectedVersion: number, key: string) {
  return runRiskCommand(key, (ctx) => submitRiskOverride(ctx, { overrideId, expectedVersion }, { idempotencyKey: key }), page(overrideId))
}

export async function cancelOverrideAction(overrideId: string, expectedVersion: number, key: string) {
  return runRiskCommand(key, (ctx) => cancelRiskOverride(ctx, { overrideId, expectedVersion }, { idempotencyKey: key }), page(overrideId))
}
