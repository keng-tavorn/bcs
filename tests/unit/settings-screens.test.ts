import { describe, expect, it } from 'vitest'
import { encode } from 'uqr'
import { MS_PER_MINUTE, MS_PER_SECOND } from '@/lib/constants'
import { draftOf, isDirty, saveInputOf } from '@/ui/admin-line/draft'
import { richMenuErrorKey, type LineChannelView } from '@/ui/admin-line/types'
import { newPinDigits } from '@/ui/settings-pin/new-pin-field'
import { qrDrawing } from '@/ui/settings-line/qr'
import { countdownText, lineLinkErrorKey } from '@/ui/settings-line/types'
import { proveError, setPinError } from '@/ui/settings-pin/types'
import { digestErrorKey } from '@/ui/settings-notifications/types'

// The pure parts of the wave-4 settings screens: the QR of a link code drawn on the server and its countdown
// (/settings/line, FR-LINE-001 AC1), how each refusal becomes the page's own words on /settings/line (AC3),
// /settings/pin (FR-AUTH-005 AC1), /settings/notifications (FR-LINE-006 AC3) and the rich-menu button of /admin/line
// (FR-LINE-004), and what the form of /admin/line sends and counts as a change (FR-ADM-006 AC2).

const LINK = `https://liff.line.me/2000000002-e2eLiffApp/link?code=${encodeURIComponent(`l1.${'A'.repeat(22)}.${'B'.repeat(22)}.1790000000000.${'C'.repeat(22)}.${'D'.repeat(43)}`)}`

describe('[FR-LINE-001/AC1] the QR of a link code is one SVG path drawn on the server', () => {
  it('draws every dark module of the QR as a unit square inside a quiet zone of 4 modules', () => {
    const { data } = encode(LINK, { border: 0 })
    const drawing = qrDrawing(LINK)
    expect(drawing.size).toBe(data.length + 8)
    const squares = drawing.path.match(/M\d+ \d+h1v1h-1z/g) ?? []
    // Nothing but squares: safe to put into <path d> as it is
    expect(squares.join('')).toBe(drawing.path)
    expect(squares).toHaveLength(data.flat().filter(Boolean).length)
    for (const square of squares) {
      const [x, y] = square.slice(1, square.indexOf('h')).split(' ').map(Number)
      expect(x!).toBeGreaterThanOrEqual(4)
      expect(y!).toBeGreaterThanOrEqual(4)
      expect(x!).toBeLessThan(drawing.size - 4)
      expect(y!).toBeLessThan(drawing.size - 4)
    }
    // The same link draws the same QR
    expect(qrDrawing(LINK)).toEqual(drawing)
  })

  it('counts the time left down in minutes and seconds, never showing 0:00 while the code still works', () => {
    expect(countdownText(10 * MS_PER_MINUTE)).toBe('10:00')
    expect(countdownText(10 * MS_PER_MINUTE - MS_PER_SECOND)).toBe('9:59')
    expect(countdownText(9 * MS_PER_MINUTE + 5 * MS_PER_SECOND + 1)).toBe('9:06')
    expect(countdownText(1)).toBe('0:01')
    expect(countdownText(0)).toBe('0:00')
    expect(countdownText(-5 * MS_PER_SECOND)).toBe('0:00')
  })
})

describe('[FR-LINE-001/AC3] the LINE account page says why a code or an unlink was refused', () => {
  it('uses the reason of the link service, and the common words otherwise', () => {
    expect(lineLinkErrorKey({ ok: false, code: 'INVALID_STATE_TRANSITION', reason: 'LINE_NOT_ENABLED' })).toBe('LINE_NOT_ENABLED')
    expect(lineLinkErrorKey({ ok: false, code: 'INVALID_STATE_TRANSITION', reason: 'ALREADY_LINKED' })).toBe('ALREADY_LINKED')
    expect(lineLinkErrorKey({ ok: false, code: 'INVALID_STATE_TRANSITION', reason: 'NOT_LINKED' })).toBe('NOT_LINKED')
    expect(lineLinkErrorKey({ ok: false, code: 'INVALID_STATE_TRANSITION', reason: 'SOMETHING_ELSE' })).toBe('FAILED')
    expect(lineLinkErrorKey({ ok: false, code: 'FORBIDDEN' })).toBe('FORBIDDEN')
    expect(lineLinkErrorKey({ ok: false, code: 'UNAUTHENTICATED' })).toBe('UNAUTHENTICATED')
    expect(lineLinkErrorKey({ ok: false, code: 'RATE_LIMITED' })).toBe('BUSY')
    expect(lineLinkErrorKey({ ok: false, code: 'INTERNAL', requestId: 'r' })).toBe('INTERNAL')
  })
})

