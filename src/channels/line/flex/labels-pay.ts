// The kinds of S9's approval subjects on a LINE card (S9-06, ADR-135): lane 2 lists them here and labels.ts takes them
// in one line. A kind, never a supplier's name or an account (BR-NOTI-01).

export const PAY_SUBJECT_KINDS = {
  PAYMENT_RUN: { th: 'รอบจ่ายเงิน', en: 'Payment run' },
  BANK_ACCOUNT_CHANGE: { th: 'การเปลี่ยนบัญชีธนาคาร', en: 'Bank account change' },
} as const
