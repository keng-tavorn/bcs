import nodemailer from 'nodemailer'
import { getEnv } from '@/lib/env'

// EmailProvider adapter (spec §5.1). Local development sends to Mailpit over SMTP; the staging/production
// provider is chosen in ADR-031 (still open) and plugs in behind the same interface.

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

export function createSmtpProvider(url: string, defaultFrom: string): EmailProvider {
  const transport = nodemailer.createTransport(url)
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
