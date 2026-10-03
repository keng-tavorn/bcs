import { scrubText } from '@/lib/logger'

// What an unexpected error may tell the error collector (FR-PLT-008 AC3: with organizationId, without personal
// data). Error messages are never included: a Prisma message quotes the call with every argument value, and a
// Postgres message quotes the offending input (`invalid input syntax for type uuid: "…"`), so either can carry
// e-mail addresses, names or phone numbers. What is kept identifies the failure without its data: the error class,
// the Prisma code (P2xxx), the Postgres SQLSTATE, model / table / column / constraint names, and the stack frames
// (code locations, not the message lines at the top of the stack). The caller adds organizationId, the command,
// requestId and correlationId as log bindings.

export interface ErrorDescription {
  readonly type: string
  /** Prisma error code (P2002…) or a Node / driver error code (ECONNREFUSED…) */
  readonly code?: string
  /** Postgres SQLSTATE (23505, 22P02, 57014…) */
  readonly sqlState?: string
  /** Prisma driver adapter error kind (UniqueConstraintViolation, InvalidInputValue…) */
  readonly kind?: string
  readonly model?: string
  readonly table?: string
  readonly column?: string
  readonly constraint?: string
  readonly fields?: readonly string[]
  readonly frames?: readonly string[]
  readonly cause?: ErrorDescription
  readonly errors?: readonly ErrorDescription[]
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const IDENTIFIER = /^[A-Za-z_][\w$.-]{0,127}$/
const PRISMA_CODE = /^P[1-9]\d{3}$/
const SQLSTATE = /^[0-9A-Z]{5}$/
// A V8 stack frame: "at fn (file:1:2)", "at file:1:2", "at fn (native)", "at async Promise.all (index 0)"
const FRAME = /^at (?:.+ \((?:.+:\d+:\d+|native|<anonymous>|index \d+)\)|.+:\d+:\d+|<anonymous>)$/
const MAX_FRAMES = 12
const MAX_DEPTH = 3
const MAX_NAMES = 16
const MAX_INNER_ERRORS = 3

/** Reads a property without ever throwing (getters and proxies may). */
function read(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

const identifier = (value: unknown): string | undefined => (typeof value === 'string' && IDENTIFIER.test(value) ? value : undefined)

function identifiers(value: unknown): string[] | undefined {
  const names = (Array.isArray(value) ? value.slice(0, MAX_NAMES) : [value]).map(identifier).filter((n): n is string => n !== undefined)
  return names.length > 0 ? names : undefined
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value !== 'object' && typeof value !== 'function') return typeof value
  // A class name set in code (EventSchemaError) survives minification; pg's DatabaseError names itself "error"
  const name = identifier(read(value, 'name'))
  if (name && name !== 'Error' && /^[A-Z]/.test(name)) return name
  try {
    const ctor = identifier((Object.getPrototypeOf(value) as { constructor?: { name?: unknown } } | null)?.constructor?.name)
    if (ctor) return ctor
  } catch {
    // unreadable prototype
  }
  return value instanceof Error ? 'Error' : 'Object'
}

/** The frames of the stack, without its header ("<name>: <message>", which may span many lines). */
function framesOf(error: unknown): string[] | undefined {
  const stack = read(error, 'stack')
  if (typeof stack !== 'string') return undefined
  const message = read(error, 'message')
  const name = read(error, 'name')
  const header = typeof message === 'string' && message ? `${String(name ?? 'Error')}: ${message}` : String(name ?? 'Error')
  const lines = (stack.startsWith(header) ? stack.slice(header.length) : stack).split('\n')
  // Only the trailing run of frame lines: whatever precedes it belongs to the message
  const frames: string[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!FRAME.test(line)) break
    frames.unshift(scrubText(line))
  }
  return frames.length > 0 ? frames.slice(0, MAX_FRAMES) : undefined
}

function describeValue(value: unknown, depth: number, seen: Set<unknown>): ErrorDescription {
  const description: Mutable<ErrorDescription> = { type: typeOf(value) }
  if (value === null || typeof value !== 'object' || seen.has(value)) return description
  seen.add(value)

  const code = read(value, 'code') ?? read(value, 'errorCode')
  const looksLikePostgres = read(value, 'severity') !== undefined || read(value, 'routine') !== undefined
  if (typeof code === 'string') {
    if (PRISMA_CODE.test(code)) description.code = code
    else if (looksLikePostgres && SQLSTATE.test(code)) description.sqlState = code
    else if (identifier(code)) description.code = code
  }

  // Prisma: meta.modelName / target, and the driver adapter error it wraps (meta.driverAdapterError.cause)
  const meta = read(value, 'meta')
  const adapter = read(read(meta, 'driverAdapterError'), 'cause')
  const sqlState = [read(adapter, 'originalCode'), read(adapter, 'code'), read(meta, 'code')].find((c) => typeof c === 'string' && SQLSTATE.test(c) && !PRISMA_CODE.test(c))
  if (typeof sqlState === 'string') description.sqlState ??= sqlState
  const kind = identifier(read(adapter, 'kind'))
  if (kind) description.kind = kind
  const model = identifier(read(meta, 'modelName'))
  if (model) description.model = model

  const adapterConstraint = read(adapter, 'constraint')
  const constraint = identifier(read(value, 'constraint')) ?? identifier(read(adapterConstraint, 'index')) ?? identifier(read(meta, 'target'))
  if (constraint) description.constraint = constraint
  const fields = identifiers(read(adapterConstraint, 'fields')) ?? (Array.isArray(read(meta, 'target')) ? identifiers(read(meta, 'target')) : undefined)
  if (fields) description.fields = fields
  const table = identifier(read(value, 'table')) ?? identifier(read(adapter, 'table'))
  if (table) description.table = table
  const column = identifier(read(value, 'column')) ?? identifier(read(adapter, 'column'))
  if (column) description.column = column

  const frames = framesOf(value)
  if (frames) description.frames = frames

  if (depth < MAX_DEPTH) {
    const cause = read(value, 'cause')
    if (cause !== undefined && cause !== null && !seen.has(cause)) description.cause = describeValue(cause, depth + 1, seen)
    const inner = read(value, 'errors')
    if (Array.isArray(inner) && inner.length > 0) description.errors = inner.slice(0, MAX_INNER_ERRORS).map((e) => describeValue(e, depth + 1, seen))
  }
  return description
}

/** A description of anything thrown, safe to log: never its message, detail or argument values. Never throws. */
export function describeError(error: unknown): ErrorDescription {
  try {
    return describeValue(error, 0, new Set())
  } catch {
    return { type: 'Error' }
  }
}
