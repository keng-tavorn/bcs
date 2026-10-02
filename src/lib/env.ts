import { z } from 'zod'

// Environment schema (spec Appendix B + additions in .env.example). Validated at start-up and by the
// `pnpm verify` env gate; a missing or malformed value stops the app and names the variable.

const APP_ENVS = ['local', 'preview', 'staging', 'production'] as const
export type AppEnv = (typeof APP_ENVS)[number]

// Empty strings in .env mean "not set".
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional())

const flag = optional(z.enum(['0', '1', 'true', 'false']).transform((v) => v === '1' || v === 'true'))

const ENCRYPTION_KEY = z
  .string()
  .regex(/^base64:/, 'ต้องขึ้นต้นด้วย base64:')
  .refine((v) => Buffer.from(v.slice('base64:'.length), 'base64').length === 32, 'ต้องถอดรหัสได้ 32 ไบต์ (AES-256-GCM)')

const schema = z
  .object({
    APP_ENV: z.enum(APP_ENVS),
    APP_URL: z.url(),
    SEED_DEV_PASSWORD: optional(z.string().min(8)),

    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'ต้องเป็น connection string ของ PostgreSQL'),
    DIRECT_URL: z.string().regex(/^postgres(ql)?:\/\//, 'ต้องเป็น connection string ของ PostgreSQL'),

    BETTER_AUTH_SECRET: z.string().min(32, 'ต้องยาวอย่างน้อย 32 ตัวอักษร'),
    BETTER_AUTH_URL: z.url(),
    ENCRYPTION_KEY,

    S3_ENDPOINT: optional(z.url()),
    S3_REGION: z.string().min(1),
    S3_BUCKET: z.string().min(3),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: flag,

    EMAIL_PROVIDER: z.enum(['smtp', 'resend', 'ses']),
    EMAIL_SMTP_URL: optional(z.string().regex(/^smtps?:\/\//, 'ต้องขึ้นต้นด้วย smtp:// หรือ smtps://')),
    EMAIL_FROM: z.string().min(3),

    REGISTRY_MODE: z.enum(['stub', 'live']).default('stub'),
    RD_VAT_SERVICE_URL: optional(z.url()),
    DBD_JURISTIC_API_URL: optional(z.url()),

    INNGEST_DEV: optional(z.string()),
    INNGEST_EVENT_KEY: optional(z.string()),
    INNGEST_SIGNING_KEY: optional(z.string()),

    LINE_PROVIDER_ID: optional(z.string()),
    LINE_MESSAGING_CHANNEL_ID: optional(z.string()),
    LINE_MESSAGING_CHANNEL_SECRET: optional(z.string()),
    LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: optional(z.string()),
    LINE_LOGIN_CHANNEL_ID: optional(z.string()),
    LINE_LOGIN_CHANNEL_SECRET: optional(z.string()),
    LINE_LIFF_CHANNEL_ID: optional(z.string()),
    NEXT_PUBLIC_LIFF_ID: optional(z.string()),
    LINE_API_BASE_URL: optional(z.url()).transform((v) => v ?? 'https://api.line.me'),

    GOOGLE_CLIENT_ID: optional(z.string()),
    GOOGLE_CLIENT_SECRET: optional(z.string()),
    MICROSOFT_CLIENT_ID: optional(z.string()),
    MICROSOFT_CLIENT_SECRET: optional(z.string()),
    MICROSOFT_TENANT_ID: optional(z.string()),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    SENTRY_DSN: optional(z.url()),

    AI_ENABLED: flag,
    ANTHROPIC_API_KEY: optional(z.string()),
    AI_MODEL_DEFAULT: optional(z.string()),

    SEED_TOTP_KEY: optional(z.string().min(32, 'ต้องยาวอย่างน้อย 32 ตัวอักษร')),
    APP_COMMIT_SHA: optional(z.string()),
    E2E_TEST_CLOCK: flag,
    LIFF_MOCK: flag,
    VERCEL_TOKEN: optional(z.string()),
  })
  .superRefine((e, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message })
    const local = e.APP_ENV === 'local'

    if (e.EMAIL_PROVIDER === 'smtp' && !e.EMAIL_SMTP_URL) issue('EMAIL_SMTP_URL', 'ต้องตั้งเมื่อ EMAIL_PROVIDER=smtp')
    // Tier 1–3 never call AI (EG-1, NG-5); AI stays off until S13.
    if (e.AI_ENABLED) issue('AI_ENABLED', 'ต้องเป็น false จนถึงขั้น S13 (EG-1)')

    if (!local) {
      // Example values from .env.example must never reach a shared environment.
      for (const key of ['BETTER_AUTH_SECRET', 'SEED_DEV_PASSWORD', 'SEED_TOTP_KEY', 'ENCRYPTION_KEY'] as const) {
        const value = e[key]
        if (typeof value === 'string' && /change-me|REPLACE_WITH/i.test(value)) issue(key, 'ยังเป็นค่าตัวอย่างจาก .env.example — สร้างค่าสุ่มใหม่')
      }
      if (e.INNGEST_DEV) issue('INNGEST_DEV', 'ต้องว่างนอก local (Inngest v4 ใช้ cloud mode)')
      if (!e.INNGEST_SIGNING_KEY) issue('INNGEST_SIGNING_KEY', 'ต้องตั้งนอก local')
      if (!e.INNGEST_EVENT_KEY) issue('INNGEST_EVENT_KEY', 'ต้องตั้งนอก local')
      // Test-only switches are refused outside local (they would bypass real time or real LIFF login).
      if (e.E2E_TEST_CLOCK) issue('E2E_TEST_CLOCK', 'ใช้ได้เฉพาะ APP_ENV=local')
      if (e.LIFF_MOCK) issue('LIFF_MOCK', 'ใช้ได้เฉพาะ APP_ENV=local')
      if (!e.APP_URL.startsWith('https://')) issue('APP_URL', 'ต้องเป็น https นอก local (NFR-SEC-02)')
    }
    if (e.APP_ENV === 'production' && (e.SEED_DEV_PASSWORD || e.SEED_TOTP_KEY)) {
      issue('SEED_DEV_PASSWORD', 'production ห้ามมีค่าของ seed (ผู้ใช้ตัวอย่างสร้างได้เฉพาะ local/staging)')
    }
  })

export type Env = z.infer<typeof schema>

export class EnvError extends Error {
  constructor(readonly issues: string[]) {
    super(`ค่าใน environment ไม่ถูกต้อง:\n${issues.map((i) => `- ${i}`).join('\n')}`)
    this.name = 'EnvError'
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source)
  if (!result.success) {
    throw new EnvError(result.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`))
  }
  return result.data
}

let cached: Env | undefined

/** Validated environment of the running process (memoized). */
export function getEnv(): Env {
  cached ??= parseEnv(process.env)
  return cached
}
