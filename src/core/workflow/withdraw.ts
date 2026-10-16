import { err, ok, type Result } from '@/core/result'

// Withdrawing an approved version before it takes effect (spec §7.17 · FR-DOA-104 · BR-DOA-18, and FR-WF-103 for a
// workflow version by the same rule): the version becomes WITHDRAWN and the version it was to follow runs on — until
// the next version still waiting after it, or with no end. A version in effect already cannot be withdrawn. Pure: the
// versions of one code and the time are parameters; the caller stores what comes back.

export interface PeriodVersion {
  readonly versionNo: number
  readonly status: string
  readonly effectiveFrom: Date
  readonly effectiveTo: Date | null
}

const LIVE = ['PUBLISHED', 'SUPERSEDED']

export function withdrawVersion<V extends PeriodVersion>(versions: readonly V[], versionNo: number, at: Date): Result<{ readonly versions: V[] }> {
  const target = versions.find((v) => v.versionNo === versionNo)
  if (!target) return err('NOT_FOUND', 'no such version', { versionNo })
  if (target.status !== 'PUBLISHED') return err('INVALID_STATE_TRANSITION', 'only an approved version is withdrawn', { reason: 'NOT_PUBLISHED', from: target.status })
  if (target.effectiveFrom.getTime() <= at.getTime()) return err('INVALID_STATE_TRANSITION', 'the version is in effect already', { reason: 'ALREADY_EFFECTIVE' })
  const start = target.effectiveFrom.getTime()
  // The next version still to come after this one, if any: the one before it now runs until that one starts
  const next = versions
    .filter((v) => v !== target && v.status === 'PUBLISHED' && v.effectiveFrom.getTime() > start)
    .sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime())[0]
  return ok({
    versions: versions.map((v) => {
      if (v === target) return { ...v, status: 'WITHDRAWN' } as V
      if (LIVE.includes(v.status) && v.effectiveTo !== null && v.effectiveTo.getTime() === start) return { ...v, effectiveTo: next ? next.effectiveFrom : null }
      return v
    }),
  })
}
