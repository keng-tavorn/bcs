import type { StateMachine } from '../state-machines'
import { transition, type TransitionResult } from '../state-machines'
import { MS_PER_MINUTE } from '../money/constants'

// The state machine of AgentAction (docs/sub-specs/S13.md "State machine"). Each command has one target, so the
// outcome of a call is two commands (complete → DRAFT, fail → FAILED) and the outcome of a document command with
// aiAssist is three (apply keeps DRAFT while fields wait, accept or edit when all are confirmed). L0 results stay at
// DRAFT for good. Kept here rather than in core/state-machines so the lanes do not edit the same list (P1-07).

export const AGENT_ACTION_STATES = ['PENDING', 'DRAFT', 'ACCEPTED', 'EDITED', 'REJECTED', 'FAILED', 'EXPIRED'] as const
export type AgentActionState = (typeof AGENT_ACTION_STATES)[number]
export const AGENT_ACTION_COMMANDS = [
  'agent_action.complete',
  'agent_action.fail',
  'agent_action.apply',
  'agent_action.accept',
  'agent_action.edit',
  'agent_action.reject',
  'agent_action.expire',
  'agent_action.give_feedback',
] as const
export type AgentActionCommand = (typeof AGENT_ACTION_COMMANDS)[number]

export const AGENT_ACTION_MACHINE: StateMachine<AgentActionState, AgentActionCommand> = {
  name: 'AgentAction',
  states: AGENT_ACTION_STATES,
  commands: AGENT_ACTION_COMMANDS,
  transitions: [
    { from: ['PENDING'], command: 'agent_action.complete', to: 'DRAFT' },
    // An error, a refusal, a bad shape, another model, or PENDING past its time (BR-AI-11 BR-AI-13)
    { from: ['PENDING'], command: 'agent_action.fail', to: 'FAILED' },
    { from: ['DRAFT'], command: 'agent_action.apply', to: 'DRAFT' },
    { from: ['DRAFT'], command: 'agent_action.accept', to: 'ACCEPTED' },
    { from: ['DRAFT'], command: 'agent_action.edit', to: 'EDITED' },
    { from: ['DRAFT'], command: 'agent_action.reject', to: 'REJECTED' },
    { from: ['DRAFT'], command: 'agent_action.expire', to: 'EXPIRED' },
    { from: ['DRAFT'], command: 'agent_action.give_feedback', to: 'DRAFT' },
  ],
}

export const agentActionTransition = (from: AgentActionState, command: AgentActionCommand): TransitionResult<AgentActionState> =>
  transition(AGENT_ACTION_MACHINE, from, command)

const BANGKOK_OFFSET_MS = 7 * 60 * MS_PER_MINUTE

/** The month a call or grant belongs to: the first day of its month in Thai time (UTC+7, no daylight saving), YYYY-MM-01 */
export function creditPeriodMonth(at: Date): string {
  return `${new Date(at.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 7)}-01`
}
