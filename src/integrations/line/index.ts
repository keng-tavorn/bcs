import { getEnv } from '@/lib/env'
import { createLineClient, type LineClient } from './client'

// The LINE Messaging API (BR-LINE-09) for the server: getLineClient().channel(accessToken) gives the API of one
// organization's channel (the token comes decrypted from LineChannelConfig, src/server/services/line-channel). Tests
// swap the client with setLineClient, as setEmailProvider does for e-mail: usually a client pointed at the fake LINE
// server (scripts/lib/fake-line.ts, tests/support/fake-line.ts).

export * from './client'
export * from './errors'
export * from './formats'
export * from './limits'
export * from './signature'
export type * from './types'

let client: LineClient | null = null

export function getLineClient(): LineClient {
  if (client) return client
  const env = getEnv()
  client = createLineClient({ apiBaseUrl: env.LINE_API_BASE_URL, dataApiBaseUrl: env.LINE_DATA_API_BASE_URL })
  return client
}

/** Tests replace the client (e.g. one pointed at the fake LINE server); null restores the one from the environment. */
export function setLineClient(next: LineClient | null): void {
  client = next
}
