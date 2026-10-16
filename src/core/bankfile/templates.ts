// Bank file templates are code (ADR-129): one pure builder per template (S9-03). Until a bank's own spec arrives
// (P0-03) every payer account uses the neutral template, which says on every line that it is no bank's format (ADR-130).

/** BR-BANK-05: the demo template; banks will not accept its file */
export const NEUTRAL_TEMPLATE_CODE = 'BCS-NEUTRAL-1'
