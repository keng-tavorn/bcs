import { describe, expect, it } from 'vitest'
import { resetRefusal } from '../../scripts/db-reset'

// FR-PLT-007 AC2: `pnpm db:reset` drops the database schema, so it runs only with APP_ENV=local and only against a
// database on this machine.

// Next.js declares NODE_ENV on ProcessEnv; the guard reads only the variables given below
const env = (vars: Record<string, string | undefined>) => vars as NodeJS.ProcessEnv

const local = {
  APP_ENV: 'local',
  DATABASE_URL: 'postgresql://bcs_app:bcs_app@localhost:5432/bcs',
  DIRECT_URL: 'postgresql://bcs_migrator:bcs_migrator@localhost:5432/bcs',
}

const REMOTE = 'ep-calm-sun-a1b2c3.ap-southeast-1.aws.neon.tech'

describe('[FR-PLT-007/AC2] pnpm db:reset outside APP_ENV=local is refused', () => {
  it('allows the local database', () => {
    expect(resetRefusal(env(local))).toBeNull()
  })

  it.each(['staging', 'production', 'preview', undefined])('refuses APP_ENV=%s', (appEnv) => {
    expect(resetRefusal(env({ ...local, APP_ENV: appEnv }))).toMatch(/APP_ENV=local/)
  })

  it('refuses a local APP_ENV that points at a remote database', () => {
    const remote = 'postgresql://owner:pw@ep-cool-name-123456.ap-southeast-1.aws.neon.tech/neondb'
    expect(resetRefusal(env({ ...local, DIRECT_URL: remote }))).not.toBeNull()
    expect(resetRefusal(env({ ...local, DATABASE_URL: remote }))).not.toBeNull()
  })

  it('refuses a local-looking URL that connects elsewhere through ?host=', () => {
    const hidden = 'postgresql://owner:pw@localhost:5432/bcs?host=db.example.com'
    expect(resetRefusal(env({ ...local, DIRECT_URL: hidden }))).not.toBeNull()
  })

  it('refuses the ?host= URLs pg sends to a remote database although the user part names this machine', () => {
    // pg connects to ?host= whatever the authority says (scratch/verify-env-refute/r2-dbreset.probe.ts): the schema
    // would be dropped on Neon.
    const hidden = [
      `postgresql://bcs_migrator:pw@localhost:5432/bcs?host=${REMOTE}`,
      `postgresql://bcs_migrator:pw@localhost:5432/neondb?sslmode=require&host=${REMOTE}`,
      `postgresql://bcs_migrator:pw@127.0.0.1/bcs?host=${REMOTE}&port=5432`,
    ]
    for (const url of hidden) {
      expect(resetRefusal(env({ ...local, DIRECT_URL: url })), `DIRECT_URL ${url}`).not.toBeNull()
      expect(resetRefusal(env({ ...local, DATABASE_URL: url.replace('bcs_migrator', 'bcs_app') })), `DATABASE_URL ${url}`).not.toBeNull()
    }
  })

  it('refuses a URL without a host when PGHOST sends pg to another machine', () => {
    // With no host in the URL pg connects to PGHOST and only falls back to localhost when it is unset.
    const noHost = ['postgresql://bcs_migrator:pw@/bcs', 'postgresql:///bcs', 'postgresql://bcs_migrator:pw@/bcs?host=']
    for (const url of noHost) {
      for (const PGHOST of [REMOTE, '10.0.0.5', `localhost,${REMOTE}`, ` ${REMOTE} `]) {
        expect(resetRefusal(env({ ...local, DIRECT_URL: url, PGHOST })), `DIRECT_URL ${url} PGHOST=${PGHOST}`).not.toBeNull()
        expect(resetRefusal(env({ ...local, DATABASE_URL: url, PGHOST })), `DATABASE_URL ${url} PGHOST=${PGHOST}`).not.toBeNull()
      }
      // PGHOST on this machine, a Unix socket, or no PGHOST at all: pg stays here.
      for (const PGHOST of [undefined, '', 'localhost', '127.0.0.1', '/var/run/postgresql', 'localhost,::1']) {
        expect(resetRefusal(env({ ...local, DIRECT_URL: url, DATABASE_URL: url, PGHOST })), `${url} PGHOST=${PGHOST}`).toBeNull()
      }
    }
    // A host in the URL wins over PGHOST, so a remote PGHOST does not matter then.
    expect(resetRefusal(env({ ...local, PGHOST: REMOTE }))).toBeNull()
  })

  it('refuses PGHOSTADDR on another machine, whatever host the URLs name', () => {
    // libpq connects to PGHOSTADDR instead of resolving the host it was given.
    for (const PGHOSTADDR of ['10.0.0.5', '203.0.113.7', '127.0.0.1,10.0.0.5', '2001:db8::1']) {
      expect(resetRefusal(env({ ...local, PGHOSTADDR })), `PGHOSTADDR=${PGHOSTADDR}`).not.toBeNull()
    }
    for (const PGHOSTADDR of [undefined, '', '127.0.0.1', '::1']) {
      expect(resetRefusal(env({ ...local, PGHOSTADDR })), `PGHOSTADDR=${PGHOSTADDR}`).toBeNull()
    }
  })

  it('accepts the loopback aliases and address forms of this machine', () => {
    for (const host of ['127.0.0.1', '127.1', '[::1]', '[::]', 'localhost6', 'localhost4.localdomain4', 'LOCALHOST.', '%2Fvar%2Frun%2Fpostgresql']) {
      const url = `postgresql://bcs_migrator:pw@${host}/bcs`
      expect(resetRefusal(env({ ...local, DIRECT_URL: url })), url).toBeNull()
    }
  })

  it('never repeats a host or a password in the refusal', () => {
    const refusals = [
      resetRefusal(env({ ...local, DIRECT_URL: `postgresql://bcs_migrator:hidden-pw@${REMOTE}/bcs` })),
      resetRefusal(env({ ...local, DIRECT_URL: 'postgresql://bcs_migrator:hidden-pw@/bcs', PGHOST: REMOTE })),
      resetRefusal(env({ ...local, PGHOSTADDR: '203.0.113.7' })),
    ]
    for (const refusal of refusals) {
      expect(refusal).not.toBeNull()
      expect(refusal).not.toMatch(/hidden-pw|neon\.tech|203\.0\.113/)
    }
  })
})
