'use client'

// The browser's side of BCS passkeys (S17-15, BR-AUTH-09, BR-AUTH-10, ADR-166): the options the server made
// (@simplewebauthn/server's JSON) turned into what navigator.credentials wants, and the authenticator's answer turned
// back into JSON for the server to check. Nothing is decided here — the server checks the origin, the challenge, the
// signature and the user verification. In the BCS Go app the WebView answers with the phone's fingerprint, face or
// screen lock (androidx.webkit, Digital Asset Links); a browser without WebAuthn offers the PIN only.

type Json = Record<string, unknown>

function fromBase64url(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

function toBase64url(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The browser can make and use passkeys (WebAuthn); false on the server and in browsers without it */
export function passkeySupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function' && typeof navigator.credentials?.get === 'function'
}

const credentialList = (list: unknown) =>
  Array.isArray(list) ? list.map((c: Json) => ({ ...c, type: 'public-key' as const, id: fromBase64url(String(c.id)) }) as PublicKeyCredentialDescriptor) : undefined

/** What happened when the device was asked: the answer as JSON, the person closed it, or the device could not */
export type PasskeyAnswer = { readonly ok: true; readonly response: Json } | { readonly ok: false; readonly reason: 'CANCELLED' | 'UNSUPPORTED' | 'FAILED' }

const refused = (error: unknown): PasskeyAnswer => ({ ok: false, reason: error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError') ? 'CANCELLED' : 'FAILED' })

/** A step-up: navigator.credentials.get with the server's options (PublicKeyCredentialRequestOptionsJSON) */
export async function answerChallenge(options: Json): Promise<PasskeyAnswer> {
  if (!passkeySupported()) return { ok: false, reason: 'UNSUPPORTED' }
  try {
    const credential = (await navigator.credentials.get({
      publicKey: {
        ...(options as unknown as PublicKeyCredentialRequestOptions),
        challenge: fromBase64url(String(options.challenge)),
        ...(credentialList(options.allowCredentials) ? { allowCredentials: credentialList(options.allowCredentials)! } : {}),
      },
    })) as PublicKeyCredential | null
    if (!credential) return { ok: false, reason: 'CANCELLED' }
    const r = credential.response as AuthenticatorAssertionResponse
    return {
      ok: true,
      response: {
        id: credential.id,
        rawId: toBase64url(credential.rawId),
        type: 'public-key',
        response: {
          clientDataJSON: toBase64url(r.clientDataJSON),
          authenticatorData: toBase64url(r.authenticatorData),
          signature: toBase64url(r.signature),
          userHandle: r.userHandle ? toBase64url(r.userHandle) : null,
        },
        clientExtensionResults: credential.getClientExtensionResults(),
        ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
      },
    }
  } catch (error) {
    return refused(error)
  }
}

/** A new passkey: navigator.credentials.create with the server's options (PublicKeyCredentialCreationOptionsJSON) */
export async function makePasskey(options: Json): Promise<PasskeyAnswer> {
  if (!passkeySupported()) return { ok: false, reason: 'UNSUPPORTED' }
  const user = options.user as Json
  try {
    const credential = (await navigator.credentials.create({
      publicKey: {
        ...(options as unknown as PublicKeyCredentialCreationOptions),
        challenge: fromBase64url(String(options.challenge)),
        user: { ...(user as unknown as PublicKeyCredentialUserEntity), id: fromBase64url(String(user.id)) },
        ...(credentialList(options.excludeCredentials) ? { excludeCredentials: credentialList(options.excludeCredentials)! } : {}),
      },
    })) as PublicKeyCredential | null
    if (!credential) return { ok: false, reason: 'CANCELLED' }
    const r = credential.response as AuthenticatorAttestationResponse
    return {
      ok: true,
      response: {
        id: credential.id,
        rawId: toBase64url(credential.rawId),
        type: 'public-key',
        response: { clientDataJSON: toBase64url(r.clientDataJSON), attestationObject: toBase64url(r.attestationObject), transports: typeof r.getTransports === 'function' ? r.getTransports() : [] },
        clientExtensionResults: credential.getClientExtensionResults(),
        ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
      },
    }
  } catch (error) {
    return refused(error)
  }
}
