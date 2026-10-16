import { confirmationLabel, cardLabel, doaReference, subjectKind } from './labels'
import { heading, INK_MUTED, plain, PRIMARY, vertical } from './style'
import { ACTION_LABEL_MAX_LENGTH, CARD_LABEL_MAX_LENGTH, CARD_NAME_MAX_LENGTH, clip, dateTimeOf } from './text'
import type { CardLocale, FlexMessage } from './types'

// The answer to an approval made in the chat (spec §9.3, FR-LINE-002 AC2): "อนุมัติแล้ว" with the document, the DOA
// reference it was approved under ("อนุมัติภายใต้ DOA-DEMO ฉบับ 1 ข้อ PR-02", FR-DOA-005 AC2), the time, and whether the
// document went on to the next approver or every step is done. Pure, like the approval card.

export interface DecisionConfirmationData {
  readonly locale: CardLocale
  readonly subjectType: string
  readonly typeName: string | null
  readonly label: string
  readonly doa: { readonly code: string; readonly versionNo: number; readonly ruleCode: string }
  readonly decidedAt: Date
  /** NEXT_STEP: the route goes on to the next approver · DONE: the route is complete */
  readonly stage: 'NEXT_STEP' | 'DONE'
  /** A reviewer passed it (S6): no approval, so the card says passed */
  readonly review?: boolean
  readonly detailsUrl: string
}

export function decisionConfirmationCard(data: DecisionConfirmationData): FlexMessage {
  const t = data.locale
  const documentLabel = clip(data.label, CARD_LABEL_MAX_LENGTH)
  const kind = clip(data.typeName ?? subjectKind(data.subjectType, t), CARD_NAME_MAX_LENGTH)
  return {
    type: 'flex',
    altText: `${confirmationLabel(data.review ? 'reviewHeader' : 'header', t)}: ${kind} ${documentLabel}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      body: vertical(
        [
          heading(confirmationLabel(data.review ? 'reviewHeader' : 'header', t), PRIMARY),
          plain(`${kind} ${documentLabel}`),
          plain(`${confirmationLabel(data.review ? 'reviewUnder' : 'under', t)} ${doaReference(data.doa, t)}`),
          plain(`${confirmationLabel('at', t)} ${dateTimeOf(data.decidedAt, t)}`, INK_MUTED),
          plain(confirmationLabel(data.review ? 'reviewNext' : data.stage === 'DONE' ? 'done' : 'nextStep', t), INK_MUTED),
        ],
        { spacing: 'md', paddingAll: '16px' },
      ),
      footer: vertical(
        [{ type: 'button', style: 'link', height: 'md', color: PRIMARY, action: { type: 'uri', label: clip(cardLabel('details', t), ACTION_LABEL_MAX_LENGTH), uri: data.detailsUrl } }],
        { paddingAll: '8px' },
      ),
    },
  }
}
