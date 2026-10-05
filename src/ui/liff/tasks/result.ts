// What a decision, or a question to the requester, sent from the LIFF decision page answers its form (FR-LINE-003,
// FR-DOA-004 AC1, FR-AUTH-005 AC2). The server action turns the service's refusal into the member's words there and
// then (the words of the web decision page, tasks.errors, in the member's language, with the name, the time and the
// tries left filled in), so the phone's script carries no message catalogue and no date code: the form only places the
// words — at the PIN field, at the boundary table's tick, or by the button — and reloads a task that closed meanwhile.
// Never the error's developer message, a PIN or a token.

export type LiffTaskResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      /**
       * Where the page says it: pin — at the PIN field (not six digits, or wrong with the tries left); tick — at the tick
       * of the boundary table (FR-DOA-009 AC3); closed — the task was decided, moved or closed meanwhile, by whom and
       * when (FR-DOA-004 AC2): the page shows it as it is now; form — by the form's button (a lock with its time, no
       * PIN yet, separation of duties, …)
       */
      readonly at: 'pin' | 'tick' | 'closed' | 'form'
      /** What happened and what to do */
      readonly text: string
      /** The member has no PIN yet: the form shows where to set one (FR-AUTH-005 AC1) */
      readonly pinNotSet?: true
      /** The boundary table ticked is no longer the one the version is compared with: the tick is taken back */
      readonly untick?: true
      /** No session any more (it ended or was signed out): nothing was sent on, and the page is opened again */
      readonly signedOut?: true
    }

export type LiffTaskFailure = Extract<LiffTaskResult, { ok: false }>
