// Time sources. Business time (ctx.now) is injectable so tests, the demo-history seed and e2e can control it;
// security timers (sessions, step-up windows, TOTP) always use real time. src/core never reads a clock:
// it receives `now` as a parameter.

export interface Clock {
  now(): Date
}

export const systemClock: Clock = {
  now: () => new Date(),
}

export function fixedClock(at: Date | string): Clock {
  const t = typeof at === 'string' ? new Date(at) : new Date(at.getTime())
  if (Number.isNaN(t.getTime())) throw new RangeError(`invalid instant: ${String(at)}`)
  return { now: () => new Date(t.getTime()) }
}

/** A clock tests can move forward explicitly. */
export class ManualClock implements Clock {
  private current: number

  constructor(start: Date | string) {
    const t = typeof start === 'string' ? Date.parse(start) : start.getTime()
    if (Number.isNaN(t)) throw new RangeError(`invalid instant: ${String(start)}`)
    this.current = t
  }

  now(): Date {
    return new Date(this.current)
  }

  set(at: Date | string): void {
    const t = typeof at === 'string' ? Date.parse(at) : at.getTime()
    if (Number.isNaN(t)) throw new RangeError(`invalid instant: ${String(at)}`)
    this.current = t
  }

  advance(ms: number): void {
    this.current += ms
  }
}
