// LINE Flex Message builders (spec §4.7 rule 5, §9.3): pure functions from prepared data to LINE message objects. The
// server prepares the data (src/server/line/postback-cards.ts) and sends what these return; their sizes are tested
// against LINE's limits (src/integrations/line/limits.ts) in tests/unit/line-flex.test.ts.

export { approvalCard, approvePostbackData, approvesInChat, type ApprovalCardData } from './approval-card'
export { decisionConfirmationCard, type DecisionConfirmationData } from './confirmation-card'
export { subjectKind } from './labels'
export { postbackRefusalMessage, textNotice, type PostbackRefusal, type TextNoticeData } from './notices'
export { ACTION_LABEL_MAX_LENGTH, CARD_LABEL_MAX_LENGTH, CARD_NAME_MAX_LENGTH, clip, clipLines, NOTICE_BODY_MAX_LENGTH, NOTICE_TITLE_MAX_LENGTH } from './text'
export type { CardLocale, FlexAction, FlexBubble, FlexMessage, OutgoingLineMessage, TextMessage } from './types'
