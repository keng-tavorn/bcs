// What the app sent to Mailpit, the local SMTP server of docker-compose (spec §5.3), read through its API in tests.

const API = 'http://localhost:8025/api/v1'

export interface MailpitMessage {
  readonly ID: string
  readonly Subject: string
  readonly From: { readonly Address: string }
  readonly To: ReadonlyArray<{ readonly Address: string }>
  readonly ReplyTo: ReadonlyArray<{ readonly Address: string }>
  readonly Text: string
  readonly HTML: string
  readonly Attachments: ReadonlyArray<{ readonly PartID: string; readonly FileName: string; readonly ContentType: string; readonly Size: number }>
}

async function json<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`)
  if (!response.ok) throw new Error(`Mailpit ${path}: ${response.status}`)
  return (await response.json()) as T
}

/** Every message to this address, oldest first */
export async function messagesTo(address: string): Promise<MailpitMessage[]> {
  const found = await json<{ messages: Array<{ ID: string }> }>(`/search?query=${encodeURIComponent(`to:"${address}"`)}`)
  const messages = await Promise.all(found.messages.map((m) => json<MailpitMessage>(`/message/${m.ID}`)))
  return messages.reverse()
}

export async function attachmentOf(message: MailpitMessage, partId: string): Promise<Uint8Array> {
  const response = await fetch(`${API}/message/${message.ID}/part/${partId}`)
  if (!response.ok) throw new Error(`Mailpit attachment: ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}
