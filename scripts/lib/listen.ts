import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// A test server on a port the OS picks (port 0) may get one that fetch refuses to call ("bad port" of the WHATWG Fetch
// standard, which Node's fetch follows): Windows hands out ports from 1024 up, and 5060 or 6000 then fail a test now and
// then. listen() asks again until the port is one fetch calls.

/** The ports fetch refuses, from 1024 up (fetch.spec.whatwg.org "bad port"); the OS never hands out lower ones */
const FETCH_BAD_PORTS: ReadonlySet<number> = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080])
const TRIES = 20

function listenOnce(server: Server, port: number, host: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve(server.address() as AddressInfo)
    })
  })
}

const closeServer = (server: Server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))

/** Listens on `port`; for port 0, on a port the OS picks that fetch may call */
export async function listen(server: Server, port: number, host = '127.0.0.1'): Promise<AddressInfo> {
  if (port !== 0) return listenOnce(server, port, host)
  for (let i = 0; i < TRIES; i++) {
    const address = await listenOnce(server, 0, host)
    if (!FETCH_BAD_PORTS.has(address.port)) return address
    await closeServer(server)
  }
  throw new Error(`no port fetch may call after ${TRIES} tries`)
}
