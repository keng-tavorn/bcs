import { getEnv } from '@/lib/env'

// The invoice inbox adapter (ADR-123, BR-AP-02, FR-AP-101 AC2): what arrived at an organization's inbox address, read
// from where the mail lands. Two modes: `mailpit` reads the REST API of the local Mailpit (development, tests and the
// demo; the API is filtered by the organization's address, so lanes and tests with their own address never see each
// other's mail) and `disabled` (staging and production until OQ-124 picks the provider with ADR-031). Only the header
// fields BCS keeps and the attachments are read; the body never leaves the provider.

export interface InboundAttachment {
  readonly partId: string
  readonly fileName: string
  readonly size: number
}

export interface InboundMessage {
  /** The provider's id of the message, to fetch its attachments */
  readonly providerId: string
  /** The Message-ID header: the same mail sent again is the same message (BR-AP-02) */
  readonly messageId: string
  readonly from: string
  readonly to: string
  readonly subject: string
  readonly receivedAt: Date
  readonly attachments: readonly InboundAttachment[]
}

export interface EmailInbox {
  readonly name: 'mailpit' | 'disabled'
  /** Messages to the address, oldest first */
  list(address: string): Promise<InboundMessage[]>
  attachment(message: InboundMessage, partId: string): Promise<Uint8Array>
}

export class InboxReadError extends Error {
  /** A short code for the record, never the provider's text */
  readonly code: string
  constructor(code: string) {
    super(`the inbox could not be read (${code})`)
    this.name = 'InboxReadError'
    this.code = code
  }
}

const disabled: EmailInbox = {
  name: 'disabled',
  list: async () => [],
  attachment: async () => {
    throw new InboxReadError('DISABLED')
  },
}

const MAILPIT_PAGE = 200

interface MailpitSummary {
  readonly ID: string
}
interface MailpitMessage {
  readonly ID: string
  readonly MessageID: string
  readonly From: { readonly Address: string } | null
  readonly To: ReadonlyArray<{ readonly Address: string }>
  readonly Subject: string
  readonly Date: string
  readonly Attachments: ReadonlyArray<{ readonly PartID: string; readonly FileName: string; readonly Size: number }>
}

/** The Message-ID header without its angle brackets, as providers differ in keeping them */
export const messageIdOf = (header: string): string => header.trim().replace(/^<(.*)>$/, '$1')

function mailpit(base: string): EmailInbox {
  const api = `${base.replace(/\/+$/, '')}/api/v1`
  const get = async (path: string): Promise<Response> => {
    let response: Response
    try {
      response = await fetch(`${api}${path}`)
    } catch {
      throw new InboxReadError('UNREACHABLE')
    }
    if (!response.ok) throw new InboxReadError(`HTTP_${response.status}`)
    return response
  }
  return {
    name: 'mailpit',
    async list(address) {
      const found = (await (await get(`/search?query=${encodeURIComponent(`to:"${address}"`)}&limit=${MAILPIT_PAGE}`)).json()) as { messages: MailpitSummary[] }
      const messages = await Promise.all(found.messages.map(async (m) => (await (await get(`/message/${m.ID}`)).json()) as MailpitMessage))
      return messages
        .map((m) => ({
          providerId: m.ID,
          messageId: messageIdOf(m.MessageID) || m.ID,
          from: m.From?.Address ?? '',
          to: m.To.map((t) => t.Address).find((a) => a.toLowerCase() === address.toLowerCase()) ?? address,
          subject: m.Subject,
          receivedAt: new Date(m.Date),
          attachments: m.Attachments.map((a) => ({ partId: a.PartID, fileName: a.FileName, size: a.Size })),
        }))
        .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
    },
    async attachment(message, partId) {
      return new Uint8Array(await (await get(`/message/${message.providerId}/part/${encodeURIComponent(partId)}`)).arrayBuffer())
    },
  }
}

/** The inbox of this deployment: INVOICE_INBOX_PROVIDER, or Mailpit on a local machine and nothing elsewhere */
export function getEmailInbox(): EmailInbox {
  const env = getEnv()
  const mode = env.INVOICE_INBOX_PROVIDER ?? (env.APP_ENV === 'local' ? 'mailpit' : 'disabled')
  return mode === 'mailpit' ? mailpit(env.MAILPIT_API_URL) : disabled
}
