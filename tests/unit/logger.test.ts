import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { REDACTED, createLogger, redactDeep, scrubText } from '@/lib/logger'

// NFR-SEC-09: logs must never contain passwords, PINs, tokens, secrets, full bank account numbers or national
// ID numbers. Every secret below is planted somewhere a careless log call could put it.
function capture() {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(chunk.toString())
      done()
    },
  })
  return { logger: createLogger(stream, 'trace'), output: () => lines.join('') }
}

const SECRETS = {
  password: 'Sup3rS3cret!pass',
  pin: '482913',
  sessionToken: 'sess_9f8e7d6c5b4a3210',
  channelSecret: 'chsec_abcdef0123456789',
  bankAccount: '1234567890',
  nationalId: '1101700203451',
  actionSecret: 'Zx9QmA7LkP2wR5tY',
  bearer: 'eyJhbGciOiJIUzI1NiJ9.payload.sig',
}

describe('[NFR-SEC-09] logger redaction', () => {
  it('redacts sensitive keys at any depth', () => {
    const { logger, output } = capture()
    logger.info(
      {
        user: { email: 'a@demo.bcs.local', password: SECRETS.password, profile: { pin: SECRETS.pin } },
        auth: { token: SECRETS.sessionToken, nested: [{ channelSecret: SECRETS.channelSecret }] },
        payee: { bankAccountNumber: SECRETS.bankAccount, nationalId: SECRETS.nationalId },
        headers: { authorization: `Bearer ${SECRETS.bearer}`, cookie: 'better-auth.session_token=abc' },
      },
      'member updated',
    )
    const out = output()
    for (const value of Object.values(SECRETS)) expect(out).not.toContain(value)
    // FR-PLT-008 AC3: the e-mail address keeps its domain only
    expect(out).toContain(`"email":"${REDACTED}@demo.bcs.local"`)
    expect(out).toContain('member updated')
  })

  it('scrubs secrets inside free text, messages and errors', () => {
    const { logger, output } = capture()
    logger.warn(`opened /a/0193f1a2-7c00-7000-8000-000000000001.${SECRETS.actionSecret} with account ${SECRETS.bankAccount}`)
    logger.error({ err: new Error(`bad citizen id ${SECRETS.nationalId} token=${SECRETS.sessionToken}`) }, 'failed')
    logger.info({ url: `https://x.example.com/cb?code=abc&token=${SECRETS.sessionToken}`, note: `Bearer ${SECRETS.bearer}` })
    const out = output()
    for (const value of [SECRETS.actionSecret, SECRETS.bankAccount, SECRETS.nationalId, SECRETS.sessionToken, SECRETS.bearer]) {
      expect(out).not.toContain(value)
    }
  })

  it('logs BigInt money and child bindings without throwing', () => {
    const { logger, output } = capture()
    logger.child({ requestId: 'req-1', organizationId: 'org-1' }).info({ amountSatang: 4494000n }, 'reserved')
    const line = JSON.parse(output().trim()) as Record<string, unknown>
    expect(line).toMatchObject({ requestId: 'req-1', organizationId: 'org-1', amountSatang: '4494000', msg: 'reserved' })
  })

  it('leaves ordinary text alone', () => {
    expect(scrubText('PR-2569-00001 approved by VP for 45,000.00 baht')).toBe('PR-2569-00001 approved by VP for 45,000.00 baht')
  })
})

const lines = (out: string) => out.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
const expectAbsent = (out: string, secrets: string[]) => {
  for (const s of secrets) expect(out, `leaked ${s}`).not.toContain(s)
}

// Verbatim PrismaClientValidationError text from Prisma 7.10 (only the file path is shortened). Prisma echoes the
// argument tree with its values and the caller's source lines, so this is what runCommand's log.error({ err }) sees.
const PRISMA_VALIDATION_ERROR = [
  '',
  'Invalid `prisma.member.update()` invocation in',
  '/app/src/server/services/members/index.ts:7:23',
  '',
  '  4 ',
  "  5 const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: 'postgresql://nobody:nopass_LEAK@127.0.0.1:1/none' }) })",
  '  6 try {',
  '→ 7   await prisma.member.update({',
  '        where: {',
  '          id: "00000000-0000-7000-8000-000000000000"',
  '        },',
  '        data: {',
  '          transactionPinHash: "$argon2id$v=19$m=65536$PINHASHSECRET",',
  '          pinFaildCount: 0,',
  '          ~~~~~~~~~~~~~',
  '      ?   id?: String | StringFieldUpdateOperationsInput,',
  '      ?   pinFailedCount?: Int | IntFieldUpdateOperationsInput,',
  '      ?   pinLockedUntil?: DateTime | NullableDateTimeFieldUpdateOperationsInput | Null,',
  '        }',
  '      })',
  '',
  'Unknown argument `pinFaildCount`. Did you mean `pinFailedCount`? Available options are marked with ?.',
].join('\n')

