// pnpm line:fake — the fake LINE server on this machine (scripts/lib/fake-line.ts), for local development and e2e.
//   FAKE_LINE_PORT                       port, 4100 by default
//   LINE_MESSAGING_CHANNEL_SECRET        signs the test webhooks (the app checks them with the same secret)
//   LINE_MESSAGING_CHANNEL_ACCESS_TOKEN  when set, the only token the fake accepts (the seed saves the same one)
// Point the app at it in .env: LINE_API_BASE_URL and LINE_DATA_API_BASE_URL = the URL printed below. Local only: the
// app refuses any LINE address but LINE's own outside APP_ENV=local (src/lib/env.ts). Prints routes and statuses only,
// never a token, a secret or what was sent.
import { randomBytes } from 'node:crypto'
import { startFakeLine } from './lib/fake-line'

const DEFAULT_PORT = 4100

function stop(message: string): never {
  console.error(`line:fake หยุด: ${message}`)
  process.exit(1)
}

const appEnv = process.env.APP_ENV ?? 'local'
if (appEnv !== 'local') stop(`fake LINE server ใช้ได้เฉพาะ APP_ENV=local (ตอนนี้ ${appEnv})`)

const portText = process.env.FAKE_LINE_PORT?.trim() || String(DEFAULT_PORT)
const port = Number(portText)
if (!Number.isInteger(port) || port < 1 || port > 65_535) stop(`FAKE_LINE_PORT ต้องเป็นเลขพอร์ต 1–65535 (ตอนนี้ "${portText}")`)

const configuredSecret = process.env.LINE_MESSAGING_CHANNEL_SECRET?.trim()
const channelSecret = configuredSecret || randomBytes(16).toString('hex')
const accessToken = process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN?.trim() || undefined

const fake = await startFakeLine({
  port,
  channelSecret,
  ...(accessToken ? { accessToken } : {}),
  onRequest: ({ method, route, status }) => console.log(`${new Date().toISOString()} ${method} ${route} ${status}`),
}).catch((error: unknown) => {
  const code = (error as { code?: unknown }).code
  stop(code === 'EADDRINUSE' ? `พอร์ต ${port} ถูกใช้อยู่ — ปิดโปรแกรมที่ใช้พอร์ตนี้ หรือตั้ง FAKE_LINE_PORT เป็นพอร์ตอื่น` : 'เริ่ม server ไม่ได้')
})

console.log(`fake LINE server พร้อมที่ ${fake.url}`)
console.log(`  ตั้งใน .env: LINE_API_BASE_URL=${fake.url} และ LINE_DATA_API_BASE_URL=${fake.url}`)
console.log(
  configuredSecret
    ? '  webhook ทดสอบเซ็นด้วย LINE_MESSAGING_CHANNEL_SECRET'
    : '  ไม่มี LINE_MESSAGING_CHANNEL_SECRET ใน .env: webhook ทดสอบเซ็นด้วย secret สุ่ม แอปจะตอบ 401 (ใส่ secret เลขฐานสิบหก 32 ตัวใน .env แล้วเริ่มใหม่)',
)
console.log(accessToken ? '  รับเฉพาะ access token ใน LINE_MESSAGING_CHANNEL_ACCESS_TOKEN' : '  รับ access token ใดก็ได้ (ไม่มี LINE_MESSAGING_CHANNEL_ACCESS_TOKEN ใน .env)')
console.log('  กด Ctrl+C เพื่อหยุด')

const shutdown = () => {
  fake.close().finally(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
