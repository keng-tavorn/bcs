import { spawnSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { e2eEnv } from '../support/e2e-env'
import { h1 } from './finance-support'
import { expect } from './fixtures'

// What the specs of the tier-2 invoice screens share (S8-13, NEW-115): the organization of a run from tests/e2e/s8-scene.ts
// and how its members sign in. Not a test file.

export function s8Scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/s8-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`S8 scene ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

/** A member of the scene's organization signs in: e-mail <code>.<tag>@s8.bcs.local, TOTP as the scene derived it */
export async function signIn(page: Page, code: string, tag: string) {
  const local = `${code}.${tag}`
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(`${local}@s8.bcs.local`)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page).toHaveURL(/\/login\/2fa$/)
  await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, local)))
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  await expect(h1(page)).toContainText('สวัสดี')
}
