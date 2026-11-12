import type { TenantTx } from '@/server/db/tenant'

// The risk overrides a payment run weighs (S11-08 · FR-RSK-203 AC5 · FR-PAY-101 AC13 · §8.12): the flag
// RISK_OVERRIDE_EXPIRED of S9's itemFlags comes from here, into the engine's `riskOverrides` (the engine and GC-PAY-30
// GC-PAY-31 unchanged). A query, not a service, because the run's own query (runFlagsNow) reads it too and queries do not
// import services; services/risk/overrides.ts hands the same function to the services of S9.

/**
 * Per supplier, the override that speaks for it on `on` (the run's pay date): the APPROVED or EXPIRED one with the
 * latest last day — an older one that ran out does not flag a supplier a newer one covers. Nothing for a supplier whose
 * COMPLETED assessment is still valid on that day (it was assessed: the override is history), and nothing at all with
 * RISK off.
 */
export async function riskOverridesForPayment(tx: TenantTx, supplierIds: readonly string[], on: string): Promise<Map<string, readonly { readonly expiresOn: string }[]>> {
  const out = new Map<string, readonly { readonly expiresOn: string }[]>()
  const ids = [...new Set(supplierIds)]
  if (ids.length === 0) return out
  // one query at a time: they share the transaction's connection
  const risk = await tx.orgModule.findFirst({ where: { module: 'RISK', enabled: true }, select: { id: true } })
  if (!risk) return out
  const overrides = await tx.riskOverride.findMany({
    where: { supplierId: { in: ids }, status: { in: ['APPROVED', 'EXPIRED'] } },
    orderBy: [{ expiresOn: 'desc' }, { id: 'asc' }],
    select: { supplierId: true, expiresOn: true },
  })
  if (overrides.length === 0) return out
  const assessed = await tx.riskAssessment.findMany({
    where: { supplierId: { in: [...new Set(overrides.map((o) => o.supplierId))] }, status: 'COMPLETED', validUntil: { gte: new Date(`${on}T00:00:00Z`) } },
    select: { supplierId: true },
  })
  const done = new Set(assessed.map((a) => a.supplierId))
  for (const o of overrides) {
    if (done.has(o.supplierId) || out.has(o.supplierId)) continue
    out.set(o.supplierId, [{ expiresOn: o.expiresOn.toISOString().slice(0, 10) }])
  }
  return out
}
