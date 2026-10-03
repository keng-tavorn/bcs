// Starts the fake LINE server (scripts/lib/fake-line.ts) for one test file and points the app's LINE client at it
// (setLineClient), as setEmailProvider does for e-mail. Port 0 by default: every file gets a free port of its own.
//   const line = withFakeLine({ accessToken: TOKEN })
//   it('…', () => { line.fake.messages() … })
import { afterAll, beforeAll } from 'vitest'
import { createLineClient, setLineClient, type LineClient } from '@/integrations/line'
import { startFakeLine, type FakeLine, type FakeLineOptions } from '../../scripts/lib/fake-line'

/** A channel secret in LINE's format (32 hexadecimal characters), for tests only */
export const TEST_CHANNEL_SECRET = '0123456789abcdef0123456789abcdef'
/** An access token in LINE's format, for tests only */
export const TEST_ACCESS_TOKEN = 'test-only-channel-access-token-0000000000000000'

export interface FakeLineHandle {
  readonly fake: FakeLine
  /** The client the app uses while this file runs: pointed at the fake */
  readonly client: LineClient
}

export function withFakeLine(options: Partial<FakeLineOptions> = {}): FakeLineHandle {
  let fake: FakeLine | null = null
  let client: LineClient | null = null
  beforeAll(async () => {
    fake = await startFakeLine({ port: 0, channelSecret: TEST_CHANNEL_SECRET, accessToken: TEST_ACCESS_TOKEN, ...options })
    client = createLineClient({ apiBaseUrl: fake.url, dataApiBaseUrl: fake.url })
    setLineClient(client)
  })
  afterAll(async () => {
    setLineClient(null)
    await fake?.close()
  })
  return {
    get fake() {
      if (!fake) throw new Error('the fake LINE server starts in beforeAll')
      return fake
    },
    get client() {
      if (!client) throw new Error('the fake LINE server starts in beforeAll')
      return client
    },
  }
}
