import { z } from 'zod'
import { BASIS_POINTS_WHOLE } from '@/lib/constants'
import { defineEvents } from '../registry'

// S10 sourcing (docs/sub-specs/S10.md "event"): codes, ids and counts — never a price of a sealed RFx, a supplier's text or a
// contact's e-mail (BR-RFX-06 · NFR-SEC-09).

const ISO = z.iso.datetime({ offset: true })
const fields = z.array(z.string().max(40))

defineEvents('RfxEvent', {
  'rfx.created': {
    schema: z.object({ kind: z.enum(['RFQ', 'RFP', 'RFI']), sourceKind: z.enum(['REQUEST_LINES', 'NEED']), categoryCode: z.string(), requestLineIds: z.array(z.uuid()), sealed: z.boolean(), minInvites: z.int().min(1) }),
  },
  'rfx.updated': { schema: z.object({ fields: fields.min(1), reasonCommentId: z.uuid().optional() }) },
  // BR-RFX-06: prices seen before the close, with the reason as a comment
  'rfx.unsealed': { schema: z.object({ reasonCommentId: z.uuid() }) },
  'rfx.lines_changed': { schema: z.object({ added: z.int().min(0), removed: z.int().min(0), requestLineIds: z.array(z.uuid()), minInvites: z.int().min(1) }) },
  'rfx.opened': {
    schema: z.object({ number: z.string(), closesAt: ISO, questionCutoffAt: ISO, inviteCount: z.int().min(1), minInvites: z.int().min(1), fewerInvitesReasonCommentId: z.uuid().nullable(), sealed: z.boolean() }),
  },
  'rfx.amended': { schema: z.object({ revisionNo: z.int().min(2), changedFields: fields.min(1), closesAt: ISO.nullable() }) },
  'rfx.extended': { schema: z.object({ from: ISO, to: ISO, closesAt: ISO }) },
  'rfx.reminded': { schema: z.object({ invites: z.int().min(1), revisionNo: z.int().min(1), closesAt: ISO }) },
  'rfx.closed': { schema: z.object({ bidCount: z.int().min(0), declinedCount: z.int().min(0), early: z.boolean() }) },
  // a supplier's question: its id, never its words (BR-RFX-04)
  'rfx.question_asked': { schema: z.object({ questionId: z.uuid(), inviteId: z.uuid() }) },
  'rfx.question_answered': { schema: z.object({ questionId: z.uuid(), visibility: z.enum(['ALL', 'ASKER']), notified: z.int().min(0), originalCommentId: z.uuid().nullable(), reasonCommentId: z.uuid().nullable() }) },
  // S10-08: the first score saved (or an evaluator added) after the close
  'rfx.evaluating': { schema: z.object({ by: z.enum(['SCORE', 'EVALUATOR_ADDED']) }) },
  'rfx.concluded': { schema: z.object({ requestLineIds: z.array(z.uuid()) }) },
  // S10-10: the award approved (BR-RFX-12 · BR-RFX-13)
  'rfx.awarded': { schema: z.object({ awardDecisionId: z.uuid() }) },
  'rfx.cancelled': { schema: z.object({ reasonCommentId: z.uuid(), requestLineIds: z.array(z.uuid()) }) },
  'rfx.reopened': { schema: z.object({ fromRfxEventId: z.uuid(), requestLineIds: z.array(z.uuid()) }) },
})

defineEvents('RfxInvite', {
  'rfx_invite.created': {
    schema: z.object({ rfxEventId: z.uuid(), supplierId: z.uuid().nullable(), applicationId: z.uuid().nullable(), afterOpen: z.boolean(), riskBlocked: z.boolean().nullable() }),
  },
  'rfx_invite.removed': { schema: z.object({ rfxEventId: z.uuid(), reasonCommentId: z.uuid() }) },
  'rfx_invite.expired': { schema: z.object({ rfxEventId: z.uuid() }) },
  // S10-06: the detail page's POST once per invite; a decline says whether a reason was given, never the reason
  'rfx_invite.viewed': { schema: z.object({ rfxEventId: z.uuid() }) },
  'rfx_invite.declined': { schema: z.object({ rfxEventId: z.uuid(), withReason: z.boolean() }) },
  // ADR-203: the application of an invite was approved and became this supplier
  'rfx_invite.supplier_linked': { schema: z.object({ rfxEventId: z.uuid(), applicationId: z.uuid(), supplierId: z.uuid() }) },
})

const RankingRow = z.object({ bidId: z.uuid(), totalBp: z.int().min(0).max(BASIS_POINTS_WHOLE) })

