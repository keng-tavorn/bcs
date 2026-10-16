// S17-09 (FR-PLT-301 AC10, BR-APP-01, BR-APP-02, ADR-163): the BCS Go app is a Capacitor shell around the web of one
// environment. It holds no business code (lint: nothing in mobile/ imports src), LIFF never loads its plugins, its
// user agent mark is the one the web reads for the APP channel, and its APK workflow runs only when asked or when
// mobile/** changes on main.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseDotenv } from 'dotenv'
import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { APP_USER_AGENT_MARKER, assetLinksOf, isAppUserAgent } from '@/lib/app-client'
import { parseEnv } from '@/lib/env'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const SHELL = path.join(ROOT, 'mobile', 'bcs-go')

interface ShellConfig {
  readonly appId: string
  readonly webDir: string
  readonly appendUserAgent: string
  readonly server: { readonly url: string; readonly allowNavigation: readonly string[]; readonly cleartext?: boolean }
  readonly android: { readonly allowMixedContent: boolean; readonly webContentsDebuggingEnabled: boolean }
}
interface ShellModule {
  readonly APP_USER_AGENT_MARKER: string
  readonly APP_VERSION: string
  readonly bcsGoConfig: (env: Readonly<Record<string, string | undefined>>) => ShellConfig
}

// The shell's config is outside the root TypeScript project (mobile/ has its own, with Capacitor's types), so it is
// loaded by URL: vitest strips its type-only import of @capacitor/cli
let shell: ShellModule
let eslint: ESLint
beforeAll(async () => {
  // Its default export is the config of the environment the CLI runs for, read from the process environment
  vi.stubEnv('BCS_GO_SERVER_URL', 'https://bcs-staging-demo.vercel.app')
  shell = (await import(/* @vite-ignore */ pathToFileURL(path.join(SHELL, 'capacitor.config.ts')).href)) as ShellModule
  vi.unstubAllEnvs()
  eslint = new ESLint({ cwd: ROOT })
}, 60_000)

// The first lint of a run loads the whole config and its plugins (tests/unit/lint-rules.test.ts)
vi.setConfig({ testTimeout: 60_000 })

async function ruleIds(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file), warnIgnored: true })
  return (result?.messages ?? []).filter((m) => m.severity === 2).map((m) => m.ruleId ?? `fatal:${m.message}`)
}

const APP_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 8 Build/AP4A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36 BCSGo/0.1.0'

