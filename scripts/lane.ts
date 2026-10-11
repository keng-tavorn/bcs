// Parallel lanes of round P1 (spec §16.13 · ADR-066 · docs/runbooks/parallel-lanes.md · skill bcs-lane)
//   pnpm lane:create <1|2|3>  (from main, E:\BCS) → worktree .worktrees/lN on branch p1/lN, the lane's .env (main's
//                             .env with the lane block), pnpm install, then pnpm db:reset in the lane (creates bcs_lN).
//                             Run again on an existing lane: it rewrites the lane's .env (old one kept as
//                             .env.lane-backup when it differs), installs and resets the lane's own database only.
//   pnpm lane:check           (inside a lane) → the folder, branch and .env match the lane table
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isLane, laneConfig, laneEnvProblems, laneEnvText, LANES, type Lane } from './lib/lane'

function stop(message: string): never {
  console.error(`lane: ${message}`)
  process.exit(1)
}

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

function run(command: string, cwd: string): void {
  console.log(`\n> ${command}  (${cwd})`)
  const r = spawnSync(command, { cwd, stdio: 'inherit', shell: true })
  if (r.status !== 0) stop(`"${command}" ล้ม (exit ${r.status ?? 'signal'})`)
}

const isLinkedWorktree = (dir: string): boolean => existsSync(path.join(dir, '.git')) && statSync(path.join(dir, '.git')).isFile()

function create(lane: Lane): void {
  const root = path.resolve(git(['rev-parse', '--show-toplevel'], process.cwd()).out)
  if (isLinkedWorktree(root)) stop('รันจากโฟลเดอร์ main (E:\\BCS) เท่านั้น ไม่ใช่จากในสาย')
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root).out
  if (branch !== 'main') stop(`โฟลเดอร์หลักต้องอยู่บน branch main (ตอนนี้ ${branch})`)
  const mainEnvPath = path.join(root, '.env')
  if (!existsSync(mainEnvPath)) stop('ไม่พบ .env ของ main — cp .env.example .env แล้วเติมค่าก่อน')

  const cfg = laneConfig(lane)
  const dir = path.join(root, cfg.folder)
  if (existsSync(dir)) {
    const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir).out
    if (current !== cfg.branch) stop(`${cfg.folder} มีอยู่แล้วแต่อยู่บน ${current} ไม่ใช่ ${cfg.branch} — ไม่ได้แตะอะไร`)
    console.log(`สาย ${lane}: ${cfg.folder} มีอยู่แล้วบน ${cfg.branch} · ตั้ง .env ติดตั้ง และ reset ฐานของสายใหม่`)
  } else {
    const hasBranch = git(['rev-parse', '--verify', '--quiet', `refs/heads/${cfg.branch}`], root).ok
    const add = hasBranch ? ['worktree', 'add', cfg.folder, cfg.branch] : ['worktree', 'add', '-b', cfg.branch, cfg.folder, 'main']
    const r = git(add, root)
    if (!r.ok) stop(`git ${add.join(' ')} ล้ม:\n${r.out}`)
    console.log(`สาย ${lane}: สร้าง ${cfg.folder} บน ${cfg.branch}${hasBranch ? ' (branch เดิม)' : ' จาก main'}`)
  }

  const envPath = path.join(dir, '.env')
  const next = laneEnvText(readFileSync(mainEnvPath, 'utf8'), lane)
  if (existsSync(envPath)) {
    const before = readFileSync(envPath, 'utf8')
    if (before !== next) writeFileSync(path.join(dir, '.env.lane-backup'), before)
  }
  writeFileSync(envPath, next)
  const problems = laneEnvProblems(next, lane)
  if (problems.length > 0) stop(`.env ของสายไม่ตรงตาราง:\n${problems.join('\n')}`)

  run('pnpm install --frozen-lockfile', dir)
  run('pnpm db:reset', dir)
  console.log(
    `\nสาย ${lane} พร้อม: โฟลเดอร์ ${dir} · branch ${cfg.branch} · เว็บ http://localhost:${cfg.webPort} · ` +
      `ฐาน ${cfg.db.dev} (เทสต์ ${cfg.db.test} · verify ${cfg.db.verify} · e2e ${cfg.db.e2e}) · e2e ${cfg.e2ePort} · fake LINE ${cfg.fakeLinePort}`,
  )
}

function check(): void {
  const root = path.resolve(git(['rev-parse', '--show-toplevel'], process.cwd()).out)
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root).out
  const lane = LANES.find((n) => laneConfig(n).branch === branch)
  if (!lane) stop(`branch ${branch} ไม่ใช่ branch ของสาย (p1/l1 p1/l2 p1/l3)`)
  const cfg = laneConfig(lane)
  if (!isLinkedWorktree(root) || path.basename(root) !== `l${lane}` || path.basename(path.dirname(root)) !== '.worktrees') {
    stop(`branch ${branch} ต้องอยู่ในโฟลเดอร์ ${cfg.folder} (ตอนนี้ ${root})`)
  }
  const envPath = path.join(root, '.env')
  if (!existsSync(envPath)) stop(`ไม่พบ .env ของสาย — รัน pnpm lane:create ${lane} จาก main`)
  const problems = laneEnvProblems(readFileSync(envPath, 'utf8'), lane)
  if (problems.length > 0) stop(`.env ของสาย ${lane} ไม่ตรงตาราง (รัน pnpm lane:create ${lane} จาก main):\n${problems.join('\n')}`)
  console.log(`สาย ${lane} (${cfg.branch}) · .env ตรงตาราง · เว็บ ${cfg.webPort} · ฐาน ${cfg.db.dev}`)
}

const [command, arg] = process.argv.slice(2)
if (command === 'create') {
  if (!isLane(arg)) stop('ใช้ pnpm lane:create <1|2|3>')
  create(Number(arg) as Lane)
} else if (command === 'check') {
  check()
} else {
  stop('ใช้ pnpm lane:create <1|2|3> หรือ pnpm lane:check')
}
