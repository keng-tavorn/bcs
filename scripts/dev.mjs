// pnpm dev: next dev on the port of APP_URL in .env (3000 on main, the lane's port in a lane · spec §16.13 · P1-01).
// Next.js picks its port before it reads .env, so the port is passed on the command line. An explicit --port/-p wins.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { parse } from 'dotenv'

const args = process.argv.slice(2)
const env = existsSync('.env') ? parse(readFileSync('.env')) : {}
let port = '3000'
try {
  port = new URL(env.APP_URL ?? 'http://localhost:3000').port || '3000'
} catch {
  // APP_URL is checked by the env gate of pnpm verify; keep the default here
}
const explicit = args.some((a) => a === '-p' || a === '--port' || a.startsWith('--port='))
const next = createRequire(import.meta.url).resolve('next/dist/bin/next')
const child = spawn(process.execPath, [next, 'dev', ...(explicit ? [] : ['--port', port]), ...args], { stdio: 'inherit' })
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s))
