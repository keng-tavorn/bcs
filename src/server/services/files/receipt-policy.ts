import { isAllowed } from '@/server/authz'
import { effectiveSodPolicy } from '@/server/doa/policy'
import { poViewFacts, receiptParticipants, receivingParties } from '@/server/queries/receiving'
import { receivingDecision } from '../receiving/access'
import { registerFileSubjectPolicy } from './policies'

// FR-PLT-004 AC2 for the photos of a goods receipt (FileLink subjectType "GoodsReceipt", BR-GR-05): whoever took part in
// the receipt — the member who received the goods, and the approvers of its variances, for whom a damaged-goods photo is
// the evidence they decide on — whoever may view the PO it belongs to (po.view, §2.4, the same facts as the PO's PDF and
// the receiving page), and whoever holds gr.post for that PO, so the next receiver sees what came before. A receipt that
// does not exist gives no access (BR-AUTH-01).
registerFileSubjectPolicy('GoodsReceipt', async (tx, ctx, principal, grId) => {
  if (principal.kind !== 'member') return false
  const receipt = await receiptParticipants(tx, grId)
  if (!receipt) return false
  if (receipt.memberIds.includes(principal.memberId)) return true
  const facts = await poViewFacts(tx, receipt.poId)
  if (isAllowed(principal, 'po.view', { ownerMemberIds: facts.ownerMemberIds, assigneeMemberIds: facts.assigneeMemberIds })) return true
  const parties = (await receivingParties(tx, [receipt.poId])).get(receipt.poId) ?? { requests: [], approvers: [] }
  return receivingDecision(principal, await effectiveSodPolicy(tx, ctx.now), parties).kind !== 'NONE'
})