describe('[NFR-SEC-09][FR-PLT-008/AC2] every pino call shape is redacted', () => {
  it('redacts child() bindings, nested children and setBindings', () => {
    const { logger, output } = capture()
    const child = logger.child({
      requestId: 'req-7',
      password: 'hunter2-child',
      authorization: 'Bearer abc.def.ghi',
      lineAccessToken: 'tok_LEAK_child_binding',
    })
    child.info('login')
    child.child({ correlationId: 'corr-7', session: { token: 'sess_LEAK_grandchild' } }).warn('nested')
    child.setBindings({ apiKey: 'sk-ant-api03-LEAK-setbindings' })
    child.info('rebound')
    const out = output()
    expectAbsent(out, ['hunter2-child', 'abc.def.ghi', 'tok_LEAK_child_binding', 'sess_LEAK_grandchild', 'sk-ant-api03-LEAK-setbindings'])
    const [login, nested] = lines(out)
    expect(login).toMatchObject({ requestId: 'req-7', password: REDACTED, authorization: REDACTED, msg: 'login' })
    expect(nested).toMatchObject({ requestId: 'req-7', correlationId: 'corr-7', msg: 'nested' })
  })

  it('scrubs the message pino copies out of an Error logged directly or under err without a message', () => {
    const { logger, output } = capture()
    logger.error(new Error(`refresh failed: token=tok_LEAK_msg_copy for citizen ${SECRETS.nationalId}`))
    logger.error({ err: new Error('LINE push failed: password=pw_LEAK_err_only') })
    const out = output()
    expectAbsent(out, ['tok_LEAK_msg_copy', SECRETS.nationalId, 'pw_LEAK_err_only'])
    const [direct, nested] = lines(out)
    expect(direct?.msg).toContain('refresh failed')
    expect(direct?.err).toMatchObject({ type: 'Error' })
    expect(nested?.msg).toContain('LINE push failed')
  })

  it('redacts values interpolated with %j %o %O %s and %d', () => {
    const { logger, output } = capture()
    logger.info('command input %j', { pin: '482913', password: 'P@ssw0rd-interp' })
    logger.info({ requestId: 'req-9' }, 'body %o then %O', { access_token: 'tok_LEAK_o' }, { nested: { clientSecret: 'cs_LEAK_O' } })
    logger.info('payee %s account %d', 'refund to 123-456789-0', 1234567890)
    const out = output()
    expectAbsent(out, ['482913', 'P@ssw0rd-interp', 'tok_LEAK_o', 'cs_LEAK_O', '123-456789-0', '1234567890'])
    const [first, second, third] = lines(out)
    expect(first?.msg).toContain('command input')
    expect(second).toMatchObject({ requestId: 'req-9' })
    expect(third?.msg).toContain('payee refund to')
  })

  it('never shifts a printf placeholder onto another argument while scrubbing', () => {
    const { logger, output } = capture()
    logger.info('token=%s for %s', 'tok_LEAK_shift', 'user-7')
    const out = output()
    expectAbsent(out, ['tok_LEAK_shift'])
    expect(lines(out)[0]?.msg).toBe(`token=${REDACTED} for user-7`)
  })

  it('keeps redacting when a child logger brings its own serializers, formatters or message prefix', () => {
    const { logger, output } = capture()
    const child = logger.child(
      { requestId: 'req-3' },
      {
        msgPrefix: 'token=tok_LEAK_prefix ',
        serializers: { err: (e: unknown) => ({ message: (e as Error).message }), msg: (m: unknown) => m },
        formatters: { log: (o: object) => ({ ...o }), bindings: (b) => ({ ...b, otp: '135790' }) },
      },
    )
    child.error({ err: new Error('password=pw_LEAK_child_err'), apiKey: 'sk-LEAK-child-obj' }, 'failed')
    const out = output()
    expectAbsent(out, ['tok_LEAK_prefix', 'pw_LEAK_child_err', 'sk-LEAK-child-obj', '135790'])
    expect(lines(out)[0]).toMatchObject({ requestId: 'req-3' })
  })
})

