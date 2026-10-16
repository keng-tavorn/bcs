import type { Messages, NestedKeyOf } from 'next-intl'

// Which messages each part of the app hands to its client components (§9.4, §14.4). Server components read the whole
// catalogue on the server; a client component reads its words from the nearest NextIntlClientProvider, and what that
// provider holds is written into the HTML of every page load as inline page data (the RSC payload) — the whole
// catalogue is some 90 KB gzip. So the root layout and every part of the app pass only what their client components
// read, each in a provider that replaces the one above it (src/app/_lib/client-messages.tsx):
//  - root (src/app/layout.tsx): the error boundary (src/app/error.tsx). src/app/global-error.tsx reads its own file and
//    src/app/not-found.tsx renders on the server;
//  - auth and platform ((auth)/layout.tsx, (platform)/layout.tsx): their forms and buttons;
//  - the LIFF app (§9.4: a LIFF page's first JavaScript, its inline page data included, is at most 200 KB gzip): the
//    gate in src/app/liff/layout.tsx, and every part's own words with the gate's again in the layout of that part
//    (src/app/liff/<part>/layout.tsx), so a page never carries the words of another part. A nested provider replaces
//    the one above it, but both are written into the page: the words a page repeats cost next to nothing in gzip, the
//    words of another part would cost all their bytes. A part whose pages show anyone but a member the gate and nothing
//    else (LiffPartScope) passes its words to a member only (src/app/liff/_lib/part-messages.tsx): opened from LINE
//    without a session, the page is the gate's, and its words come with the page's content once the gate has signed in.
//    The messages of a big namespace that LIFF components read by name are named one by one
//    ('adminDoa.detail.boundaryConfirm', each(…)): a component that reads a key built at run time, or hands its
//    translator on, needs the whole namespace. A part a LIFF page loads on demand may bring its own words: it is drawn
//    inside a client provider that holds the page's messages and namespaces it imports from messages/src
//    (src/ui/liff/requests/step-words.tsx, steps 2 and 3 of the request form), so they are in its chunk, not the HTML;
//  - the workspace ((workspace)/layout.tsx) passes the whole catalogue: its pages have no such budget.
// tests/unit/client-messages.test.ts follows the imports of every page and layout to its client components and fails
// when one reads a namespace or a message its provider does not pass: the page would show the key instead of the words.

/** A namespace ('liff.gate') or one message ('adminDoa.detail.boundaryConfirm') of the catalogue */
export type MessagePath = NestedKeyOf<Messages>

/** Every LIFF page that has no session shows the gate (src/ui/liff/liff-gate.tsx), which signs in with LINE */
const LIFF_GATE = ['liff.gate'] as const satisfies readonly MessagePath[]

/**
 * Messages of one namespace named one by one: those a LIFF component reads by name in a namespace whose other messages
 * are the workspace's or the server's. The type checks that every one exists.
 */
const each = <const N extends string, const K extends string>(namespace: N, keys: readonly K[]): Array<`${N}.${K}`> => keys.map((key) => `${namespace}.${key}` as const)

