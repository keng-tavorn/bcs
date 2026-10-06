import nodemailer from 'nodemailer'
import { EMAIL_CONNECT_TIMEOUT_MS, EMAIL_SOCKET_TIMEOUT_MS } from '@/lib/constants'
import { getEnv } from '@/lib/env'

// EmailProvider adapter (spec §5.1). Local development sends to Mailpit over SMTP; the staging/production
// provider is chosen in ADR-031 (still open) and plugs in behind the same interface. A send that fails throws
// EmailSendError: `permanent` when the provider refused the message for good (a bounce at sending, FR-P2P-005 AC2),
// otherwise the provider could not be reached and a later try may work. Bounces that arrive after the provider
// accepted a message come through the provider's webhook once ADR-031 is decided.

export interface EmailMessage {
  readonly to: string
  readonly subject: string
  readonly text: string
  readonly html?: string
  readonly replyTo?: string
  readonly from?: string
  readonly headers?: Readonly<Record<string, string>>
  /** Files sent with the message: a PO's PDF (FR-P2P-005), a scheduled report (FR-VIS-002) */
  readonly attachments?: ReadonlyArray<{ readonly filename: string; readonly content: Uint8Array; readonly contentType: string }>
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<{ messageId: string }>
}

export class EmailSendError extends Error {
  /** The provider refused the message (an SMTP 5xx reply): sending it again unchanged will fail again */
  readonly permanent: boolean
  /** A short code for the record, never the provider's text (it can quote the address): "SMTP_550", "ECONNECTION" */
  readonly code: string
  constructor(permanent: boolean, code: string) {
    super(`e-mail not sent (${code})`)
    this.name = 'EmailSendError'
    this.permanent = permanent
    this.code = code
  }
}

const SMTP_PERMANENT_FROM = 500

/** A nodemailer error as EmailSendError: an SMTP reply code decides, a connection problem is never permanent */
function smtpError(error: unknown): EmailSendError {
  const e = (error ?? {}) as { responseCode?: unknown; code?: unknown }
  if (typeof e.responseCode === 'number') return new EmailSendError(e.responseCode >= SMTP_PERMANENT_FROM, `SMTP_${e.responseCode}`)
  return new EmailSendError(false, typeof e.code === 'string' && /^[A-Z_]{2,32}$/.test(e.code) ? e.code : 'UNKNOWN')
}

export function createSmtpProvider(url: string, defaultFrom: string): EmailProvider {
  const parsed = new URL(url)
  const transport = nodemailer.createTransport({
    host: parsed.hostname,
    port: Number(parsed.port) || (parsed.protocol === 'smtps:' ? 465 : 587),
    secure: parsed.protocol === 'smtps:',
    ...(parsed.username ? { auth: { user: decodeURIComponent(parsed.username), pass: decodeURIComponent(parsed.password) } } : {}),
    // Shorter than a command's transaction: a PO is sent inside its command (FR-P2P-005)
    connectionTimeout: EMAIL_CONNECT_TIMEOUT_MS,
    greetingTimeout: EMAIL_CONNECT_TIMEOUT_MS,
    socketTimeout: EMAIL_SOCKET_TIMEOUT_MS,
  })
  return {
    async send(message) {
      const info = await transport.sendMail({
        from: message.from ?? defaultFrom,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(message.headers ? { headers: { ...message.headers } } : {}),
        ...(message.attachments?.length ? { attachments: message.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content), contentType: a.contentType })) } : {}),
      }).catch((error: unknown) => {
        throw smtpError(error)
      })
      return { messageId: info.messageId }
    },
  }
}

let provider: EmailProvider | null = null

export function getEmailProvider(): EmailProvider {
  if (provider) return provider
  const env = getEnv()
  if (env.EMAIL_PROVIDER !== 'smtp' || !env.EMAIL_SMTP_URL) {
    throw new Error(`EMAIL_PROVIDER=${env.EMAIL_PROVIDER} is not implemented yet (ADR-031 undecided)`)
  }
  provider = createSmtpProvider(env.EMAIL_SMTP_URL, env.EMAIL_FROM)
  return provider
}

/** Tests replace the provider (e.g. to simulate a bounce); null restores the default. */
export function setEmailProvider(next: EmailProvider | null): void {
  provider = next
}
