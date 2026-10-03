#!/usr/bin/env node
// Runs a Python 3 script on any OS. Tries python3, python, then `py -3`, test-running each one, because on
// Windows the Microsoft Store `python3` stub sits on PATH but fails. Forces UTF-8 I/O so the Thai output of
// spec_check.py / validate_inputs.py does not crash on cp874 consoles or pipes.
import { spawnSync } from 'node:child_process'

const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
const candidates = [['python3'], ['python'], ['py', '-3']]

function works([cmd, ...pre]) {
  const probe = spawnSync(cmd, [...pre, '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'], {
    env,
    stdio: 'ignore',
  })
  return probe.status === 0
}

const found = candidates.find(works)
if (!found) {
  console.error('ไม่พบ Python 3.9 ขึ้นไป (ลอง python3, python และ py -3 แล้ว) — ติดตั้ง Python แล้วรันใหม่')
  process.exit(2)
}
const [cmd, ...pre] = found
const run = spawnSync(cmd, [...pre, '-X', 'utf8', ...process.argv.slice(2)], { env, stdio: 'inherit' })
process.exit(run.status ?? 1)
