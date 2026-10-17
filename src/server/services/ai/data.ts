import { redactForAi } from '@/core/ai-checks'

// What a member or a document wrote, as the model may read it (BR-AI-18): the text Brief, Insight and Intake put
// together goes through the redactor — account numbers and the 13-digit id of a natural person become [ปิดบัง] — and the
// triple quote that fences the requester's words is broken up, so the words cannot close the fence and pass for
// instructions. The stored copy (AgentAction.inputText) is redacted when it is written (actions.ts).

export function asData(written: string): string {
  return redactForAi(written).replaceAll('"""', '" " "')
}

/** Every value of a key → value table given to the model, as asData */
export function asDataValues(values: Readonly<Record<string, string | number | boolean>>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, asData(String(v))]))
}