describe('[FR-AUTH-005/AC1] the PIN page says what went wrong, under the field it belongs to', () => {
  it('a wrong password or code, a method not set up and a locked account', () => {
    expect(proveError({ ok: false, code: 'VALIDATION_FAILED', field: 'password', reason: 'WRONG' }, 'PASSWORD')).toEqual({ key: 'PASSWORD_WRONG', field: 'password' })
    expect(proveError({ ok: false, code: 'VALIDATION_FAILED', field: 'password' }, 'PASSWORD')).toEqual({ key: 'PASSWORD_REQUIRED', field: 'password' })
    expect(proveError({ ok: false, code: 'VALIDATION_FAILED', field: 'code', reason: 'WRONG' }, 'TOTP')).toEqual({ key: 'CODE_WRONG', field: 'code' })
    expect(proveError({ ok: false, code: 'VALIDATION_FAILED', field: 'code' }, 'TOTP')).toEqual({ key: 'CODE_FORMAT', field: 'code' })
    expect(proveError({ ok: false, code: 'VALIDATION_FAILED', field: 'method', reason: 'NOT_AVAILABLE' }, 'TOTP')).toEqual({ key: 'TOTP_NOT_AVAILABLE', field: null })
    expect(proveError({ ok: false, code: 'VALIDATION_FAILED', field: 'method', reason: 'NOT_AVAILABLE' }, 'PASSWORD')).toEqual({ key: 'NOT_AVAILABLE', field: null })
    expect(proveError({ ok: false, code: 'RATE_LIMITED', reason: 'ACCOUNT_LOCKED', timeText: '4 ต.ค. 2569 14:35 น.' }, 'PASSWORD')).toEqual({ key: 'ACCOUNT_LOCKED', field: null })
    expect(proveError({ ok: false, code: 'FORBIDDEN' }, 'PASSWORD')).toEqual({ key: 'FORBIDDEN', field: null })
  })

  it('a PIN the rules refuse, and a proof that ran out (back to step 1)', () => {
    for (const [reason, key] of [
      ['FORMAT', 'PIN_FORMAT'],
      ['ALL_SAME', 'ALL_SAME'],
      ['SEQUENCE', 'SEQUENCE'],
      ['COMMON', 'COMMON'],
    ] as const) {
      expect(setPinError({ ok: false, code: 'VALIDATION_FAILED', field: 'pin', reason }), reason).toEqual({ key, field: 'pin', proof: false })
    }
    // Longer than the input allows: refused by the schema without a reason
    expect(setPinError({ ok: false, code: 'VALIDATION_FAILED', field: 'pin' })).toEqual({ key: 'PIN_FORMAT', field: 'pin', proof: false })
    expect(setPinError({ ok: false, code: 'STEP_UP_REQUIRED', reason: 'IDENTITY_PROOF' })).toEqual({ key: 'PROOF_EXPIRED', field: null, proof: true })
    expect(setPinError({ ok: false, code: 'VALIDATION_FAILED', field: 'proofToken' })).toEqual({ key: 'PROOF_EXPIRED', field: null, proof: true })
    expect(setPinError({ ok: false, code: 'RATE_LIMITED' })).toEqual({ key: 'BUSY', field: null, proof: false })
  })
})

describe('[FR-LINE-006/AC3] the notification settings page explains a switch that did not save', () => {
  it('maps the codes to its words', () => {
    expect(digestErrorKey({ ok: false, code: 'FORBIDDEN' })).toBe('FORBIDDEN')
    expect(digestErrorKey({ ok: false, code: 'RATE_LIMITED' })).toBe('BUSY')
    expect(digestErrorKey({ ok: false, code: 'VALIDATION_FAILED' })).toBe('FAILED')
  })
})

