import type { Env } from '@/lib/env'
import { makeCtx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { readLineChannelStored } from '@/server/queries/line-channel'
import { saveLineChannelSettings, type SaveLineChannelInput } from './settings'

// The demo organization's LINE channel from the LINE_* values of .env (S5 sub-spec "ค่า channel ต่อองค์กร"), for local
// (the fake LINE server, pnpm line:fake) and staging (the real channel of D-03). It goes through the same command as the
// settings screen, as the organization's ORG_ADMIN: the same formats, sealing, channelKey and event. Nothing happens when
// the values are not set or the organization has its channel already (prisma/seed.ts may run again); values in the wrong
// format are reported by variable name, never by value, and the rest of the seed carries on.

export type LineSeedEnv = Pick<
  Env,
  'APP_ENV' | 'LINE_PROVIDER_ID' | 'LINE_MESSAGING_CHANNEL_ID' | 'LINE_MESSAGING_CHANNEL_SECRET' | 'LINE_MESSAGING_CHANNEL_ACCESS_TOKEN' | 'LINE_LIFF_CHANNEL_ID' | 'NEXT_PUBLIC_LIFF_ID'
>

const REQUIRED = {
  providerId: 'LINE_PROVIDER_ID',
  messagingChannelId: 'LINE_MESSAGING_CHANNEL_ID',
  channelSecret: 'LINE_MESSAGING_CHANNEL_SECRET',
  channelAccessToken: 'LINE_MESSAGING_CHANNEL_ACCESS_TOKEN',
} as const satisfies Record<string, keyof LineSeedEnv>
const VARIABLE_OF: Readonly<Record<string, keyof LineSeedEnv>> = { ...REQUIRED, liffId: 'NEXT_PUBLIC_LIFF_ID', liffChannelId: 'LINE_LIFF_CHANNEL_ID' }

/** The seed's own idempotency key: running the seed again replays instead of saving twice */
export const LINE_SEED_IDEMPOTENCY_KEY = 'seed:line-channel'

export type LineSeedOutcome =
  | { readonly status: 'CREATED'; readonly channelKey: string }
  | { readonly status: 'EXISTS' }
  | { readonly status: 'NOT_SET' }
  | { readonly status: 'INCOMPLETE'; readonly missing: readonly string[] }
  | { readonly status: 'NO_ADMIN' }
  | { readonly status: 'REFUSED'; readonly code: string; readonly variable: string | null }

export async function seedLineChannel(organizationId: string, env: LineSeedEnv, now: Date): Promise<LineSeedOutcome> {
  if (env.APP_ENV !== 'local' && env.APP_ENV !== 'staging') throw new Error('the LINE channel of the demo organization is seeded in local and staging only')
  const missing = Object.values(REQUIRED).filter((variable) => !env[variable])
  if (missing.length === Object.keys(REQUIRED).length) return { status: 'NOT_SET' }
  if (missing.length > 0) return { status: 'INCOMPLETE', missing }
  if (await readLineChannelStored(organizationId)) return { status: 'EXISTS' }

  // The organization's first ORG_ADMIN saves it, as on the settings screen (admin.channels)
  const admin = await forTenant(organizationId).roleAssignment.findFirst({
    where: { role: 'ORG_ADMIN', revokedAt: null, member: { status: 'ACTIVE' } },
    orderBy: [{ grantedAt: 'asc' }, { id: 'asc' }],
    select: { memberId: true },
  })
  if (!admin) return { status: 'NO_ADMIN' }
  const ctx = makeCtx({ organizationId, actor: { type: 'USER', memberId: admin.memberId }, channel: 'SYSTEM', now })
  const input: SaveLineChannelInput = {
    providerId: env.LINE_PROVIDER_ID ?? '',
    messagingChannelId: env.LINE_MESSAGING_CHANNEL_ID ?? '',
    channelSecret: env.LINE_MESSAGING_CHANNEL_SECRET ?? '',
    channelAccessToken: env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN ?? '',
    liffId: env.NEXT_PUBLIC_LIFF_ID ?? '',
    liffChannelId: env.LINE_LIFF_CHANNEL_ID ?? '',
    // Every required value is there, so the demo uses LINE from the start (the admin can switch it off)
    active: true,
  }
  // Nothing of the seed is sent to Inngest (as the demo history does)
  const saved = await saveLineChannelSettings(ctx, input, { idempotencyKey: LINE_SEED_IDEMPOTENCY_KEY, sender: null, suppressOutbox: true })
  if (!saved.ok) {
    const field = typeof saved.error.details?.field === 'string' ? saved.error.details.field : null
    return { status: 'REFUSED', code: saved.error.code, variable: field ? (VARIABLE_OF[field] ?? null) : null }
  }
  return { status: 'CREATED', channelKey: saved.data.channelKey }
}

/** One line for the output of pnpm db:seed (Thai, like the rest of it); names variables, never values. */
export function describeLineSeed(outcome: LineSeedOutcome): string {
  switch (outcome.status) {
    case 'CREATED':
      return 'สร้างค่า LINE channel ขององค์กรตัวอย่างจาก LINE_* ใน .env แล้ว (secret และ access token เข้ารหัสแล้ว) · ตรวจด้วยปุ่มทดสอบการเชื่อมต่อในหน้าตั้งค่า LINE'
    case 'EXISTS':
      return 'มีค่า LINE channel อยู่แล้ว ไม่ได้เปลี่ยน (แก้ที่หน้าตั้งค่า LINE หรือ pnpm db:reset บนเครื่อง)'
    case 'NOT_SET':
      return 'ไม่ได้สร้างค่า LINE channel เพราะยังไม่ได้ใส่ LINE_* ใน .env (ไม่จำเป็นถ้ายังไม่ใช้ LINE)'
    case 'INCOMPLETE':
      return `ไม่ได้สร้างค่า LINE channel เพราะยังขาด ${outcome.missing.join(', ')} ใน .env`
    case 'NO_ADMIN':
      return 'ไม่ได้สร้างค่า LINE channel เพราะองค์กรตัวอย่างยังไม่มีผู้ดูแลองค์กร (ORG_ADMIN)'
    case 'REFUSED':
      return outcome.variable
        ? `ไม่ได้สร้างค่า LINE channel เพราะ ${outcome.variable} ใน .env รูปแบบไม่ถูกต้อง (${outcome.code}) — คัดลอกค่าจาก LINE Developers Console ใหม่`
        : `ไม่ได้สร้างค่า LINE channel (${outcome.code})`
  }
}
