import { getEnv } from '@/lib/env'
import fixtures from './stub-fixtures.json'

// Checking a supplier against the Revenue Department's VAT service and DBD's juristic-person data (spec §7.15,
// BR-SUP-01 to BR-SUP-05, ADR-025). Two modes: `stub` answers from fixtures for the synthetic tax ids of the seed and
// is the only mode used locally, in tests and in the demo (BR-SUP-05, FR-SUP-001 AC3); `live` calls the real services
// once they are confirmed reachable from the hosting (OQ-37, S4-16) and is not built for the demo.

export interface RegistryRecord {
  readonly nameTh: string
  readonly address: string | null
  readonly branchCode: string
  /** RD: registered for VAT */
  readonly vatRegistered?: boolean
  /** DBD: the juristic person's status, as the registry writes it (e.g. ยังดำเนินกิจการอยู่) */
  readonly juristicStatus?: string
}

/** One registry's answer: found, not found, or the service did not answer (BR-SUP-03 then lets a person confirm) */
export type RegistryAnswer = { readonly status: 'FOUND'; readonly record: RegistryRecord } | { readonly status: 'NOT_FOUND' } | { readonly status: 'UNAVAILABLE' } | { readonly status: 'SKIPPED' }

export interface RegistryLookup {
  readonly taxId: string
  readonly branchCode: string
}

export interface RegistryProvider {
  readonly mode: 'stub' | 'live'
  lookup(query: RegistryLookup): Promise<{ readonly rd: RegistryAnswer; readonly dbd: RegistryAnswer }>
}

/** BR-SUP-02: a Thai tax id starting with 0 is a juristic person; an individual's is not in DBD */
export const isJuristicTaxId = (taxId: string) => taxId.startsWith('0')

interface StubEntry {
  readonly rd: RegistryRecord | 'UNAVAILABLE' | null
  readonly dbd: RegistryRecord | 'UNAVAILABLE' | null
}

/** Fixtures of the stub (stub-fixtures.json): the synthetic suppliers of the seed and cases for tests and the demo */
const STUB = fixtures as unknown as Readonly<Record<string, StubEntry>>

const answer = (entry: RegistryRecord | 'UNAVAILABLE' | null | undefined): RegistryAnswer =>
  entry === 'UNAVAILABLE' ? { status: 'UNAVAILABLE' } : entry ? { status: 'FOUND', record: entry } : { status: 'NOT_FOUND' }

export const stubRegistry: RegistryProvider = {
  mode: 'stub',
  async lookup({ taxId }) {
    const entry = STUB[taxId]
    return { rd: answer(entry?.rd), dbd: isJuristicTaxId(taxId) ? answer(entry?.dbd) : { status: 'SKIPPED' } }
  },
}

let provider: RegistryProvider | null = null

export function getRegistryProvider(): RegistryProvider {
  if (provider) return provider
  // S4-16 builds the live adapters with contract tests once OQ-37 is answered; until then live is refused loudly
  if (getEnv().REGISTRY_MODE === 'live') throw new Error('REGISTRY_MODE=live is not built yet (S4-16, OQ-37)')
  provider = stubRegistry
  return provider
}

/** Tests replace the provider (e.g. one that fails); null restores the mode of the environment */
export function setRegistryProvider(next: RegistryProvider | null): void {
  provider = next
}
