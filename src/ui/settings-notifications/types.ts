// What the server action of /settings/notifications answers the page (FR-LINE-006 AC3): the saved setting, or the
// error code the page explains in its own words (§9.9 rule 7).

export type DigestOutcome = { readonly ok: true; readonly digest: boolean } | { readonly ok: false; readonly code: string; readonly requestId?: string }

export type SetDigestAction = (digest: boolean, idempotencyKey: string) => Promise<DigestOutcome>

export type DigestErrorKey = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'BUSY' | 'INTERNAL' | 'FAILED'

export function digestErrorKey(failure: Extract<DigestOutcome, { ok: false }>): DigestErrorKey {
  switch (failure.code) {
    case 'UNAUTHENTICATED':
    case 'FORBIDDEN':
    case 'INTERNAL':
      return failure.code
    case 'RATE_LIMITED':
      return 'BUSY'
    default:
      return 'FAILED'
  }
}

// ---------- notifications in the BCS Go app (S17-10, FR-PLT-301 AC1 AC2) ----------

type Failure = { readonly ok: false; readonly code: string; readonly requestId?: string }

/** One of the member's devices in use, as the table shows it (dates already in the member's words) */
export interface PushDeviceView {
  readonly id: string
  /** The device's label, or the platform and app version when it has none */
  readonly label: string
  readonly registeredAt: string
  readonly lastSeenAt: string
}

export type AppPushOutcome = { readonly ok: true; readonly appPush: boolean } | Failure
export type RegisterDeviceOutcome = { readonly ok: true; readonly deviceId: string } | Failure
export type RevokeDeviceOutcome = { readonly ok: true } | Failure

export interface AppPushActions {
  readonly save: (appPush: boolean, idempotencyKey: string) => Promise<AppPushOutcome>
  readonly register: (input: { readonly token: string; readonly platform: 'ANDROID' | 'IOS'; readonly appVersion: string }, idempotencyKey: string) => Promise<RegisterDeviceOutcome>
  readonly revoke: (deviceId: string, idempotencyKey: string) => Promise<RevokeDeviceOutcome>
}
