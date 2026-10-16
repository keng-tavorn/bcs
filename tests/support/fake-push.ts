// Points the app's push at the fake FCM of the fake LINE server (scripts/lib/fake-fcm.ts) for one test file, with a
// service account key made for the file (the fake checks the JWT's claims, not its signature):
//   const line = withFakeLine()
//   withFakePush(line)
//   it('…', () => { line.fake.fcm.pushes() … })
import { generateKeyPairSync } from 'node:crypto'
import { afterAll, beforeAll } from 'vitest'
import { createFcmProvider, setPushProvider, type FcmServiceAccount } from '@/integrations/push'
import type { FakeLineHandle } from './fake-line'

export function testServiceAccount(): FcmServiceAccount {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { client_email: 'bcs-test@bcs-test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
}

export function withFakePush(line: FakeLineHandle, projectId = 'bcs-test'): void {
  beforeAll(() => {
    setPushProvider(createFcmProvider({ projectId, serviceAccount: testServiceAccount(), apiBaseUrl: `${line.fake.url}/fcm`, tokenUrl: `${line.fake.url}/fcm/token` }))
  })
  afterAll(() => setPushProvider(undefined))
}

/** A push token in FCM's form, different every call */
export const fakePushToken = (): string => `fcm-${crypto.randomUUID().replace(/-/g, '')}:APA91b${crypto.randomUUID().replace(/-/g, '')}`
