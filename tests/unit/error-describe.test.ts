import { DatabaseError } from 'pg'
import { describe, expect, it } from 'vitest'
import { Prisma } from '@/server/db/generated/client'
import { describeError } from '@/server/errors/describe'

// FR-PLT-008 AC3: an unexpected error reaches the error collector (the log) with its codes and where it happened,
// never with its message: Prisma quotes the call with every argument, Postgres quotes the offending input.
const PLANTED = ['somchai@example.com', 'สมชาย ใจดี', '0812345678', 'not-a-uuid']
const leaks = (value: unknown) => PLANTED.filter((p) => JSON.stringify(value).includes(p))

describe('[FR-PLT-008/AC3] describeError keeps codes and identifiers, never error text', () => {
  it('describes a Prisma request error by its codes, model and constraint', () => {
    const message = `Invalid \`tx.member.findMany()\` invocation\n→ 14 await tx.member.findMany(\nInvalid input value: invalid input syntax for type uuid: "${PLANTED.join(' ')}"`
    const error = new Prisma.PrismaClientKnownRequestError(message, {
      code: 'P2007',
      clientVersion: '7.10.0',
      meta: {
        modelName: 'Member',
        driverAdapterError: Object.assign(new Error(message), {
          name: 'DriverAdapterError',
          cause: { originalCode: '22P02', originalMessage: message, kind: 'InvalidInputValue', message },
        }),
      },
    })
    const described = describeError(error)
    expect(described).toMatchObject({ type: 'PrismaClientKnownRequestError', code: 'P2007', sqlState: '22P02', kind: 'InvalidInputValue', model: 'Member' })
    expect(leaks(described)).toEqual([])
    expect(described.frames?.length).toBeGreaterThan(0)
    expect(described.frames?.every((frame) => /^at /.test(frame))).toBe(true)

    const unique = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '7.10.0',
      meta: {
        modelName: 'Member',
        driverAdapterError: { cause: { originalCode: '23505', kind: 'UniqueConstraintViolation', constraint: { index: 'Member_organizationId_email_key' }, table: 'Member' } },
      },
    })
    expect(describeError(unique)).toMatchObject({ code: 'P2002', sqlState: '23505', constraint: 'Member_organizationId_email_key', table: 'Member', model: 'Member' })
    const fields = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '7.10.0',
      meta: { target: ['organizationId', 'email'], driverAdapterError: { cause: { constraint: { fields: ['organizationId', 'email'] } } } },
    })
    expect(describeError(fields)).toMatchObject({ fields: ['organizationId', 'email'] })
  })

  it('describes a Prisma validation error, which echoes every argument value, by its type and stack only', () => {
    const error = new Prisma.PrismaClientValidationError(
      `Invalid \`tx.member.create()\` invocation\n  data: {\n    email: "${PLANTED[0]}",\n    displayNameTh: "${PLANTED[1]}",\n    phone: "${PLANTED[2]}"\n  }\nInvalid value for argument \`status\``,
      { clientVersion: '7.10.0' },
    )
    const described = describeError(error)
    expect(described.type).toBe('PrismaClientValidationError')
    expect(described).not.toHaveProperty('message')
    expect(leaks(described)).toEqual([])
  })

  it('describes a Postgres driver error by SQLSTATE and names, never its detail', () => {
    const error = new DatabaseError('duplicate key value violates unique constraint "Member_email_key"', 100, 'error')
    Object.assign(error, { code: '23505', constraint: 'Member_email_key', table: 'Member', column: 'email', detail: `Key (email)=(${PLANTED[0]}) already exists.`, severity: 'ERROR' })
    const described = describeError(new Error(`wrapped: ${PLANTED[0]}`, { cause: error }))
    expect(described).toMatchObject({ type: 'Error', cause: { type: 'DatabaseError', sqlState: '23505', constraint: 'Member_email_key', table: 'Member', column: 'email' } })
    expect(leaks(described)).toEqual([])
  })

  it('keeps only real stack frames: a message line made to look like a frame is dropped', () => {
    const error = new Error(`boom\n    at ${PLANTED[0]} (${PLANTED[1]})\n    at fake (/x/${PLANTED[2]}.ts:1:2)`)
    const described = describeError(error)
    expect(described.frames?.length).toBeGreaterThan(0)
    expect(leaks(described)).toEqual([])
  })

  it('describes anything thrown, never its content, and never throws itself', () => {
    expect(describeError({ secret: 'pw=hunter2', email: PLANTED[0] })).toEqual({ type: 'Object' })
    expect(describeError(PLANTED[0])).toEqual({ type: 'string' })
    expect(describeError(undefined)).toEqual({ type: 'undefined' })
    const renamed = Object.assign(new TypeError('x'), { name: PLANTED[0] })
    expect(describeError(renamed).type).toBe('TypeError')
    const hostile = new Proxy(new Error('x'), {
      get() {
        throw new Error('no reading')
      },
    })
    expect(() => describeError(hostile)).not.toThrow()
    const cyclic: Error & { cause?: unknown } = new Error('loop')
    cyclic.cause = cyclic
    expect(JSON.stringify(describeError(cyclic)).length).toBeLessThan(10_000)
  })
})