describe('[FR-LINE-004/AC1] the rich-menu button of /admin/line says why LINE or the settings refused', () => {
  it('names the field to fix, or LINE, or a save in between', () => {
    expect(richMenuErrorKey({ ok: false, code: 'VALIDATION_FAILED', field: 'channel', reason: 'NOT_CONFIGURED' })).toBe('NOT_CONFIGURED')
    expect(richMenuErrorKey({ ok: false, code: 'VALIDATION_FAILED', field: 'liffId', reason: 'REQUIRED' })).toBe('LIFF_REQUIRED')
    expect(richMenuErrorKey({ ok: false, code: 'VALIDATION_FAILED', field: 'channelAccessToken', reason: 'SECRET_UNREADABLE' })).toBe('TOKEN_UNREADABLE')
    expect(richMenuErrorKey({ ok: false, code: 'VALIDATION_FAILED', field: 'images.LINKED', reason: 'SIZE' })).toBe('IMAGES')
    expect(richMenuErrorKey({ ok: false, code: 'VALIDATION_FAILED', field: 'images', reason: 'UNREADABLE' })).toBe('IMAGES')
    expect(richMenuErrorKey({ ok: false, code: 'EXTERNAL_SERVICE_ERROR', status: '500' })).toBe('LINE')
    expect(richMenuErrorKey({ ok: false, code: 'CONFLICT_VERSION' })).toBe('CONFLICT')
    expect(richMenuErrorKey({ ok: false, code: 'FORBIDDEN' })).toBeNull()
  })
})

describe('[FR-ADM-006/AC2] the form of /admin/line sends trimmed values and counts only a real change as one', () => {
  const VIEW: LineChannelView = {
    configured: true,
    webhookUrl: 'https://bcs.example/api/webhooks/line/AbCdEfGhIjKlMnOpQrStUvWx',
    providerId: '1650000021',
    messagingChannelId: '1650000022',
    channelSecret: { set: true, readable: true },
    channelAccessToken: { set: true, readable: true },
    liffId: '1650000023-AbCdEfGh',
    liffChannelId: '1650000023',
    active: true,
    richMenus: true,
    version: 7,
  }
  const SAVED_AS_IS = {
    providerId: '1650000021',
    messagingChannelId: '1650000022',
    channelSecret: '',
    channelAccessToken: '',
    liffId: '1650000023-AbCdEfGh',
    liffChannelId: '1650000023',
    active: true,
    expectedVersion: 7,
  }

  it('starts from what is saved, both secrets empty (write-only), which is no change', () => {
    const draft = draftOf(VIEW)
    expect(draft.channelSecret).toBe('')
    expect(draft.channelAccessToken).toBe('')
    expect(isDirty(draft, VIEW)).toBe(false)
    expect(saveInputOf(draft, VIEW.version)).toEqual(SAVED_AS_IS)
  })

  it('a space typed around a value is no change: the save sends it trimmed, and the test and the menus need no save first', () => {
    const draft = { ...draftOf(VIEW), providerId: ` ${VIEW.providerId} `, liffId: `${VIEW.liffId}\t`, messagingChannelId: `${VIEW.messagingChannelId} `, channelSecret: '   ' }
    expect(isDirty(draft, VIEW)).toBe(false)
    expect(saveInputOf(draft, VIEW.version)).toEqual(SAVED_AS_IS)
  })

  it('a changed or removed value, a typed secret and the switch are changes', () => {
    expect(isDirty({ ...draftOf(VIEW), liffId: '' }, VIEW)).toBe(true)
    expect(isDirty({ ...draftOf(VIEW), messagingChannelId: '1650000099' }, VIEW)).toBe(true)
    expect(isDirty({ ...draftOf(VIEW), channelAccessToken: 'a-new-token' }, VIEW)).toBe(true)
    expect(isDirty({ ...draftOf(VIEW), channelSecret: ' 0123456789abcdef0123456789abcdef ' }, VIEW)).toBe(true)
    expect(isDirty({ ...draftOf(VIEW), active: false }, VIEW)).toBe(true)
    expect(saveInputOf({ ...draftOf(VIEW), channelSecret: ' 0123456789abcdef0123456789abcdef ' }, VIEW.version).channelSecret).toBe('0123456789abcdef0123456789abcdef')
  })
})

describe('[FR-AUTH-005/AC1] a new PIN on /settings/pin keeps the digits only, at most six', () => {
  it('drops anything else typed or pasted', () => {
    expect(newPinDigits('582931')).toBe('582931')
    expect(newPinDigits('58 29-31')).toBe('582931')
    expect(newPinDigits('5829311234')).toBe('582931')
    expect(newPinDigits('PIN: 58a29b31')).toBe('582931')
    expect(newPinDigits('abc')).toBe('')
  })
})
