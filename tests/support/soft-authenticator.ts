import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers'

// A WebAuthn authenticator in software for the integration tests of S17-15 (BR-AUTH-09, BR-AUTH-10): an ES256 key
// (P-256) made with node:crypto, the authenticator data and the "none" attestation as the WebAuthn specification lays
// them out, and assertions signed over authenticatorData ‖ sha256(clientDataJSON). Each flag and part can be changed so
// a test can make exactly the response it means to refuse: no user verification, another origin or RP ID, a counter
// that went back, a signature that does not match. The browser's own virtual authenticator is used by the e2e tests.

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_AT = 0x40

const b64url = (bytes: Uint8Array) => isoBase64URL.fromBuffer(new Uint8Array(bytes))
const sha256 = (data: Uint8Array | string) => new Uint8Array(createHash('sha256').update(data).digest())

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n)
  return out
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export interface SoftAuthenticator {
  readonly credentialId: string
  /** Signs with this counter next (WebAuthn's signCount); 0 behaves like a passkey synced between devices */
  counter: number
  readonly key: KeyObject
  readonly publicKeyCose: Uint8Array
}

export function softAuthenticator(counter = 0): SoftAuthenticator {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const cose = new Map<number, number | Uint8Array>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, isoBase64URL.toBuffer(jwk.x)],
    [-3, isoBase64URL.toBuffer(jwk.y)],
  ])
  return { credentialId: b64url(new Uint8Array(randomBytes(16))), counter, key: privateKey, publicKeyCose: isoCBOR.encode(cose) }
}

export interface CeremonyOptions {
  readonly challenge: string
  readonly origin: string
  readonly rpID: string
  /** The user-verified flag; true unless a test removes it */
  readonly uv?: boolean
}

/** What navigator.credentials.create answers for this authenticator (RegistrationResponseJSON, attestation "none") */
export function registrationResponse(auth: SoftAuthenticator, o: CeremonyOptions) {
  const credentialId = isoBase64URL.toBuffer(auth.credentialId)
  const flags = FLAG_UP | FLAG_AT | (o.uv === false ? 0 : FLAG_UV)
  const idLength = new Uint8Array([credentialId.length >> 8, credentialId.length & 0xff])
  const authData = concat(sha256(o.rpID), new Uint8Array([flags]), u32(auth.counter), new Uint8Array(16), idLength, credentialId, auth.publicKeyCose)
  const attestationObject = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]) as never)
  const clientDataJSON = b64url(new TextEncoder().encode(JSON.stringify({ type: 'webauthn.create', challenge: o.challenge, origin: o.origin, crossOrigin: false })))
  return {
    id: auth.credentialId,
    rawId: auth.credentialId,
    type: 'public-key' as const,
    response: { clientDataJSON, attestationObject: b64url(attestationObject), transports: ['internal'] },
    clientExtensionResults: {},
    authenticatorAttachment: 'platform',
  }
}

/** What navigator.credentials.get answers (AuthenticationResponseJSON); `tamper` breaks the signature */
export function assertionResponse(auth: SoftAuthenticator, o: CeremonyOptions & { readonly tamper?: boolean }) {
  const flags = FLAG_UP | (o.uv === false ? 0 : FLAG_UV)
  const authData = concat(sha256(o.rpID), new Uint8Array([flags]), u32(auth.counter))
  const clientData = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: o.challenge, origin: o.origin, crossOrigin: false }))
  const signature = new Uint8Array(sign('sha256', concat(authData, sha256(clientData)), auth.key))
  if (o.tamper) signature[signature.length - 1] = signature[signature.length - 1]! ^ 0xff
  return {
    id: auth.credentialId,
    rawId: auth.credentialId,
    type: 'public-key' as const,
    response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(signature), userHandle: null },
    clientExtensionResults: {},
    authenticatorAttachment: 'platform',
  }
}
