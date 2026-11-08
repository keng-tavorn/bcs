// `pnpm build`: next build with an 8 GB heap. Next.js type-checks the app in a worker of its own, which takes its heap from
// NODE_OPTIONS (not from this process's flags); with the Prisma types of S10 and S11 the check needs about 4.8 GB, more
// than Node's default and CI's NODE_OPTIONS of 4096 (as `pnpm typecheck`, package.json). Any other NODE_OPTIONS is kept.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const HEAP = '--max-old-space-size=8192'
const options = (process.env.NODE_OPTIONS ?? '').replace(/--max-old-space-size=\d+/g, '').trim()
const next = createRequire(import.meta.url).resolve('next/dist/bin/next')
const run = spawnSync(process.execPath, [next, 'build', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: `${options} ${HEAP}`.trim() } })
process.exit(run.status ?? 1)