export const CLIENT_MESSAGES = {
  root: ['app.error'],
  auth: ['actionLink', 'auth'],
  // The shared workspace shell's sidebar and trail read 'ui'; its door's dialog the catalogue's words (never drawn for
  // the BCS team, who has no door, but the shell imports it)
  platform: ['auth.security', 'platform.modules', 'platform.ai', 'platform.tenant.sandbox', 'ui', 'request.newDialog', 'request.catalog'],
  /** /liff, /liff/help, /liff/tasks and /liff/track: the gate only */
  liff: [...LIFF_GATE],
  /**
   * /liff/link: the link flow, the e-mail sign-in of an account that is not linked, the LINE user of LIFF_MOCK. Of the
   * web sign-in's words, those the LIFF sign-in reads by name — its fields' own checks included, said on the field as on
   * the web (an empty field, an address that is not an e-mail); the session-ended notice of /login stays on the web
   */
  liffLink: [
    ...LIFF_GATE,
    'liff.link',
    'liff.mock',
    'auth.lock',
    ...each('auth.login', ['email', 'emailInvalid', 'emailRequired', 'failed', 'forgot', 'invalid', 'password', 'passwordRequired', 'serverFailed', 'submit', 'submitting']),
    'auth.twoFactor',
  ],
  /**
   * /liff/tasks/[id]: the decision of a request, PO or variance task, and of a DOA version (its boundary tick). The bars
   * read a few refusals by name (the server words the others: src/app/liff/tasks/[id]/actions.ts) and the policy decision
   * a few of the policy words: the rest of tasks.errors and tasks.policy is the workspace's, some 2.7 KB gzip of a task
   * page's first load
   */
  liffTask: [
    ...LIFF_GATE,
    'tasks.decide',
    ...each('tasks.errors', ['BOUNDARY_NOT_CONFIRMED', 'BOUNDARY_TABLE_CHANGED', 'CONFIRM', 'PIN', 'QUESTION', 'REASON']),
    ...each('tasks.policy', ['approve', 'approved', 'boundaryConfirm', 'boundaryLink', 'boundaryTitle', 'confirm', 'pin', 'reason', 'reject', 'rejectHint', 'rejectTitle', 'rejected', 'stepUpHint', 'title']),
    'liffTasks.decide',
    'requestView.files',
    ...each('adminDoa.detail', ['boundaryConfirm', 'boundaryConfirmLink', 'boundaryConfirmTitle']),
  ],
  /** /liff/requests/new: the catalogue of request types (its search and its list; the drafts' words are the web's) */
  liffCatalog: [...LIFF_GATE, ...each('request.catalog', ['all', 'clear', 'found', 'noDescription', 'noMatch', 'noTypes', 'search', 'searchHint', 'start', 'typesHeading', 'whenToUse'])],
  /**
   * /liff/requests/new/[type] and /liff/requests/[id]/edit: the request form's shell and its first step — with what
   * closed the request to the form, said above it and in the bar (liffRequests.form.closedBy, submit.blockedClosedBy).
   * Steps 2 and 3, the confirmation once sent and why a save was refused are loaded on demand with their words — the rest
   * of requestForm, the file words and liffRequests (src/ui/liff/requests/step-words.tsx): some 5 KB gzip less in the
   * form's HTML
   */
  liffRequestForm: [
    ...LIFF_GATE,
    ...each('liffRequests.form', ['back', 'barLabel', 'closedBy', 'savedAt', 'stepLoading']),
    'requestForm.details',
    'requestForm.fields',
    'requestForm.steps',
    ...each('requestForm.budget', [
      'baht',
      'choose',
      'chooseMissing',
      'costCenter',
      'costCenterValue',
      'dash',
      'department',
      'line',
      'lineHint',
      'loading',
      'noLines',
      'notUsableShort',
      'option',
      'optionGranted',
      'remaining',
      'unknown',
    ]),
    ...each('requestForm.save', ['conflict', 'dirty', 'error', 'idleNew', 'idleSaved', 'openRequest', 'reload', 'saveNow', 'saving']),
    ...each('requestForm.submit', ['blockedBudget', 'blockedClosed', 'blockedClosedBy', 'blockedProblems', 'blockedSave', 'resubmit', 'send', 'sending', 'toProcurement']),
    ...each('requestForm.page', ['returned', 'returnedReason']),
    'requestForm.errors.FORM_FIELD',
  ],
  /** /liff/requests/[id]: the requester's bar (answer, send again, cancel) and the files */
  liffRequest: [...LIFF_GATE, 'requestView.actions', 'requestView.errors', 'requestView.files', 'liffRequests.view'],
  /** /liff/delegation */
  liffDelegation: [...LIFF_GATE, 'delegation', 'liffDelegation'],
  /** /liff/gr/[poId]: receiving with the camera */
  liffReceiving: [...LIFF_GATE, 'liffReceiving', 'receiving.approver', 'receiving.errors', 'receiving.form', 'receiving.history', 'receiving.status.po', 'files'],
} as const satisfies Record<string, readonly MessagePath[]>

export type ClientMessagesScope = keyof typeof CLIENT_MESSAGES

/**
 * The parts of the LIFF app whose pages show their own client components to a member only, and to anyone else the gate
 * and nothing of the part (src/app/liff/_lib/session.ts): their layouts pass these words to a member only
 * (src/app/liff/_lib/part-messages.tsx). Not /liff/link, whose page links an account that has no session yet.
 */
export type LiffPartScope = Extract<ClientMessagesScope, 'liffTask' | 'liffCatalog' | 'liffRequestForm' | 'liffRequest' | 'liffDelegation' | 'liffReceiving'>

/** What a LIFF part passes to anyone but a member: the gate's words, which every part's scope holds too */
export const LIFF_GATE_SCOPE = 'liff' satisfies ClientMessagesScope

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }
type Tree = { [key: string]: unknown }

function valueAt(tree: unknown, keys: readonly string[]): unknown {
  let value = tree
  for (const key of keys) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined
    value = (value as Tree)[key]
  }
  return value
}

/**
 * The part of a catalogue that the paths name, in the catalogue's shape; a path that names nothing is left out. The
 * catalogue is not changed: what is picked whole is shared with it, and only the objects above it are new.
 */
export function pickMessages<T extends object>(messages: T, paths: readonly string[]): DeepPartial<T> {
  const picked: Tree = {}
  const taken: string[] = []
  // A namespace before the messages in it: a message whose namespace is picked whole is there already
  for (const path of [...paths].sort((a, b) => a.split('.').length - b.split('.').length)) {
    if (taken.some((t) => path === t || path.startsWith(`${t}.`))) continue
    const keys = path.split('.')
    const value = valueAt(messages, keys)
    if (value === undefined) continue
    let into = picked
    for (const key of keys.slice(0, -1)) {
      // Objects above a picked value are always this function's own (a value picked whole is never entered)
      into = (into[key] ??= {}) as Tree
    }
    into[keys.at(-1)!] = value
    taken.push(path)
  }
  return picked as DeepPartial<T>
}
