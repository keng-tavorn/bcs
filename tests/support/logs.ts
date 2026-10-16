import { Writable } from 'node:stream'
import { vi } from 'vitest'
import { createLogger, logger } from '@/lib/logger'

/** The JSON lines the app logs while `run` runs (the app's serializers and redaction), after a probe line */
export async function logsOf(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = []
  const sink = createLogger(new Writable({ write: (chunk, _e, done) => (lines.push(String(chunk)), done()) }), 'trace')
  const spies = [vi.spyOn(logger, 'child').mockImplementation(((b, o) => sink.child(b, o)) as typeof logger.child)]
  for (const level of ['info', 'warn', 'error', 'debug'] as const) spies.push(vi.spyOn(logger, level).mockImplementation(((...a: unknown[]) => (sink[level] as (...x: unknown[]) => void)(...a)) as never) as never)
  try {
    logger.info({ probe: true }, 'log capture probe')
    await run()
  } finally {
    spies.forEach((s) => s.mockRestore())
  }
  return lines.join('\n')
}