describe('[NFR-SEC-09] secrets inside text are redacted', () => {
  it('redacts secrets inside JSON text held in an ordinary string value', () => {
    const { logger, output } = capture()
    logger.warn(
      { status: 400, body: '{"access_token":"ya29.A0SECRETTOKEN","refresh_token":"1//0gREFRESHSECRET","expires_in":3599}' },
      'token exchange failed',
    )
    logger.warn({ webhook: JSON.stringify({ events: [{ payload: JSON.stringify({ client_secret: 'cs_LEAK_double', user: 'U1' }) }] }) }, 'double-encoded')
    logger.error({ err: new Error('LINE push failed: {"to":"U1","token":"tok_LEAK_json"}') }, 'json in error message')
    const out = output()
    expectAbsent(out, ['ya29.A0SECRETTOKEN', '1//0gREFRESHSECRET', 'cs_LEAK_double', 'tok_LEAK_json'])
    expect(out).toContain('expires_in')
  })

  it('redacts secrets right after an escaped newline in JSON-encoded text', () => {
    const body = JSON.stringify({
      error: 'bad request\npassword=pw_LEAK_after_newline',
      detail: 'citizen\n1101700203451',
      dsn: 'retry\npostgresql://bcs_app:pw_LEAK_url@db.example.com/bcs',
    })
    const scrubbed = scrubText(body)
    for (const secret of ['pw_LEAK_after_newline', '1101700203451', 'pw_LEAK_url']) expect(scrubbed).not.toContain(secret)
    expect(scrubbed).toContain(`password=${REDACTED}`)
    expect(scrubbed).toContain(`postgresql://bcs_app:${REDACTED}@db.example.com/bcs`)
  })

  it('redacts quoted and unquoted key/value pairs, keeping the quotes and the key', () => {
    expect(scrubText('{"password":"hunter2","otp":"123456"}')).toBe('{"password":"[REDACTED]","otp":"[REDACTED]"}')
    expect(scrubText('{ data: { password: "pw_LEAK_quoted", pin: "482913" } }')).toBe('{ data: { password: "[REDACTED]", pin: "[REDACTED]" } }')
    expect(scrubText("{'client_secret': 'it\\'s secret', 'user': 'u1'}")).toBe("{'client_secret': '[REDACTED]', 'user': 'u1'}")
    expect(scrubText('token = "a b c" for x')).toBe('token = "[REDACTED]" for x')
    expect(scrubText('{\\"refresh_token\\":\\"rt_LEAK\\"}')).toBe('{\\"refresh_token\\":\\"[REDACTED]\\"}')
    expect(scrubText('newPin=482913&next=/me')).toBe('newPin=[REDACTED]&next=/me')
    expect(scrubText('data: { password: { set: "pw_LEAK_nested" }, name: "x" }')).toBe('data: { password: [REDACTED], name: "x" }')
    expect(scrubText('backupCodes: ["bc_LEAK_1", "bc_LEAK_2"]')).toBe('backupCodes: [REDACTED]')
    expect(scrubText('note: password=hunter3')).toBe('note: password=[REDACTED]')
    expect(scrubText('authorization: Token tk_LEAK_scheme')).toBe('authorization: [REDACTED]')
    expect(scrubText('your PIN 482913 was changed')).toBe('your PIN [REDACTED] was changed')
  })

  it('redacts column values echoed by a Prisma validation error, keeping the useful part', () => {
    const { logger, output } = capture()
    const err = Object.assign(new Error(PRISMA_VALIDATION_ERROR), { name: 'PrismaClientValidationError' })
    logger.error({ err }, 'command failed unexpectedly')
    logger.error(err)
    const out = output()
    expectAbsent(out, ['PINHASHSECRET', 'argon2id', 'nopass_LEAK'])
    expect(out).toContain('Unknown argument `pinFaildCount`')
    expect(out).toContain('00000000-0000-7000-8000-000000000000')
  })

  it('removes credentials from connection URLs and one-time links', () => {
    const { logger, output } = capture()
    logger.error(
      { smtp: 'smtps://resend:re_SMTPSECRET@smtp.resend.com:465', db: 'postgresql://bcs_app:pa@ss_LEAK@db.example.com:5432/bcs' },
      'reset mail https://bcs.example/api/auth/reset-password/RESETTOKEN123abc?callbackURL=%2F failed',
    )
    logger.warn({ link: 'https://bcs.example/invite/Zx9QmA7LkP2wR5tY_inviteTOKEN' }, 'invitation e-mail could not be sent')
    const out = output()
    expectAbsent(out, ['re_SMTPSECRET', 'ss_LEAK', 'RESETTOKEN123abc', 'inviteTOKEN'])
    expect(out).toContain('smtps://resend:[REDACTED]@smtp.resend.com:465')
    expect(out).toContain('postgresql://bcs_app:[REDACTED]@db.example.com:5432/bcs')
    expect(out).toContain('callbackURL=%2F')
  })

  it('redacts the PIN-change proof and the LINE link code wherever they appear in text', () => {
    const proof = `p1.PASSWORD.1791100800000.${'Ab_-'.repeat(5)}Cd.${'Ef9_'.repeat(10)}Gh-`
    const code = `l1.${'Or9-'.repeat(5)}gA.${'Me7_'.repeat(5)}bQ.1791100800000.${'No5-'.repeat(5)}cE.${'Mac8'.repeat(10)}x_Z`
    const { logger, output } = capture()
    logger.warn(`set_pin refused for proof ${proof} (EXPIRED)`)
    logger.info({ note: `link ${code} used twice` }, 'line link')
    const out = output()
    expectAbsent(out, [proof, code, proof.slice(-43), code.slice(-43)])
    expect(scrubText(`proof ${proof}.`)).toBe(`proof ${REDACTED}.`)
    expect(scrubText(`code=${code}`)).toBe(`code=${REDACTED}`)
    // a document number or a version string that starts the same way stays
    expect(scrubText('p1.PASSWORD changed · l1.2 of the spec')).toBe('p1.PASSWORD changed · l1.2 of the spec')
  })

  it('redacts national IDs and bank accounts in their printed formats', () => {
    for (const value of ['1-1017-00203-45-1', '1 1017 00203 45 1', '123-456789-0', '123-4-56789-0', '1234-567-890', '123 4 56789 0', '4111 1111 1111 1111', '4111111111111111']) {
      expect(scrubText(`supplier ${value} failed mod-11`), value).toBe('supplier [REDACTED] failed mod-11')
    }
    expect(scrubText('ref-1-1017-00203-45-1 / acct_123-4-56789-0')).toBe(`ref-${REDACTED} / acct_${REDACTED}`)
    // glued to letters, as typed into a note: still redacted, unlike a digit run inside a hex identifier
    expect(scrubText('note TAXID0105556012345 and ID1101700203451')).toBe(`note TAXID${REDACTED} and ID${REDACTED}`)
    const { logger, output } = capture()
    logger.info({ supplier: { taxIdFormatted: '1-1017-00203-45-1' }, importedRow: { col3: 1101700203451 } }, 'refund to 123-456789-0')
    const out = output()
    expectAbsent(out, ['00203', '1101700203451', '456789'])
  })

  it('treats every PIN field as secret without touching look-alike keys', () => {
    const { logger, output } = capture()
    logger.info(
      {
        input: { currentPin: '135790', newPin: '482913', confirmPin: '482914', transactionPINHash: 'h_LEAK', pin_code: '246810', PIN: '975310', pins: ['111222'] },
        shipping: 'EMS',
        mapping: 'dept->cc',
        pinned: true,
        spinner: 'dots',
        footprint: 'small',
        pinFailedCount: 2,
        pinLockedUntil: '2026-10-02T10:00:00.000Z',
      },
      'change pin',
    )
    const out = output()
    expectAbsent(out, ['135790', '482913', '482914', 'h_LEAK', '246810', '975310', '111222'])
    expect(lines(out)[0]).toMatchObject({
      shipping: 'EMS',
      mapping: 'dept->cc',
      pinned: true,
      spinner: 'dots',
      footprint: 'small',
      pinFailedCount: 2,
      pinLockedUntil: '2026-10-02T10:00:00.000Z',
    })
  })

  it('redacts API keys under dashed, underscored and header-style names', () => {
    const { logger, output } = capture()
    logger.info(
      {
        headers: { 'x-api-key': 'sk-ant-api03-SECRETKEY', 'X-Line-Signature': 'sig_LEAK', 'Proxy-Authorization': 'Basic dXNlcjpwYXNz' },
        api_key: 'sk-ant-api03-SECRETKEY2',
        ENCRYPTION_KEY: 'enc_LEAK',
        INNGEST_SIGNING_KEY: 'signkey_LEAK',
        idempotencyKey: 'idem-1',
      },
      'ai call',
    )
    const out = output()
    expectAbsent(out, ['sk-ant-api03-SECRETKEY', 'sig_LEAK', 'dXNlcjpwYXNz', 'enc_LEAK', 'signkey_LEAK'])
    expect(lines(out)[0]).toMatchObject({ idempotencyKey: 'idem-1' })
  })
})