defineEvents('Scorecard', {
  'scorecard.updated': {
    schema: z.object({ rfxEventId: z.uuid(), criteria: z.array(z.object({ code: z.string(), weightBp: z.int().min(0).max(BASIS_POINTS_WHOLE), kind: z.enum(['PRICE', 'QUALITY']) })).min(1), evaluatorMemberIds: z.array(z.uuid()) }),
  },
  'scorecard.locked': { schema: z.object({ rfxEventId: z.uuid() }) },
  // S10-04 reveals an RFQ priced only at its close; S10-08 adds the ranking of the evaluators' scores
  // S10-08: the ranking as revealed, best first (bid and total in basis points), so it stays readable after a recompute
  'scorecard.revealed': { schema: z.object({ rfxEventId: z.uuid(), priceOnly: z.boolean(), ranking: z.array(RankingRow).optional() }) },
  // S10-06 (BR-RFX-10): a bid disqualified after the reveal
  'scorecard.recomputed': { schema: z.object({ rfxEventId: z.uuid(), bidId: z.uuid(), reason: z.enum(['DISQUALIFIED']), ranking: z.array(RankingRow).optional() }) },
  // S10-08 (BR-RFX-09 · BR-SOD-14): evaluators added (after the close with a reason the award's facts show), one who
  // stepped aside, and the scores saved and sent — never a score in the data before the reveal
  'scorecard.evaluator_added': { schema: z.object({ rfxEventId: z.uuid(), memberIds: z.array(z.uuid()).min(1), afterClose: z.boolean(), reasonCommentId: z.uuid().optional() }) },
  'scorecard.evaluator_recused': { schema: z.object({ rfxEventId: z.uuid(), memberId: z.uuid() }) },
  'score.saved': { schema: z.object({ rfxEventId: z.uuid(), entries: z.int().min(0) }) },
  'score.submitted': { schema: z.object({ rfxEventId: z.uuid(), memberId: z.uuid() }) },
})

defineEvents('Bid', {
  'bid.disqualified': { schema: z.object({ rfxEventId: z.uuid(), reasonCommentId: z.uuid() }) },
  // S10-06: amounts only when the RFx is not sealed (BR-RFX-06 · BR-RFX-17)
  'bid.saved': { schema: z.object({ rfxEventId: z.uuid(), lines: z.int().min(0) }) },
  'bid.submitted': {
    schema: z.object({ rfxEventId: z.uuid(), submitCount: z.int().min(1), isPartial: z.boolean(), revisionNoAtSubmit: z.int().min(1), onBehalf: z.boolean(), net: z.string().optional(), vat: z.string().optional(), gross: z.string().optional() }),
  },
  'bid.withdrawn': { schema: z.object({ rfxEventId: z.uuid(), withReason: z.boolean() }) },
  'bid.recorded_on_behalf': { schema: z.object({ rfxEventId: z.uuid(), memberId: z.uuid(), fileId: z.uuid() }) },
  // S10-07 (BR-RFX-07 · BR-PORTAL-07): the supplier's files of its bid; an infected one is taken off by the scan's listener
  'bid.file_attached': { schema: z.object({ rfxEventId: z.uuid(), fileId: z.uuid() }) },
  'bid.file_removed': { schema: z.object({ rfxEventId: z.uuid(), fileId: z.uuid() }) },
  'bid.file_rejected': { schema: z.object({ rfxEventId: z.uuid(), fileId: z.uuid() }) },
})

// S10-10 (BR-RFX-12 BR-RFX-13 · docs/sub-specs/S10.md "event"): an award — its amounts in whole satang (after the close, so
// nothing is sealed), the codes that called for its reason and the ids it touched; never the reason itself (it is on the
// award, and a return or a rejection keeps its reason as a Comment)
const satang = z.string().regex(/^\d+$/)
const reasonCode = z.enum(['NOT_TOP_SCORE', 'SPLIT', 'FOREIGN', 'BID_EXPIRED', 'SUPPLIER_FLAGGED', 'DOCS_INCOMPLETE', 'ABOVE_REQUEST', 'RISK_NOT_CLEARED'])
const awardAmounts = { netSatang: satang, vatSatang: satang, isSplit: z.boolean(), lineCount: z.int().min(1), reasonCodes: z.array(reasonCode) }

defineEvents('AwardDecision', {
  'award.created': { schema: z.object({ rfxEventId: z.uuid(), ...awardAmounts }) },
  'award.updated': { schema: z.object({ rfxEventId: z.uuid(), fields: fields.min(1), ...awardAmounts }) },
  'award.submitted': {
    schema: z.object({
      rfxEventId: z.uuid(),
      number: z.string().min(1),
      routeId: z.uuid(),
      resubmitted: z.boolean(),
      ...awardAmounts,
      requestingDepartmentId: z.uuid(),
      sourceDepartmentIds: z.array(z.uuid()),
      poStatus: z.enum(['NOT_APPLICABLE', 'PENDING_PRICE']),
    }),
  },
  // onBehalfOf: the approver; the events the approval writes for the submitter (S10-11's POs) carry the submitter as actor
  'award.approved': {
    schema: z.object({ rfxEventId: z.uuid(), number: z.string(), onBehalfOf: z.uuid().nullable(), purchaseOrderIds: z.array(z.uuid()), priceAgreementIds: z.array(z.uuid()), preferredSupplierIds: z.array(z.uuid()) }),
  },
  'award.returned': { schema: z.object({ rfxEventId: z.uuid(), number: z.string(), reasonCommentId: z.uuid().nullable() }) },
  'award.rejected': { schema: z.object({ rfxEventId: z.uuid(), number: z.string(), reasonCommentId: z.uuid().nullable() }) },
  'award.cancelled': { schema: z.object({ rfxEventId: z.uuid(), from: z.enum(['DRAFT', 'RETURNED', 'PENDING_APPROVAL']), reasonCommentId: z.uuid() }) },
})