describe('[FR-PLT-301/AC10] mobile/ holds no business code and LIFF never loads the app plugins (BR-APP-01)', () => {
  it('refuses src — the server and the core above all — in every import form inside mobile/', async () => {
    const file = 'mobile/bcs-go/src/canary.ts'
    expect(await ruleIds(file, "import { runCommand } from '@/server/services/_pipeline'\nexport const x = runCommand\n")).toContain('bcs/restricted-imports')
    expect(await ruleIds(file, "import { grossOf } from '../../../src/core/money'\nexport const x = grossOf\n")).toContain('bcs/restricted-imports')
    expect(await ruleIds(file, "export const load = () => import('../../../src/server/db/tenant')\n")).toContain('bcs/restricted-imports')
    expect(await ruleIds(file, "// eslint-disable-next-line\nexport * from '@/core/doa'\n")).toContain('bcs/restricted-imports')
    expect(await ruleIds('mobile/bcs-go/capacitor.config.ts', "import { env } from '../../src/lib/env'\nexport const x = env\n")).toContain('bcs/restricted-imports')
  })

  it('lets the shell use Capacitor and Node', async () => {
    expect(await ruleIds('mobile/bcs-go/src/canary.ts', "import { Capacitor } from '@capacitor/core'\nimport { readFileSync } from 'node:fs'\nexport const x = [Capacitor, readFileSync]\n")).toEqual([])
  })

  it('refuses Capacitor and ML Kit packages in LIFF pages and the light set', async () => {
    for (const file of ['src/app/liff/home/page.tsx', 'src/ui/liff/frame.tsx']) {
      expect(await ruleIds(file, "import { PushNotifications } from '@capacitor/push-notifications'\nexport const x = PushNotifications\n"), file).toContain('bcs/liff-imports')
      expect(await ruleIds(file, "import { BarcodeScanner } from '@capacitor-mlkit/barcode-scanning'\nexport const x = BarcodeScanner\n"), file).toContain('bcs/liff-imports')
    }
  })

  it('the shell has no folder of code besides its config: the web is loaded, never bundled (ADR-163)', () => {
    const pkg = JSON.parse(readFileSync(path.join(SHELL, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> }
    // Capacitor itself and nothing of the web's stack
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@capacitor/android', '@capacitor/core'])
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(['@capacitor/cli', '@types/node', 'typescript'])
    expect(readFileSync(path.join(SHELL, 'www', 'index.html'), 'utf8')).not.toMatch(/<script/i)
  })

  it('keeps the WebView data (session cookie, offline queue of BR-APP-03) out of Android backups and transfers', () => {
    const manifest = readFileSync(path.join(SHELL, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8')
    expect(manifest).toContain('android:allowBackup="false"')
    expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"')
    const rules = readFileSync(path.join(SHELL, 'android', 'app', 'src', 'main', 'res', 'xml', 'data_extraction_rules.xml'), 'utf8')
    for (const part of ['cloud-backup', 'device-transfer']) {
      const section = rules.slice(rules.indexOf(`<${part}>`), rules.indexOf(`</${part}>`))
      for (const domain of ['root', 'file', 'database', 'sharedpref', 'external']) expect(section, `${part} ${domain}`).toContain(`<exclude domain="${domain}" />`)
    }
  })
})

describe('[FR-PLT-301/AC10] the app opens one environment and marks its user agent (BR-APP-01, BR-APP-02)', () => {
  it('uses the same mark and version as the web reads and the Android build declares', () => {
    expect(shell.APP_USER_AGENT_MARKER).toBe(APP_USER_AGENT_MARKER)
    const pkg = JSON.parse(readFileSync(path.join(SHELL, 'package.json'), 'utf8')) as { version: string }
    expect(shell.APP_VERSION).toBe(pkg.version)
    expect(readFileSync(path.join(SHELL, 'android', 'app', 'build.gradle'), 'utf8')).toContain(`versionName "${pkg.version}"`)
    const config = shell.bcsGoConfig({ BCS_GO_SERVER_URL: 'https://bcs-staging-demo.vercel.app' })
    expect(isAppUserAgent(`Mozilla/5.0 (Linux; Android 15; wv) Chrome/140.0.0.0 Mobile Safari/537.36 ${config.appendUserAgent}`)).toBe(true)
  })

  it('loads the web of server.url and navigates on that origin only', () => {
    expect(shell.bcsGoConfig({ BCS_GO_SERVER_URL: 'https://bcs-staging-demo.vercel.app' })).toMatchObject({
      appId: 'th.bcs.go',
      webDir: 'www',
      appendUserAgent: 'BCSGo/0.1.0',
      server: { url: 'https://bcs-staging-demo.vercel.app', allowNavigation: ['bcs-staging-demo.vercel.app'] },
      android: { allowMixedContent: false, webContentsDebuggingEnabled: false },
    })
    expect(shell.bcsGoConfig({ BCS_GO_SERVER_URL: 'https://bcs-staging-demo.vercel.app' }).server.cleartext).toBeUndefined()
    // The Android emulator reaches the developer's own web over plain http, and only there
    expect(shell.bcsGoConfig({ BCS_GO_SERVER_URL: 'http://10.0.2.2:3001', BCS_GO_WEBVIEW_DEBUG: '1' })).toMatchObject({
      server: { url: 'http://10.0.2.2:3001', allowNavigation: ['10.0.2.2'], cleartext: true },
      android: { webContentsDebuggingEnabled: true },
    })
  })

  it('refuses a missing, plain-http or non-origin web address', () => {
    expect(() => shell.bcsGoConfig({})).toThrow(/BCS_GO_SERVER_URL is not set/)
    expect(() => shell.bcsGoConfig({ BCS_GO_SERVER_URL: 'http://bcs.example.com' })).toThrow(/must be https/)
    expect(() => shell.bcsGoConfig({ BCS_GO_SERVER_URL: 'https://bcs.example.com/liff' })).toThrow(/origin only/)
    expect(() => shell.bcsGoConfig({ BCS_GO_SERVER_URL: 'https://user:pw@bcs.example.com' })).toThrow(/origin only/)
    expect(() => shell.bcsGoConfig({ BCS_GO_SERVER_URL: 'ftp://bcs.example.com' })).toThrow(/must be https/)
  })

  it('reads the mark as a token of its own, in any position of the user agent', () => {
    expect(isAppUserAgent(APP_UA)).toBe(true)
    expect(isAppUserAgent('BCSGo/1.2.3 Mozilla/5.0')).toBe(true)
    for (const ua of [null, undefined, '', 'Mozilla/5.0 Chrome/140.0', 'Mozilla/5.0 NotBCSGo/0.1.0', 'Mozilla/5.0 BCSGo/0.1', 'Mozilla/5.0 BCSGo/0.1.0x', 'Mozilla/5.0 BCSGo']) {
      expect(isAppUserAgent(ua), String(ua)).toBe(false)
    }
  })
})

describe('[FR-PLT-301/AC10] the demo APK workflow (ADR-163)', () => {
  const workflow = parse(readFileSync(path.join(ROOT, '.github', 'workflows', 'bcs-go-apk.yml'), 'utf8')) as {
    on: { workflow_dispatch?: unknown; push?: { branches?: string[]; paths?: string[] }; pull_request?: unknown }
    jobs: { apk: { steps: Array<{ run?: string; uses?: string; with?: Record<string, unknown> }> } }
  }

  it('runs when pressed and on a push to main that changes mobile/** only', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch'])
    expect(workflow.on.push).toEqual({ branches: ['main'], paths: ['mobile/**'] })
  })

  it('syncs the shell, signs with the demo keystore from secrets and keeps the APK', () => {
    const runs = workflow.jobs.apk.steps.map((s) => s.run ?? '').join('\n')
    expect(runs).toContain('pnpm install --frozen-lockfile --ignore-workspace')
    expect(runs).toContain('pnpm exec tsc --noEmit')
    expect(runs).toContain('pnpm exec cap sync android')
    expect(runs).toMatch(/assembleRelease[\s\S]*android\.injected\.signing\.store\.file/)
    expect(readFileSync(path.join(ROOT, '.github', 'workflows', 'bcs-go-apk.yml'), 'utf8')).toContain('${{ secrets.BCS_GO_KEYSTORE_B64 }}')
    expect(workflow.jobs.apk.steps.some((s) => s.uses?.startsWith('actions/upload-artifact@'))).toBe(true)
  })
})

describe('[FR-PLT-301/AC10] /.well-known/assetlinks.json ties the domain to the app (ADR-166)', () => {
  const CERT = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':')

  it('names the package and every signing certificate for passkeys and links', () => {
    expect(assetLinksOf('th.bcs.go', `${CERT},${CERT.replace(/^00/, 'FF')}`)).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
        target: { namespace: 'android_app', package_name: 'th.bcs.go', sha256_cert_fingerprints: [CERT, CERT.replace(/^00/, 'FF')] },
      },
    ])
  })

  it('is absent until both values are set', () => {
    expect(assetLinksOf(undefined, CERT)).toBeNull()
    expect(assetLinksOf('th.bcs.go', undefined)).toBeNull()
  })

  it('the environment accepts a fingerprint in any case and spacing, and refuses another form', () => {
    // .env.example as committed: a local environment that parses
    const base = { ...parseDotenv(readFileSync(path.join(ROOT, '.env.example'), 'utf8')), ENCRYPTION_KEY: `base64:${Buffer.alloc(32, 7).toString('base64')}` }
    const lower = parseEnv({ ...base, BCS_GO_ANDROID_PACKAGE: 'th.bcs.go', BCS_GO_ANDROID_CERT_SHA256: ` ${CERT.toLowerCase()} ` })
    expect(lower.BCS_GO_ANDROID_CERT_SHA256).toBe(CERT)
    expect(() => parseEnv({ ...base, BCS_GO_ANDROID_CERT_SHA256: CERT.slice(3) })).toThrow(/BCS_GO_ANDROID_CERT_SHA256/)
    expect(() => parseEnv({ ...base, BCS_GO_ANDROID_PACKAGE: 'BCS Go' })).toThrow(/BCS_GO_ANDROID_PACKAGE/)
  })
})