describe('[NFR-SEC-09] redaction keeps logs useful and never breaks a log call', () => {
  it('leaves ids, document numbers, dates and amounts readable', () => {
    const text =
      'member 00000000-0000-7000-8000-000000000001 org 0193f1a2-7c00-7000-8000-123456789012 approved PR-2569-00001, ' +
      'PO-257001-0012 and GR-CON-69-1000 at 2026-10-02T03:10:41.123Z (db 2026-10-02 03:10:41.123+00) for 45,000.00 baht, ' +
      'pnpm@12.8.1 and @prisma/client@7.10.0, see https://bcs.example/pr/0193f1a2-7c00-7000-8000-123456789012?tab=history, ' +
      'LINE user U1101700203451aabbccddeeff001122, total 1234567890.50 baht'
    expect(scrubText(text)).toBe(text)
    const { logger, output } = capture()
    logger.info({ amountSatang: 4494000000000n, seq: 12345678901n, attempts: 3, sizeBytes: 20971520, durationMs: 12.3456789012345 }, 'reserved')
    expect(lines(output())[0]).toMatchObject({
      amountSatang: '4494000000000',
      seq: '12345678901',
      attempts: 3,
      sizeBytes: 20971520,
      durationMs: 12.3456789012345,
    })
  })

  it('scrubs hostile text in linear time', () => {
    const n = 200_000
    const hostile = [
      '\\'.repeat(n),
      'a.'.repeat(n / 2),
      `${'A'.repeat(n)}: x`,
      `x://u:${'@a'.repeat(n / 2)}`,
      `${'1-'.repeat(n / 2)}a`,
      `pin${' '.repeat(n)}x`,
      `password: "${'\\"'.repeat(n / 2)}`,
      `password: ${'['.repeat(n)}`,
      'token=a&'.repeat(n / 8),
      '1234567890a'.repeat(n / 11),
      `${'a'.repeat(n)}z`,
    ]
    const started = performance.now()
    for (const text of hostile) scrubText(text)
    expect(redactDeep({ [`${'A'.repeat(n)}b`]: 1 })).toBeTruthy()
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('never throws on values that cannot be serialized', () => {
    const { logger, output } = capture()
    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular
    const hostile = Object.defineProperty({}, 'boom', { enumerable: true, get: () => { throw new Error('getter exploded') } })
    expect(() => logger.info({ at: new Date('not a date'), circular, hostile, decimal: { toJSON: () => '12.50' } }, 'odd values')).not.toThrow()
    expect(() => logger.child({ when: new Date('nope') }).info('odd binding')).not.toThrow()
    // pino itself reads err.message to fill msg: a throwing getter there must not turn the log call into a crash
    const exploding = Object.defineProperty(new Error('x'), 'message', { get: () => { throw new Error('getter exploded') } })
    expect(() => logger.error({ err: exploding })).not.toThrow()
    const [row, , fallback] = lines(output())
    expect(row).toMatchObject({ circular: { name: 'loop', self: '[Circular]' }, decimal: '12.50', msg: 'odd values' })
    expect(fallback).toMatchObject({ level: 50, logError: 'the log arguments could not be serialized' })
  })

  it('redactDeep and scrubText keep their call shapes', () => {
    expect(redactDeep({ password: 'x', note: 'token=abc', n: 5n })).toEqual({ password: REDACTED, note: `token=${REDACTED}`, n: '5' })
    expect(redactDeep('Bearer abc.def', 0)).toBe(`Bearer ${REDACTED}`)
    expect(scrubText('')).toBe('')
  })
})

describe('[NFR-SEC-09] keys inside text are classified by their own name', () => {
  it('redacts every cookie of a Cookie or Set-Cookie header, also when the session cookie is not the first', () => {
    // Production cookie names: cookiePrefix 'bcs' + useSecureCookies (https) => __Secure-bcs.session_token
    const session = 'SESS_LEAK_9f8e7d6c5b4a.sigXYZ'
    const setCookie = `__Secure-bcs.session_token=${session}; Path=/; HttpOnly; Secure; SameSite=Lax`
    const { logger, output } = capture()
    logger.warn(`auth failed for request with cookie: __Secure-bcs.dont_remember=true; __Secure-bcs.session_token=${session}`)
    logger.error({ err: new Error(`upstream rejected cookie=bcs.theme=dark; __Secure-bcs.session_token=${session}`) }, 'upstream failed')
    logger.info({ headers: [...new Headers({ 'set-cookie': setCookie, 'content-type': 'text/plain' })] }, 'auth response')
    logger.info({ received: new Headers({ 'set-cookie': setCookie }).getSetCookie(), note: `upstream header: ${setCookie}` }, 'unlabelled')
    const out = output()
    expectAbsent(out, [session, 'SESS_LEAK'])
    const [message, upstream, entries, unlabelled] = lines(out)
    expect(message?.msg).toBe(`auth failed for request with cookie: __Secure-bcs.dont_remember=${REDACTED}; __Secure-bcs.session_token=${REDACTED}`)
    expect(upstream?.err).toMatchObject({ message: `upstream rejected cookie=bcs.theme=${REDACTED}; __Secure-bcs.session_token=${REDACTED}` })
    expect(entries?.headers).toEqual([['content-type', 'text/plain'], ['set-cookie', REDACTED]])
    const kept = `__Secure-bcs.session_token=${REDACTED}; Path=/; HttpOnly; Secure; SameSite=Lax`
    expect(unlabelled).toMatchObject({ received: [kept], note: `upstream header: ${kept}` })
  })

  it('classifies a key that starts with _ or - or runs past 64 characters by its whole name', () => {
    expect(scrubText('form _token=tok_LEAK_us&x=1')).toBe(`form _token=${REDACTED}&x=1`)
    expect(scrubText('{"_token":"tok_LEAK_json","__Host-csrf":"csrf_LEAK","_id":"r1"}')).toBe(`{"_token":"${REDACTED}","__Host-csrf":"${REDACTED}","_id":"r1"}`)
    expect(scrubText('JSON line\\n_token=tok_LEAK_escaped')).toBe(`JSON line\\n_token=${REDACTED}`)
    expect(scrubText(`${'x'.repeat(60)}_password=pw_LEAK_longkey next`)).toBe(`${'x'.repeat(60)}_password=${REDACTED} next`)
  })

  it('redacts the values of secret-named command-line flags and keeps the other flags readable', () => {
    expect(scrubText('pg_dump --host=db --username=bcs --password=pgPW_LEAK bcs')).toBe(`pg_dump --host=db --username=bcs --password=${REDACTED} bcs`)
    expect(scrubText('exec: claude --api-key=sk_LEAK_cli --model claude-x')).toBe(`exec: claude --api-key=${REDACTED} --model claude-x`)
    expect(scrubText('mysql --password pw_LEAK_space --host db -key k_LEAK_single --idempotency-key idem-1')).toBe(
      `mysql --password ${REDACTED} --host db -key ${REDACTED} --idempotency-key idem-1`,
    )
    const { logger, output } = capture()
    logger.info({ argv: ['node', 'seed.ts', '--token=tok_LEAK_argv', '--secret', 'sec_LEAK_argv', '--org', 'demo', '--auth', '--verbose'] }, 'seed')
    const out = output()
    expectAbsent(out, ['tok_LEAK_argv', 'sec_LEAK_argv'])
    expect(lines(out)[0]?.argv).toEqual(['node', 'seed.ts', `--token=${REDACTED}`, '--secret', REDACTED, '--org', 'demo', '--auth', '--verbose'])
  })

  it('redacts PINs, OTPs, passwords and keys written as labels in English or Thai prose', () => {
    expect(scrubText('PIN code: 482917')).toBe(`PIN code: ${REDACTED}`)
    expect(scrubText('รหัส OTP ของคุณคือ 135794 (อ้างอิง AB12)')).toBe(`รหัส OTP ของคุณคือ ${REDACTED} (อ้างอิง AB12)`)
    expect(scrubText('PIN ใหม่: 482918')).toBe(`PIN ใหม่: ${REDACTED}`)
    expect(scrubText('รหัสผ่าน: pw_LEAK_thai')).toBe(`รหัสผ่าน: ${REDACTED}`)
    expect(scrubText('Invalid API Key: sk_LEAK_spacedkey')).toBe(`Invalid API Key: ${REDACTED}`)
    expect(scrubText('Session ID: s_LEAK_label')).toBe(`Session ID: ${REDACTED}`)
    expect(scrubText('token: abc,def_LEAK_comma')).toBe(`token: ${REDACTED}`)
    for (const text of ['PIN locked until 2026-10-02T10:00:00Z', 'OTP sent at 2026-10-02 10:00', 'รหัสผ่านไม่ถูกต้อง', 'Promo Code: SAVE10', 'Postal Code: 10110']) {
      expect(scrubText(text), text).toBe(text)
    }
    // the word before a label is a word of prose, never the value of the pair before it
    expect(scrubText('POST https://inn.gs/x?token=abc123secret failed: password=hunter2')).toBe(
      `POST https://inn.gs/x?token=${REDACTED} failed: password=${REDACTED}`,
    )
  })

  it('redacts secrets in XML elements, array parameters, header values with & and short or Thai key names', () => {
    expect(scrubText('<password>T7_LEAK</password><user>u1</user>')).toBe(`<password>${REDACTED}</password><user>u1</user>`)
    expect(scrubText('token[]=T25_LEAK&ids[]=3')).toBe(`token[]=${REDACTED}&ids[]=3`)
    expect(scrubText('x-inngest-signature: t=1&s=T14_LEAK')).toBe(`x-inngest-signature: ${REDACTED}`)
    expect(scrubText('{"pw":"T3_LEAK"}')).toBe(`{"pw":"${REDACTED}"}`)
    expect(redactDeep({ pw: 'K4', รหัสผ่าน: 'K38', เลขบัตรประชาชน: 'K39', เลขบัญชี: 'K40', ชื่อ: 'สมชาย' })).toEqual({
      pw: REDACTED,
      รหัสผ่าน: REDACTED,
      เลขบัตรประชาชน: REDACTED,
      เลขบัญชี: REDACTED,
      ชื่อ: 'สมชาย',
    })
  })

  it('redacts secrets in percent-encoded query strings and announced temporary passwords', () => {
    expect(scrubText('redirect next=%2Freset-password%3Ftoken%3Dtok_LEAK_pct%26lang%3Dth')).toBe(`redirect next=%2Freset-password%3Ftoken%3D${REDACTED}%26lang%3Dth`)
    expect(scrubText('temporary password is pw_LEAK_prose')).toBe(`temporary password is ${REDACTED}`)
    for (const text of ['password is required', 'new password is too short', 'default password is not set', 'token is expired']) {
      expect(scrubText(text), text).toBe(text)
    }
  })

  it('redacts event keys in Inngest URLs, tokens used as a URL user name and secrets in deeply escaped JSON', () => {
    expect(scrubText('POST https://inn.gs/e/EVENTKEY_LEAK_0123456789abcdef failed')).toBe(`POST https://inn.gs/e/${REDACTED} failed`)
    expect(scrubText('clone https://ghp_LEAK_user@github.com/org/repo.git failed')).toBe(`clone https://${REDACTED}@github.com/org/repo.git failed`)
    let nested = JSON.stringify({ client_secret: 'cs_LEAK_level4', user: 'U1' })
    for (let i = 0; i < 4; i++) nested = JSON.stringify({ payload: nested })
    expect(scrubText(nested)).not.toContain('cs_LEAK_level4')
    expect(scrubText(nested)).toContain('user')
  })
})

describe('[NFR-SEC-09] key names', () => {
  it('treats lower-case, upper-case and digit-suffixed PIN, OTP and password names as secret, not their look-alikes', () => {
    const secretKeys = [
      'pincode', 'PINCODE', 'Pincode', 'pinhash', 'PINHASH', 'transactionpinhash', 'otpcode', 'OTPCODE', 'emailotp', 'EMAILOTP',
      'smsotp', 'dbpass', 'DBPASS', 'PGPASS', 'smtppass', 'userpass', 'masterpass', 'passkey', 'newpin', 'NEWPIN', 'currentpin',
      'pin1', 'pin2', 'pin_2', 'bypass', 'x-vercel-protection-bypass', 'codeVerifier', 'basicAuth', 'auth', 'sid', 'hmac', 'bearer',
    ]
    const input = Object.fromEntries(secretKeys.map((key, i) => [key, `V_LEAK_${i}x`]))
    const lookalikes = {
      shipping: 'EMS', pinned: 'top', spinner: 'dots', footprint: 'small', opinion: 'ok', compass: 'north', passenger: 'p-1',
      mapping: 'dept->cc', authProvider: 'line', bypassApproval: false,
    }
    const { logger, output } = capture()
    logger.info({ input, ...lookalikes }, 'key names')
    const out = output()
    expectAbsent(out, ['V_LEAK'])
    const [row] = lines(out)
    expect(row?.input).toEqual(Object.fromEntries(secretKeys.map((key) => [key, REDACTED])))
    expect(row).toMatchObject(lookalikes)
    expect(scrubText('pincode: 482916, PINHASH=h_LEAK_text, smtppass=s_LEAK')).toBe(`pincode: ${REDACTED}, PINHASH=${REDACTED}, smtppass=${REDACTED}`)
  })

  it('keeps counts, flags and times under names that describe a secret, and nothing else', () => {
    const { logger, output } = capture()
    logger.info(
      {
        tokenExpiresAt: 'tok_LEAK_meta',
        passwordChangedAt: 'pw_LEAK_meta',
        otpLength: 'otp_LEAK_meta',
        pinLockedUntil: { gt: 'pin_LEAK_object' },
        sessionExpiresAt: new Date('2026-10-02T10:00:00.000Z'),
        refreshTokenExpiresAt: '2026-10-03T10:00:00.000Z',
        pinFailedCount: 2,
        tokenTtl: 3600,
        twoFactorEnabled: true,
      },
      'metadata',
    )
    const out = output()
    expectAbsent(out, ['LEAK'])
    expect(lines(out)[0]).toMatchObject({
      tokenExpiresAt: REDACTED,
      passwordChangedAt: REDACTED,
      otpLength: REDACTED,
      pinLockedUntil: REDACTED,
      sessionExpiresAt: '2026-10-02T10:00:00.000Z',
      refreshTokenExpiresAt: '2026-10-03T10:00:00.000Z',
      pinFailedCount: 2,
      tokenTtl: 3600,
      twoFactorEnabled: true,
    })
    expect(scrubText('tokenExpiresAt=tok_LEAK_text "tokenExpiresAt":"2026-10-02T10:00:00.000Z" pinFailedCount: 3')).toBe(
      `tokenExpiresAt=${REDACTED} "tokenExpiresAt":"2026-10-02T10:00:00.000Z" pinFailedCount: 3`,
    )
  })

  it('redacts national IDs, account numbers and e-mail addresses used as object keys', () => {
    const { logger, output } = capture()
    logger.warn({ duplicates: { '1101700203451': 2, '123-4-56789-0': 1, 'PR-2569-00001': 3 } }, 'duplicate rows in import')
    logger.child({ ['1101700203451']: 'row 4' }).info('child binding key')
    const out = output()
    expectAbsent(out, ['1101700203451', '56789'])
    expect(lines(out)[0]?.duplicates).toEqual({ [REDACTED]: 2, [`${REDACTED} (2)`]: 1, 'PR-2569-00001': 3 })
  })
})

describe('[NFR-SEC-09] numbers inside identifiers and Thai digits', () => {
  it('redacts a national ID glued to hex letters, and a valid one even inside an identifier', () => {
    expect(scrubText('file 1101700203451abcdefabcdef.pdf')).toBe(`file ${REDACTED}abcdefabcdef.pdf`)
    const valid = '1101700203450' // passes the national ID check digit (mod 11)
    const sha256 = `deadbeef${valid}cafebabe${'f'.repeat(35)}`
    expect(scrubText(`sha256 ${sha256}`)).toBe(`sha256 deadbeef${REDACTED}cafebabe${'f'.repeat(35)}`)
    expect(scrubText(`LINE user U${valid}aabbccddeeff0011223`)).toBe(`LINE user U${REDACTED}aabbccddeeff0011223`)
    // an identifier keeps a digit run that is not a national ID
    const commit = `deadbeef1101700203451cafebabe${'0'.repeat(11)}`
    expect(scrubText(`commit ${commit}`)).toBe(`commit ${commit}`)
  })

  it('redacts an ID after a version prefix, and a valid one in a decimal, keeping ordinary decimals', () => {
    expect(scrubText('build v1.1101700203451 deployed')).toBe(`build v1.${REDACTED} deployed`)
    expect(scrubText('ratio 0.1101700203450 amount 1101700203450.25')).toBe(`ratio 0.${REDACTED} amount ${REDACTED}.25`)
    expect(scrubText('ratio 0.1234567890123 total 1234567890.50 baht')).toBe('ratio 0.1234567890123 total 1234567890.50 baht')
  })

  it('redacts national IDs and cards printed with en dashes, dots or 4-6-5 groups', () => {
    for (const value of ['1–1017–00203–45–1', '1.1017.00203.45.1', '3782 822463 10005', '3056-930902-5904']) {
      expect(scrubText(`supplier ${value} checked`), value).toBe(`supplier ${REDACTED} checked`)
    }
    expect(scrubText('version 1.2.3 at 10.0.0.12')).toBe('version 1.2.3 at 10.0.0.12')
  })

  it('redacts 12-digit accounts and 13-digit IDs written in groups of four', () => {
    expect(scrubText('refund to GSB 0200 1234 5678 today')).toBe(`refund to GSB ${REDACTED} today`)
    expect(scrubText('citizen 1101 7002 0345 1 checked')).toBe(`citizen ${REDACTED} checked`)
    // years and card-like groups that are neither stay readable
    expect(scrubText('fiscal years 2567 2568 2569 and chunk 1234 5678 9012 3456')).toBe('fiscal years 2567 2568 2569 and chunk 1234 5678 9012 3456')
  })

  it('redacts national IDs written in Thai digits and keeps other Thai numbers', () => {
    expect(scrubText('เลขบัตร ๑๑๐๑๗๐๐๒๐๓๔๕๑')).toBe(`เลขบัตร ${REDACTED}`)
    expect(scrubText('เลขบัตร ๑-๑๐๑๗-๐๐๒๐๓-๔๕-๑ ตรวจแล้ว')).toBe(`เลขบัตร ${REDACTED} ตรวจแล้ว`)
    expect(scrubText('วันที่ ๒ ตุลาคม ๒๕๖๙ เวลา ๑๐:๐๐ น.')).toBe('วันที่ ๒ ตุลาคม ๒๕๖๙ เวลา ๑๐:๐๐ น.')
  })
})

describe('[FR-PLT-008/AC3][NFR-SEC-09] personal data', () => {
  it('keeps only the domain of an e-mail address', () => {
    expect(scrubText('password reset requested for somchai@example.com')).toBe(`password reset requested for ${REDACTED}@example.com`)
    expect(scrubText('Key (email)=(somchai.j+bcs@example.co.th) already exists.')).toBe(`Key (email)=(${REDACTED}@example.co.th) already exists.`)
    expect(scrubText('{"to":"somchai@example.com","cc":["somsri_k@demo.bcs.local"]}')).toBe(`{"to":"${REDACTED}@example.com","cc":["${REDACTED}@demo.bcs.local"]}`)
    expect(scrubText('mailto:somchai@example.com?subject=x email=somsri%40example.com')).toBe(`mailto:${REDACTED}@example.com?subject=x email=${REDACTED}%40example.com`)
    expect(scrubText('JSON line\\nsomchai@example.com')).toBe(`JSON line\\n${REDACTED}@example.com`)
    // package versions and scoped packages in stack paths are not e-mail addresses
    const stack = 'at f (/app/node_modules/.pnpm/@prisma+client@7.10.0_x/node_modules/@prisma/client/index.js:1:2) pnpm@12.8.1'
    expect(scrubText(stack)).toBe(stack)
    const { logger, output } = capture()
    logger.info({ member: { email: 'somchai@example.com' }, invites: { 'somsri@example.com': 'sent' } }, 'invited somchai@example.com')
    logger.error({ err: new Error('Unique constraint failed: Key (email)=(somsri@example.com)') }, 'duplicate member')
    const out = output()
    expectAbsent(out, ['somchai', 'somsri'])
    expect(lines(out)[0]).toMatchObject({
      member: { email: `${REDACTED}@example.com` },
      invites: { [`${REDACTED}@example.com`]: 'sent' },
      msg: `invited ${REDACTED}@example.com`,
    })
  })
})

describe('[NFR-SEC-09] redaction stays linear', () => {
  it('scrubs hostile cookies, flags, key names, e-mail shapes, identifiers and Thai digits in linear time', () => {
    const n = 200_000
    const hostile = [
      `cookie: ${'a=b; '.repeat(n / 5)}`,
      `set-cookie: a=b${'; Expires=Wed, 21 Oct'.repeat(n / 21)}`,
      `${'_'.repeat(n)}a=x`,
      `${'-'.repeat(n)}a x`,
      ' --a'.repeat(n / 4),
      ' --password x'.repeat(n / 13),
      'a@'.repeat(n / 2),
      `${'a.'.repeat(n / 2)}@example.com`,
      `x@${'a.'.repeat(n / 2)}com`,
      '@a.'.repeat(n / 3),
      `${'1'.repeat(13)}a`.repeat(n / 14),
      `U${'1'.repeat(n)}`,
      `${'f'.repeat(n)}g`,
      '๑ '.repeat(n / 2),
      `pin${'x'.repeat(39)}`.repeat(n / 42),
      `PIN${' ใหม่'.repeat(n / 5)}`,
      `รหัสผ่าน${' '.repeat(n)}`,
      'Key: '.repeat(n / 5),
      'a Key: '.repeat(n / 7),
      `${'pin'.repeat(n / 3)}: x`,
      `token: ${'a,'.repeat(n / 2)}`,
      '%26token%3Dx'.repeat(n / 12),
      `%3F${'a'.repeat(n)}%3D`,
      `%3Ftoken%3D${'%2'.repeat(n / 3)}`,
      `temporary password is${' '.repeat(n)}`,
      '0200 '.repeat(n / 5),
      '1101 7002 '.repeat(n / 10),
      '<a>'.repeat(n / 3),
      `<password>${'x'.repeat(n)}</passwor`,
      `${'</a'.repeat(n / 3)}>`,
      `token${'[]'.repeat(n / 2)}=x`,
      `token[${'a'.repeat(n)}`,
      `x-signature: ${'a&'.repeat(n / 2)}`,
      `${'1.'.repeat(n / 2)}1`,
      `${'1'.repeat(n)}.${'1'.repeat(13)}`,
      '1–'.repeat(n / 2),
    ]
    const started = performance.now()
    for (const text of hostile) scrubText(text)
    const entries = Array.from({ length: n / 10 }, (_, i) => [`key${i}`, 'value'])
    redactDeep({ entries, argv: Array.from({ length: n / 10 }, () => '--token'), byKey: Object.fromEntries(entries) })
    expect(performance.now() - started).toBeLessThan(2000)
  })
})
