// How a DOA or workflow version's withdrawal stands, for its admin page (FR-DOA-104 · FR-WF-103, S6-07): whether it can
// be asked now — PUBLISHED, still ahead and nothing asked yet — and whether this reader may ask it (the capability to
// send that kind of version, checked by the caller); a withdrawal waiting for its decision, or done, with who asked,
// when and why. The request command checks every rule again; this only says what the page offers.

export interface WithdrawalPerson {
  readonly id: string
  readonly nameTh: string
  readonly nameEn: string | null
}

export interface WithdrawalView {
  /** PUBLISHED, its start still ahead, and no withdrawal waits: a withdrawal may be asked */
  readonly requestable: boolean
  /** This reader may ask it (admin.doa.submitForPublish · admin.workflow.submitForPublish) */
  readonly allowed: boolean
  /** A withdrawal waits for its decision */
  readonly pending: boolean
  /** WITHDRAWN: when */
  readonly withdrawnAt: string | null
  readonly requestedBy: WithdrawalPerson | null
  readonly requestedAt: string | null
  readonly reason: string | null
}

interface WithdrawalRow {
  readonly status: string
  readonly effectiveFrom: Date
  readonly withdrawalRequestedAt: Date | null
  readonly withdrawalRequestedById: string | null
  readonly withdrawalReason: string | null
  readonly withdrawnAt: Date | null
}

export function withdrawalView(row: WithdrawalRow, person: (id: string | null) => WithdrawalPerson | null, now: Date, allowed: boolean): WithdrawalView {
  // As withdrawalPending of ./index says it (not imported: the admin views stay clear of the command's imports)
  const pending = row.status === 'PUBLISHED' && row.withdrawalRequestedAt !== null
  const withdrawn = row.status === 'WITHDRAWN'
  // A rejected withdrawal clears who asked; a withdrawn version keeps it
  const asked = pending || withdrawn
  return {
    requestable: row.status === 'PUBLISHED' && !pending && row.effectiveFrom.getTime() > now.getTime(),
    allowed,
    pending,
    withdrawnAt: withdrawn && row.withdrawnAt ? row.withdrawnAt.toISOString() : null,
    requestedBy: asked ? person(row.withdrawalRequestedById) : null,
    requestedAt: asked && row.withdrawalRequestedAt ? row.withdrawalRequestedAt.toISOString() : null,
    reason: asked ? row.withdrawalReason : null,
  }
}
